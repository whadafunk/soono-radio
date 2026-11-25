import type { FastifyInstance, FastifyReply } from 'fastify';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { eq } from 'drizzle-orm';
import {
  RecordingHoldCreateSchema,
  RecordingPurgeSchema,
  RecordingSettingsSchema,
  type BroadcastRecordingStatus,
  type RecordingDayItem,
  type RecordingDayResponse,
  type RecordingDeleteResult,
  type RecordingHold,
  type RecordingRangePreview,
} from '@soono/shared';
import { db } from '../db/index.js';
import { recordingHolds, stationSettings, supervisorState } from '../db/schema.js';
import { readLiquidsoapConfig } from '../services/liquidsoapConfig.js';
import { fetchLiquidsoapStatus } from '../services/liquidsoapStatus.js';
import { addLocalDaysMs, parseLocalYmd } from '../services/supervisor2/localDay.js';
import { offAirPeriods } from '../services/recordings/airEvents.js';
import { recordingHealth } from '../services/recordings/health.js';
import {
  buildRecordingFiles,
  describeWindow,
  isSafeRecordingRef,
  parseRecordingFileName,
  utcFoldersForWindow,
  type RecordingFile,
} from '../services/recordings/recordingIndex.js';
import { exportRange } from '../services/recordings/rangeExport.js';
import { planRange } from '../services/recordings/rangePlan.js';
import { loadRecordingConfig, writeRecordingSettings } from '../services/recordings/recordingSettings.js';
import { deleteFile, diskUsage, filePath, listAllRawFiles, listRawFiles } from '../services/recordings/recordingStore.js';
import { isHeld, type HoldRange } from '../services/recordings/sweepPlan.js';

// Reports → Recordings (docs/reports-recordings-design.md).
//
// The folder on disk is the source of truth. Every date the operator sends
// or sees is a STATION date (the process runs in the station timezone); file
// names and folders are UTC. Nothing from a request reaches the disk without
// passing isSafeRecordingRef or a strict date check first.

const YMD = /^\d{4}-\d{2}-\d{2}$/;

// Station-local "YYYY-MM-DD_HH-MM" for download names.
function stationStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

// The [start, end) of a station day, or null for something that is not a date.
function stationDayWindow(date: string): { startMs: number; endMs: number } | null {
  if (!YMD.test(date)) return null;
  const start = parseLocalYmd(date);
  if (Number.isNaN(start.getTime())) return null;
  return { startMs: start.getTime(), endMs: addLocalDaysMs(start.getTime(), 1) };
}

async function loadHolds(): Promise<RecordingHold[]> {
  return db.select().from(recordingHolds);
}

const toRanges = (holds: RecordingHold[]): HoldRange[] => holds.map((h) => ({ fromMs: h.from_ms, toMs: h.to_ms }));

async function filesInWindow(fromMs: number, toMs: number, nowMs: number): Promise<RecordingFile[]> {
  // Built from every listed folder so "the next file's start" is known even
  // when the next file lies just outside the window.
  return buildRecordingFiles(await listRawFiles(utcFoldersForWindow(fromMs, toMs)), nowMs);
}

