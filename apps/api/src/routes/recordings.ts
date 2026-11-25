import type { FastifyInstance, FastifyReply } from 'fastify';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { eq } from 'drizzle-orm';
import {
  MAX_RECORDING_PERIOD_DAYS,
  RecordingFlagChangeSchema,
  RecordingPurgeSchema,
  RecordingSelectionSchema,
  RecordingSettingsSchema,
  type BroadcastRecordingStatus,
  type RecordingArchivePreview,
  type RecordingDeleteResult,
  type RecordingFlagEntry,
  type RecordingListItem,
  type RecordingPeriodDay,
  type RecordingPeriodResponse,
  type RecordingRangePreview,
  type RecordingRef,
} from '@soono/shared';
import { db } from '../db/index.js';
import { stationSettings, supervisorState } from '../db/schema.js';
import { readLiquidsoapConfig } from '../services/liquidsoapConfig.js';
import { fetchLiquidsoapStatus } from '../services/liquidsoapStatus.js';
import { addLocalDaysMs, daysInclusive, isoDateString, parseLocalYmd } from '../services/supervisor2/localDay.js';
import { offAirPeriods } from '../services/recordings/airEvents.js';
import { buildListingCsv } from '../services/recordings/archiveListing.js';
import { archiveEntryPaths, archiveFileName, stationFileName } from '../services/recordings/archiveNames.js';
import { createArchive } from '../services/recordings/archiveStream.js';
import { recordingHealth } from '../services/recordings/health.js';
import { dayItems, summariseDay } from '../services/recordings/periodList.js';
import { clearFlag, loadFlags, protectedNames, removeFlagsFor, setFlag } from '../services/recordings/recordingFlags.js';
import {
  buildRecordingFiles,
  isSafeRecordingRef,
  parseRecordingFileName,
  utcFoldersForWindow,
  type RecordingFile,
  type RecordingItem,
} from '../services/recordings/recordingIndex.js';
import { exportRange } from '../services/recordings/rangeExport.js';
import { planRange } from '../services/recordings/rangePlan.js';
import { loadRecordingConfig, writeRecordingSettings } from '../services/recordings/recordingSettings.js';
import { deleteFile, diskUsage, filePath, listAllRawFiles, listRawFiles } from '../services/recordings/recordingStore.js';

// Reports → Recordings (docs/reports-recordings-design.md, and
// docs/reports-recordings-list-design.md for the list, archive and flags).
//
// The folder on disk is the source of truth. Every date the operator sends
// or sees is a STATION date (the process runs in the station timezone); file
// names and folders are UTC. Nothing from a request reaches the disk without
// passing isSafeRecordingRef or a strict date check first.

const YMD = /^\d{4}-\d{2}-\d{2}$/;

// Station-local "YYYY-MM-DD_HH-MM" for the name of a cut range.
function stationStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

// Local midnight of a station date, or null for something that is not one.
function stationDayStartMs(date: string): number | null {
  if (!YMD.test(date)) return null;
  const start = parseLocalYmd(date);
  // "2026-02-31" parses, but as a different day.
  if (Number.isNaN(start.getTime()) || isoDateString(start) !== date) return null;
  return start.getTime();
}

async function filesInWindow(fromMs: number, toMs: number, nowMs: number): Promise<RecordingFile[]> {
  // Built from every listed folder so "the next file's start" is known even
  // when the next file lies just outside the window.
  return buildRecordingFiles(await listRawFiles(utcFoldersForWindow(fromMs, toMs)), nowMs);
}

// The recordings a request names, as they are on disk right now. null when
// any entry is not a recording inside its own day folder — the whole request
// is then refused, never partly carried out.
async function resolveSelection(
  refs: RecordingRef[],
  nowMs: number,
): Promise<{ found: RecordingFile[]; missing: number } | null> {
  const wanted = new Map<string, string>(); // name → day
  for (const ref of refs) {
    if (!isSafeRecordingRef(ref.day, ref.name)) return null;
    wanted.set(ref.name, ref.day);
  }
  const days = [...new Set(wanted.values())].sort();
  const found = buildRecordingFiles(await listRawFiles(days), nowMs).filter((f) => wanted.has(f.name));
  return { found, missing: wanted.size - found.length };
}

