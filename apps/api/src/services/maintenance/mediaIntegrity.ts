// Media integrity sweep — decode-verifies every library file against its
// metadata. Operator-triggered from the Maintenance page (no timer: once the
// ingest gate checks new uploads, the sweep is a cleanup for pre-gate rows
// plus an on-demand "re-verify everything" action).
//
// Per file, in severity order:
//   missing        — media row exists, file gone from the pool
//   hash_mismatch  — bytes don't match the content-addressed name (bit rot,
//                    manual swap)
//   decode_errors  — corrupt frames mid-file (audible glitches)
//   truncated      — header claimed more audio than decodes; the classic
//                    interrupted-download case. duration_seconds is
//                    auto-corrected to the decoded truth so the planner stops
//                    budgeting with the lie (each airing otherwise injects
//                    real early-arrival drift).
//   duration_over  — header claimed LESS than decodes (rare VBR estimate
//                    case); also corrected, would otherwise inject lateness.
//
// Truncated/duration_over flags are STICKY: after the duration is corrected,
// a re-sweep measures the file as internally consistent, but the content
// still cuts off mid-song — the operator badge must survive until the file
// is replaced (which, in a content-addressed pool, means a new media row).
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { and, count, eq, isNotNull, ne } from 'drizzle-orm';
import type {
  MediaIntegrityFinding,
  MediaIntegrityState,
  MediaIntegritySweepResult,
} from '@soono/shared';
import { db } from '../../db/index.js';
import { media } from '../../db/schema.js';
import { decodeVerify, durationMismatchTolerance } from '../ingest/decodeVerify.js';
import { sha256File } from '../ingest/hash.js';
import { mediaPathForSha } from '../ingest/paths.js';
import type { SLogger } from '../supervisor2/supervisorLogger.js';

const RESULT_PATH =
  process.env.MEDIA_INTEGRITY_RESULT ||
  join(process.cwd(), '..', '..', 'data', 'media-integrity.json');

const FINDINGS_CAP = 100;

let currentRun: MediaIntegritySweepResult | null = null;

function readLastResult(): MediaIntegritySweepResult | null {
  try {
    if (existsSync(RESULT_PATH)) {
      return JSON.parse(readFileSync(RESULT_PATH, 'utf-8')) as MediaIntegritySweepResult;
    }
  } catch {
    // corrupt result file must never block anything
  }
  return null;
}

function writeLastResult(result: MediaIntegritySweepResult): void {
  writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2) + '\n');
}

export async function getMediaIntegrityState(): Promise<MediaIntegrityState> {
  const [flagged] = await db
    .select({ n: count() })
    .from(media)
    .where(and(isNotNull(media.integrity_status), ne(media.integrity_status, 'ok')));
  return {
    running: currentRun !== null,
    current: currentRun,
    last: readLastResult(),
    flagged_in_library: flagged.n,
  };
}

export function isSweepRunning(): boolean {
  return currentRun !== null;
}

// Kicks off the sweep in the background. Caller must have checked
// isSweepRunning() — a second concurrent run is refused here too.
export function startMediaIntegritySweep(logger: SLogger | null): boolean {
  if (currentRun !== null) return false;
  currentRun = {
    at_ms: Date.now(),
    finished_at_ms: null,
    total: 0,
    checked: 0,
    flagged: 0,
    duration_corrected: 0,
    findings: [],
    error: null,
  };
  void runSweep(logger)
    .catch((err) => {
      if (currentRun) {
        currentRun.error = err instanceof Error ? err.message : String(err);
      }
      logger?.error(
        { event: 'MEDIA_INTEGRITY_SWEEP_FAILED', err: String(err) },
        'maintenance: media integrity sweep failed',
      );
    })
    .finally(() => {
      if (currentRun) {
        currentRun.finished_at_ms = Date.now();
        writeLastResult(currentRun);
      }
      currentRun = null;
    });
  return true;
}