// Deletes what may be deleted: never a held recording, never the file being
// written. Reports both skips so a purge never looks more complete than it was.
async function deleteAllowed(files: RecordingFile[], holds: HoldRange[]): Promise<RecordingDeleteResult> {
  const result: RecordingDeleteResult = { deleted: 0, skipped_held: 0, skipped_active: 0 };
  for (const f of files) {
    if (f.recordingNow) { result.skipped_active++; continue; }
    if (isHeld(f, holds)) { result.skipped_held++; continue; }
    await deleteFile(f.day, f.name);
    result.deleted++;
  }
  return result;
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
  // One station day: its recordings and the gaps between them.
  fastify.get<{ Querystring: { date?: string } }>('/recordings', async (request, reply) => {
    const window = stationDayWindow(request.query.date ?? '');
    if (!window) return reply.status(400).send({ error: 'date must look like 2026-11-24' });

    const nowMs = Date.now();
    const [settings] = await db.select({ timezone: stationSettings.timezone }).from(stationSettings).where(eq(stationSettings.id, 1));
    const holds = await loadHolds();
    const response: RecordingDayResponse = {
      date: request.query.date!,
      timezone: settings?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      items: [],
      holds,
    };
    // A day that has not started yet has nothing to show — not even a gap.
    if (window.startMs >= nowMs) return reply.send(response);

    const windowEndMs = Math.min(window.endMs, nowMs);
    const files = await filesInWindow(window.startMs, windowEndMs, nowMs);
    const offAir = await offAirPeriods(window.startMs, windowEndMs);
    const ranges = toRanges(holds);
    response.items = describeWindow(files, offAir, window.startMs, windowEndMs).map((item): RecordingDayItem =>
      item.kind === 'gap'
        ? { kind: 'gap', start_ms: item.startMs, end_ms: item.endMs, label: item.label }
        : {
            kind: 'file', day: item.day, name: item.name,
            start_ms: item.startMs, end_ms: item.endMs, size_bytes: item.sizeBytes,
            recording_now: item.recordingNow, held: isHeld(item, ranges),
          });
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
        const downloadName = request.query.download ? `recording_${stationStamp(startMs)}.mp3` : null;
        return await streamFile(reply, path, request.headers.range, downloadName);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reply.status(404).send({ error: 'Recording not found' });
        throw err;
      }
    },
  );

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

  fastify.delete<{ Params: { day: string; name: string } }>('/recordings/file/:day/:name', async (request, reply) => {
    const { day, name } = request.params;
    if (!isSafeRecordingRef(day, name)) return reply.status(400).send({ error: 'Not a recording' });
    const nowMs = Date.now();
    // Listed (not just stat'ed) so "being written" and "held" are judged the
    // same way as everywhere else.
    const file = buildRecordingFiles(await listRawFiles([day]), nowMs).find((f) => f.name === name);
    if (!file) return reply.status(404).send({ error: 'Recording not found' });
    const result = await deleteAllowed([file], toRanges(await loadHolds()));
    fastify.log.info({ event: 'RECORDING_DELETE', day, name, ...result }, 'recordings: delete requested');
    return reply.send(result);
  });

  // Every recording that STARTED on that station day.
  fastify.delete<{ Params: { date: string } }>('/recordings/day/:date', async (request, reply) => {
    const window = stationDayWindow(request.params.date);
    if (!window) return reply.status(400).send({ error: 'date must look like 2026-11-24' });
    const nowMs = Date.now();
    const files = (await filesInWindow(window.startMs, window.endMs, nowMs))
      .filter((f) => f.startMs >= window.startMs && f.startMs < window.endMs);
    const result = await deleteAllowed(files, toRanges(await loadHolds()));
    fastify.log.warn({ event: 'RECORDING_PURGE_DAY', date: request.params.date, ...result }, 'recordings: day purged by operator');
    return reply.send(result);
  });

  // Everything that ended before the start of that station day.
  fastify.post('/recordings/purge', async (request, reply) => {
    const parsed = RecordingPurgeSchema.safeParse(request.body);
    const window = parsed.success ? stationDayWindow(parsed.data.before) : null;
    if (!window) return reply.status(400).send({ error: 'before must look like 2026-11-24' });
    const nowMs = Date.now();
    const files = buildRecordingFiles(await listAllRawFiles(), nowMs).filter((f) => f.endMs <= window.startMs);
    const result = await deleteAllowed(files, toRanges(await loadHolds()));
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

  fastify.get('/recordings/holds', async (_request, reply) => reply.send(await loadHolds()));

  fastify.post('/recordings/holds', async (request, reply) => {
    const parsed = RecordingHoldCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid hold' });
    }
    const [hold] = await db.insert(recordingHolds).values({ ...parsed.data, created_at_ms: Date.now() }).returning();
    fastify.log.info({ event: 'RECORDING_HOLD_CREATED', ...hold }, 'recordings: hold created');
    return reply.send(hold);
  });

  fastify.delete<{ Params: { id: string } }>('/recordings/holds/:id', async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.status(400).send({ error: 'invalid hold id' });
    const removed = await db.delete(recordingHolds).where(eq(recordingHolds.id, id)).returning();
    if (removed.length === 0) return reply.status(404).send({ error: 'Hold not found' });
    fastify.log.warn({ event: 'RECORDING_HOLD_REMOVED', ...removed[0] }, 'recordings: hold removed');
    return reply.send({ ok: true });
  });
}