// Deletes what may be deleted: never a protected recording, never the file
// being written. Reports both skips so a delete never looks more complete
// than it was. A deleted recording takes its flags with it.
async function deleteAllowed(files: RecordingFile[]): Promise<RecordingDeleteResult> {
  const protectedSet = await protectedNames();
  const result: RecordingDeleteResult = { deleted: 0, skipped_protected: 0, skipped_active: 0 };
  const deleted: string[] = [];
  for (const f of files) {
    if (f.recordingNow) { result.skipped_active++; continue; }
    if (protectedSet.has(f.name)) { result.skipped_protected++; continue; }
    await deleteFile(f.day, f.name);
    deleted.push(f.name);
    result.deleted++;
  }
  await removeFlagsFor(deleted);
  return result;
}

function toListItem(item: RecordingItem, flags: Map<string, RecordingFlagEntry[]>): RecordingListItem {
  return item.kind === 'gap'
    ? { kind: 'gap', start_ms: item.startMs, end_ms: item.endMs, label: item.label }
    : {
        kind: 'file', day: item.day, name: item.name,
        start_ms: item.startMs, end_ms: item.endMs, size_bytes: item.sizeBytes,
        recording_now: item.recordingNow, flags: flags.get(item.name) ?? [],
      };
}

function parseMs(value: unknown): number | null {
  const n = typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}

const RANGE_ERRORS: Record<'invalid_range' | 'too_long' | 'nothing_recorded', { status: number; message: string }> = {
  invalid_range: { status: 400, message: 'The end of the range must be after its start.' },
  too_long: { status: 400, message: 'A range can be at most 24 hours. Download a longer period as several ranges.' },
  nothing_recorded: { status: 404, message: 'Nothing was recorded in that range.' },
};

const NOT_A_RECORDING = 'The selection contains something that is not a recording.';