async function runSweep(logger: SLogger | null): Promise<void> {
  const run = currentRun;
  if (!run) return;

  const rows = await db
    .select({
      id: media.id,
      sha256: media.sha256,
      duration_seconds: media.duration_seconds,
      cue_out_seconds: media.cue_out_seconds,
      integrity_status: media.integrity_status,
      integrity_detail: media.integrity_detail,
      title: media.title,
      original_filename: media.original_filename,
      category: media.category,
    })
    .from(media)
    .orderBy(media.id);
  run.total = rows.length;

  logger?.info(
    { event: 'MEDIA_INTEGRITY_SWEEP_STARTED', total: rows.length },
    'maintenance: media integrity sweep started',
  );

  for (const row of rows) {
    const verdict = await checkOneFile(row);

    await db
      .update(media)
      .set({
        integrity_status: verdict.status,
        integrity_detail: verdict.detail,
        integrity_checked_at: new Date(),
        ...(verdict.corrected_duration != null
          ? { duration_seconds: verdict.corrected_duration }
          : {}),
        updated_at: new Date(),
      })
      .where(eq(media.id, row.id));

    run.checked += 1;
    if (verdict.status !== 'ok') {
      run.flagged += 1;
      if (verdict.corrected_duration != null) run.duration_corrected += 1;
      const finding: MediaIntegrityFinding = {
        media_id: row.id,
        display_name: row.title ?? row.original_filename,
        category: row.category,
        status: verdict.status,
        detail: verdict.detail ?? '',
        duration_corrected: verdict.corrected_duration != null,
      };
      if (run.findings.length < FINDINGS_CAP) run.findings.push(finding);
      logger?.warn(
        { event: 'MEDIA_INTEGRITY_FLAGGED', ...finding },
        `maintenance: media ${row.id} (${finding.display_name}) flagged ${verdict.status}`,
      );
    }
  }

  logger?.info(
    {
      event: 'MEDIA_INTEGRITY_SWEEP_DONE',
      total: run.total,
      flagged: run.flagged,
      duration_corrected: run.duration_corrected,
    },
    run.flagged > 0
      ? `maintenance: media integrity sweep flagged ${run.flagged} of ${run.total} files`
      : `maintenance: media integrity sweep — all ${run.total} files clean`,
  );
}

interface FileVerdict {
  status: 'ok' | 'truncated' | 'duration_over' | 'decode_errors' | 'missing' | 'hash_mismatch';
  detail: string | null;
  corrected_duration: number | null;
}

async function checkOneFile(row: {
  sha256: string;
  duration_seconds: number;
  cue_out_seconds: number | null;
  integrity_status: string | null;
  integrity_detail: string | null;
}): Promise<FileVerdict> {
  const path = mediaPathForSha(row.sha256);

  if (!existsSync(path)) {
    return { status: 'missing', detail: `file not found: ${path}`, corrected_duration: null };
  }

  const actualSha = await sha256File(path);
  const hashOk = actualSha === row.sha256;

  const verify = await decodeVerify(path);
  const claimed = row.duration_seconds;
  const decoded = verify.decoded_duration_seconds;
  const tolerance = durationMismatchTolerance(claimed);
  const durationLies = decoded > 0 && Math.abs(decoded - claimed) > tolerance;

  const detailParts: string[] = [];
  let status: FileVerdict['status'] = 'ok';
  let correctedDuration: number | null = null;

  if (durationLies) {
    status = decoded < claimed ? 'truncated' : 'duration_over';
    correctedDuration = decoded;
    detailParts.push(
      `metadata said ${claimed.toFixed(1)}s, decoded ${decoded.toFixed(1)}s — duration corrected`,
    );
    if (row.cue_out_seconds != null && row.cue_out_seconds > decoded + 0.5) {
      detailParts.push(
        `cue_out ${row.cue_out_seconds.toFixed(1)}s lies beyond the decoded end — review cue points`,
      );
    }
  } else if (
    row.integrity_status === 'truncated' ||
    row.integrity_status === 'duration_over'
  ) {
    // Sticky: duration was already corrected on a previous pass, so the file
    // now measures consistent — but the content is still cut short. Keep the
    // flag (and its story) until the operator replaces the file. Worse
    // verdicts below (decode errors, hash mismatch) still take precedence.
    status = row.integrity_status;
    if (row.integrity_detail) detailParts.push(row.integrity_detail);
  }

  if (verify.failed || verify.decode_error_count > 0) {
    status = 'decode_errors';
    detailParts.unshift(
      `${verify.decode_error_count} decode error(s)${verify.failed ? ', decoder exited abnormally' : ''}` +
        (verify.error_sample.length > 0 ? `: ${verify.error_sample.join(' | ')}` : ''),
    );
  }

  if (!hashOk) {
    status = 'hash_mismatch';
    detailParts.unshift(`file content hashes to ${actualSha.slice(0, 12)}…, expected ${row.sha256.slice(0, 12)}…`);
  }

  return {
    status,
    detail: detailParts.length > 0 ? detailParts.join('; ') : null,
    corrected_duration: correctedDuration,
  };
}