async function streamFile(
  reply: FastifyReply,
  path: string,
  rangeHeader: string | undefined,
  downloadName: string | null,
  onDone?: () => void,
): Promise<FastifyReply> {
  const { size } = await stat(path);
  reply.header('Content-Type', 'audio/mpeg').header('Accept-Ranges', 'bytes');
  if (downloadName) reply.header('Content-Disposition', `attachment; filename="${downloadName}"`);
  // A file opened a moment ago can still be empty; there is no byte range to
  // read from it (createReadStream would throw on end: -1).
  if (size === 0) {
    onDone?.();
    return reply.header('Content-Length', 0).send('');
  }

  let start = 0;
  let end = size - 1;
  const m = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
  if (m && (m[1] !== '' || m[2] !== '')) {
    if (m[1] === '') {
      start = Math.max(0, size - Number(m[2])); // suffix range: last N bytes
    } else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(end, Number(m[2]));
    }
    if (start > end || start >= size) {
      onDone?.();
      return reply.status(416).header('Content-Range', `bytes */${size}`).send();
    }
    reply.status(206).header('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  reply.header('Content-Length', end - start + 1);

  const stream = createReadStream(path, { start, end });
  if (onDone) stream.once('close', onDone);
  return reply.send(stream);
}

export async function recordingsRoutes(fastify: FastifyInstance) {
  // A period of station days, newest first: each day's recordings, the gaps
  // between them, and the day's totals.
  fastify.get<{ Querystring: { from?: string; to?: string } }>('/recordings', async (request, reply) => {
    const from = request.query.from ?? '';
    const to = request.query.to ?? '';
    const fromStartMs = stationDayStartMs(from);
    const toStartMs = stationDayStartMs(to);
    if (fromStartMs == null || toStartMs == null) return reply.status(400).send({ error: 'from and to must look like 2026-11-24' });
    if (toStartMs < fromStartMs) return reply.status(400).send({ error: 'The end of the period is before its start.' });
    if (daysInclusive(from, to) > MAX_RECORDING_PERIOD_DAYS) {
      return reply.status(400).send({ error: `A period can be at most ${MAX_RECORDING_PERIOD_DAYS} days.` });
    }

    const nowMs = Date.now();
    const [settings] = await db.select({ timezone: stationSettings.timezone }).from(stationSettings).where(eq(stationSettings.id, 1));
    const response: RecordingPeriodResponse = {
      from, to,
      timezone: settings?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      days: [],
    };
    // A period that has not started yet has nothing to show — not even a gap.
    if (fromStartMs >= nowMs) return reply.send(response);

    const periodEndMs = Math.min(addLocalDaysMs(toStartMs, 1), nowMs);
    const [files, offAir, flags] = await Promise.all([
      filesInWindow(fromStartMs, periodEndMs, nowMs),
      offAirPeriods(fromStartMs, periodEndMs),
      loadFlags(),
    ]);
    // Stepped by calendar day: a station day is 23 or 25 hours twice a year.
    for (let dayStartMs = toStartMs; dayStartMs >= fromStartMs; dayStartMs = addLocalDaysMs(dayStartMs, -1)) {
      if (dayStartMs >= nowMs) continue; // a day that has not started
      const dayEndMs = Math.min(addLocalDaysMs(dayStartMs, 1), nowMs);
      const items = dayItems(files, offAir, dayStartMs, dayEndMs);
      const totals = summariseDay(items);
      const day: RecordingPeriodDay = {
        date: isoDateString(new Date(dayStartMs)),
        recorded_ms: totals.recordedMs,
        no_recording_ms: totals.noRecordingMs,
        size_bytes: totals.sizeBytes,
        items: items.map((item) => toListItem(item, flags)),
      };
      response.days.push(day);
    }
    return reply.send(response);
  });

  // One recording, with byte ranges so the in-page player can seek.
  fastify.get<{ Params: { day: string; name: string }; Querystring: { download?: string } }>(
    '/recordings/file/:day/:name',
    async (request, reply) => {
      const { day, name } = request.params;
      if (!isSafeRecordingRef(day, name)) return reply.status(400).send({ error: 'Not a recording' });
      const path = filePath(day, name);
      try {
        const startMs = parseRecordingFileName(name)!; // non-null: isSafeRecordingRef passed
        const downloadName = request.query.download ? stationFileName(startMs) : null;
        return await streamFile(reply, path, request.headers.range, downloadName);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reply.status(404).send({ error: 'Recording not found' });
        throw err;
      }
    },
  );

  // ── Archive of a selection ─────────────────────────────────────────────────

  // What the archive would hold. Never the recording in progress: it is still
  // growing, and its size in the archive would be a guess.
  async function planArchive(body: unknown, nowMs: number): Promise<
    | { error: { status: number; message: string } }
    | { files: RecordingFile[]; preview: RecordingArchivePreview }
  > {
    const parsed = RecordingSelectionSchema.safeParse(body);
    if (!parsed.success) return { error: { status: 400, message: parsed.error.issues[0]?.message ?? 'Invalid selection' } };
    const selection = await resolveSelection(parsed.data.files, nowMs);
    if (!selection) return { error: { status: 400, message: NOT_A_RECORDING } };
    const files = selection.found.filter((f) => !f.recordingNow).sort((a, b) => a.startMs - b.startMs);
    if (files.length === 0) {
      return { error: { status: 404, message: 'None of the selected recordings can be downloaded: they are no longer there or still being recorded.' } };
    }
    return {
      files,
      preview: {
        files: files.length,
        size_bytes: files.reduce((sum, f) => sum + f.sizeBytes, 0),
        skipped_active: selection.found.length - files.length,
        skipped_missing: selection.missing,
      },
    };
  }

  fastify.post('/recordings/archive/preview', async (request, reply) => {
    const plan = await planArchive(request.body, Date.now());
    if ('error' in plan) return reply.status(plan.error.status).send({ error: plan.error.message });
    return reply.send(plan.preview);
  });

  // The archive download is a plain HTML form post, so the browser handles it
  // as a download (a script cannot hold gigabytes). The form parser lives in
  // its own child plugin: every other route here stays JSON-only, so a form
  // on some other website cannot post to the routes that delete recordings
  // or change retention. This one only reads.
  await fastify.register(async (archiveScope) => {
    archiveScope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });

    // The selection as one zip of the original files, with a listing of what
    // is in it and what is missing.
    archiveScope.post('/recordings/archive', async (request, reply) => {
      let body: unknown = null;
      try {
        body = JSON.parse((request.body as { selection?: string } | null)?.selection ?? '');
      } catch {
        // falls through to the schema's refusal
      }
      const nowMs = Date.now();
      const plan = await planArchive(body, nowMs);
      if ('error' in plan) return reply.status(plan.error.status).send({ error: plan.error.message });

      const first = plan.files[0];
      const last = plan.files[plan.files.length - 1];
      const [around, offAir, flags] = await Promise.all([
        filesInWindow(first.startMs, last.endMs, nowMs),
        offAirPeriods(first.startMs, last.endMs),
        loadFlags(),
      ]);
      const entryPaths = archiveEntryPaths(plan.files);
      const job = createArchive(
        {
          entries: plan.files.map((f) => ({ name: f.name, path: filePath(f.day, f.name), entryPath: entryPaths.get(f.name)!, startMs: f.startMs })),
          buildListing: (included) => buildListingCsv({ files: around, included, offAir, flags, entryPaths }),
        },
        (err) => fastify.log.warn({ err, event: 'RECORDING_ARCHIVE_FILE_SKIPPED' }, 'recordings: a file could not be added to the archive'),
      );

      job.done.then(
        () => fastify.log.info({ event: 'RECORDING_ARCHIVE', ...plan.preview }, 'recordings: archive built'),
        (err) => fastify.log.error({ err, event: 'RECORDING_ARCHIVE_FAILED' }, 'recordings: archive failed'),
      );
      // The browser went away before the end: stop reading recordings nobody
      // will receive.
      reply.raw.once('close', () => {
        if (reply.raw.writableFinished) return;
        job.abort();
        fastify.log.info({ event: 'RECORDING_ARCHIVE_ABORTED', files: plan.preview.files }, 'recordings: archive download stopped by the browser');
      });

      return reply
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', `attachment; filename="${archiveFileName(first.startMs, last.startMs)}"`)
        .send(job.stream);
    });
  });

  // What a range download would contain — the page shows the gaps before the
  // operator downloads a file that might be handed to an authority.
  fastify.get<{ Querystring: { from?: string; to?: string } }>('/recordings/range/preview', async (request, reply) => {
    const fromMs = parseMs(request.query.from);
    const toMs = parseMs(request.query.to);
    if (fromMs == null || toMs == null) return reply.status(400).send({ error: 'from and to are required, in milliseconds' });
    const plan = planRange(await filesInWindow(fromMs, toMs, Date.now()), fromMs, toMs);
    if ('error' in plan) {
      const e = RANGE_ERRORS[plan.error];
      return reply.status(e.status).send({ error: e.message, code: plan.error });
    }
    const preview: RecordingRangePreview = {
      parts: plan.parts.length,
      covered_ms: plan.coveredMs,
      gaps: plan.gaps.map((g) => ({ start_ms: g.startMs, end_ms: g.endMs })),
    };
    return reply.send(preview);
  });

  // A time range as one MP3.
  fastify.get<{ Querystring: { from?: string; to?: string } }>('/recordings/range', async (request, reply) => {
    const fromMs = parseMs(request.query.from);
    const toMs = parseMs(request.query.to);
    if (fromMs == null || toMs == null) return reply.status(400).send({ error: 'from and to are required, in milliseconds' });
    const plan = planRange(await filesInWindow(fromMs, toMs, Date.now()), fromMs, toMs);
    if ('error' in plan) {
      const e = RANGE_ERRORS[plan.error];
      return reply.status(e.status).send({ error: e.message, code: plan.error });
    }
    let exported: Awaited<ReturnType<typeof exportRange>>;
    try {
      exported = await exportRange(plan.parts);
    } catch (err) {
      fastify.log.error({ err, event: 'RECORDING_RANGE_FAILED', from_ms: fromMs, to_ms: toMs }, 'recordings: range export failed');
      return reply.status(500).send({ error: `Could not build the range: ${(err as Error).message}` });
    }
    const name = `recording_${stationStamp(fromMs)}_${stationStamp(toMs)}.mp3`;
    return streamFile(reply, exported.outputPath, undefined, name, () => { void exported.cleanup(); });
  });

  // ── Flags ──────────────────────────────────────────────────────────────────

  // Sets or clears one flag on a selection. Only recordings that exist are
  // flagged, so a label never outlives (or precedes) its recording.
  fastify.post('/recordings/flags', async (request, reply) => {
    const parsed = RecordingFlagChangeSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    const selection = await resolveSelection(parsed.data.files, Date.now());
    if (!selection) return reply.status(400).send({ error: NOT_A_RECORDING });
    const names = selection.found.map((f) => f.name);
    const changed = parsed.data.set
      ? await setFlag(names, parsed.data.flag, parsed.data.note ?? '')
      : await clearFlag(names, parsed.data.flag);
    fastify.log.info({ event: 'RECORDING_FLAG', flag: parsed.data.flag, set: parsed.data.set, changed }, 'recordings: flag changed');
    return reply.send({ changed });
  });

  // ── Deleting ───────────────────────────────────────────────────────────────

  fastify.delete<{ Params: { day: string; name: string } }>('/recordings/file/:day/:name', async (request, reply) => {
    const { day, name } = request.params;
    if (!isSafeRecordingRef(day, name)) return reply.status(400).send({ error: 'Not a recording' });
    const selection = await resolveSelection([{ day, name }], Date.now());
    if (!selection || selection.found.length === 0) return reply.status(404).send({ error: 'Recording not found' });
    const result = await deleteAllowed(selection.found);
    fastify.log.info({ event: 'RECORDING_DELETE', day, name, ...result }, 'recordings: delete requested');
    return reply.send(result);
  });

  fastify.post('/recordings/delete', async (request, reply) => {
    const parsed = RecordingSelectionSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid selection' });
    const selection = await resolveSelection(parsed.data.files, Date.now());
    if (!selection) return reply.status(400).send({ error: NOT_A_RECORDING });
    const result = await deleteAllowed(selection.found);
    fastify.log.warn({ event: 'RECORDING_DELETE_SELECTION', requested: parsed.data.files.length, ...result }, 'recordings: selection deleted by operator');
    return reply.send(result);
  });

  // Everything that ended before the start of that station day.
  fastify.post('/recordings/purge', async (request, reply) => {
    const parsed = RecordingPurgeSchema.safeParse(request.body);
    const beforeMs = parsed.success ? stationDayStartMs(parsed.data.before) : null;
    if (beforeMs == null) return reply.status(400).send({ error: 'before must look like 2026-11-24' });
    const files = buildRecordingFiles(await listAllRawFiles(), Date.now()).filter((f) => f.endMs <= beforeMs);
    const result = await deleteAllowed(files);
    fastify.log.warn({ event: 'RECORDING_PURGE_BEFORE', before: parsed.data!.before, ...result }, 'recordings: purged by operator');
    return reply.send(result);
  });

  fastify.get('/recordings/status', async (_request, reply) => {
    const nowMs = Date.now();
    const [config, engine, state, disk, raw] = await Promise.all([
      readLiquidsoapConfig(),
      fetchLiquidsoapStatus(),
      db.select({ paused: supervisorState.paused }).from(supervisorState).where(eq(supervisorState.id, 1)),
      diskUsage(),
      listAllRawFiles(),
    ]);
    const files = buildRecordingFiles(raw, nowMs);
    const stored = loadRecordingConfig();
    const newest = files.length > 0 ? files[files.length - 1] : null;
    // The newest file's own last write, not its clamped end.
    const newestMtimeMs = newest ? Math.max(...raw.filter((r) => r.day === newest.day && r.name === newest.name).map((r) => r.mtimeMs)) : null;
    const health = recordingHealth({
      enabled: config.recording.enabled,
      onAir: !(state[0]?.paused ?? false),
      mixEngineRunning: engine.reachable,
      newestFileMtimeMs: newestMtimeMs,
      nowMs,
    });
    const status: BroadcastRecordingStatus = {
      enabled: config.recording.enabled,
      on_air: !(state[0]?.paused ?? false),
      mix_engine_running: engine.reachable,
      healthy: health.healthy,
      reason: health.reason,
      newest_file_age_s: newestMtimeMs == null ? null : Math.max(0, Math.round((nowMs - newestMtimeMs) / 1000)),
      used_bytes: files.reduce((sum, f) => sum + f.sizeBytes, 0),
      free_bytes: disk?.freeBytes ?? null,
      oldest_start_ms: files[0]?.startMs ?? null,
      last_sweep: stored.ok ? stored.lastSweep : null,
      settings_damaged: !stored.ok,
    };
    return reply.send(status);
  });

  // A damaged file shows the defaults in the form; saving them repairs it.
  // (The status route is what tells the operator the file was damaged.)
  fastify.get('/recordings/settings', async (_request, reply) => {
    const stored = loadRecordingConfig();
    return reply.send(stored.ok ? stored.settings : RecordingSettingsSchema.parse({}));
  });

  // Applies at the next sweep; no restart.
  fastify.post('/recordings/settings', async (request, reply) => {
    const parsed = RecordingSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid settings' });
    }
    writeRecordingSettings(parsed.data);
    fastify.log.info({ event: 'RECORDING_SETTINGS_UPDATED', ...parsed.data }, 'recordings: retention settings updated');
    return reply.send(parsed.data);
  });
}
