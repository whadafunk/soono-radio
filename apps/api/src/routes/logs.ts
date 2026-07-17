// Logs API — read-side for the Logs UI plus manual maintenance actions.
// Automatic size rotation lives in services/logging/rotatingLog.ts and runs
// regardless of this UI; these routes only surface state and manual actions.
import type { FastifyInstance } from 'fastify';
import { existsSync, statSync, truncateSync, unlinkSync } from 'fs';
import { open, stat } from 'fs/promises';
import { basename, join } from 'path';
import {
  LogMaintenanceRequestSchema,
  LogSettingsSchema,
  LogTailQuerySchema,
  type LogEntry,
  type LogSourceId,
  type LogSourceInfo,
  type LogTailQuery,
} from '@soono/shared';
import { applyLogSettingsToStreams, getRotatingLogStream } from '../services/logging/rotatingLog.js';
import { readLogSettings, writeLogSettings } from '../services/logging/logConfig.js';
import {
  API_LOG_FILE,
  ICECAST_LOG_DIR,
  LIQUIDSOAP_LOG_DIR,
  SUPERVISOR_LOG_FILE,
  newestLogIn,
} from '../services/logging/logPaths.js';

// How far back a tail request looks into the file. Filtered queries get a
// deeper window since most lines get discarded before the limit is reached.
const SCAN_BYTES_PLAIN = 2 * 1024 * 1024;
const SCAN_BYTES_FILTERED = 8 * 1024 * 1024;

interface SourceDef {
  id: LogSourceId;
  label: string;
  kind: 'structured' | 'text';
  // Resolved lazily — the LiquidSoap file name isn't fixed.
  resolveFile: () => string | null;
}

const SOURCE_DEFS: SourceDef[] = [
  { id: 'supervisor', label: 'Supervisor', kind: 'structured', resolveFile: () => SUPERVISOR_LOG_FILE },
  { id: 'api', label: 'API', kind: 'structured', resolveFile: () => API_LOG_FILE },
  { id: 'liquidsoap', label: 'LiquidSoap', kind: 'text', resolveFile: () => newestLogIn(LIQUIDSOAP_LOG_DIR) },
  { id: 'icecast-error', label: 'Icecast (error)', kind: 'text', resolveFile: () => join(ICECAST_LOG_DIR, 'error.log') },
  { id: 'icecast-access', label: 'Icecast (access)', kind: 'text', resolveFile: () => join(ICECAST_LOG_DIR, 'access.log') },
];

function sourceInfo(def: SourceDef): LogSourceInfo {
  const file = def.resolveFile();
  const available = file != null && existsSync(file);
  const st = available ? statSync(file) : null;
  const rotated: Array<{ name: string; size_bytes: number }> = [];
  if (file != null) {
    for (let i = 1; i <= 9; i++) {
      const f = `${file}.${i}`;
      if (!existsSync(f)) break;
      rotated.push({ name: basename(f), size_bytes: statSync(f).size });
    }
  }
  return {
    id: def.id,
    label: def.label,
    kind: def.kind,
    available,
    file: file != null ? basename(file) : null,
    size_bytes: st?.size ?? 0,
    modified_at_ms: st?.mtimeMs ?? null,
    rotated_files: rotated,
    can_rotate: getRotatingLogStream(def.id) != null,
  };
}

// Reads the last `maxBytes` of a file, discarding the first (likely partial)
// line when the read didn't start at offset 0.
async function readTailTextSized(
  file: string,
  maxBytes: number,
): Promise<{ text: string; scanned: number; fileSize: number } | null> {
  if (!existsSync(file)) return null;
  const st = await stat(file);
  const start = Math.max(0, st.size - maxBytes);
  const len = st.size - start;
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return { text, scanned: len, fileSize: st.size };
  } finally {
    await fh.close();
  }
}

function parseLine(line: string, kind: 'structured' | 'text'): LogEntry {
  if (kind === 'structured') {
    try {
      const j = JSON.parse(line) as Record<string, unknown>;
      return {
        ts_ms: typeof j.time === 'number' ? j.time : null,
        level: typeof j.level === 'number' ? j.level : null,
        process: typeof j.process === 'string' ? j.process : null,
        event: typeof j.event === 'string' ? j.event : null,
        msg: typeof j.msg === 'string' ? j.msg : '',
        raw: line,
      };
    } catch {
      // fall through to the text shape
    }
  }
  return { ts_ms: null, level: null, process: null, event: null, msg: line, raw: line };
}

function matches(entry: LogEntry, q: LogTailQuery): boolean {
  if (q.level_min != null && (entry.level == null || entry.level < q.level_min)) return false;
  if (q.process) {
    const wanted = q.process.split(',').map((s) => s.trim()).filter(Boolean);
    if (wanted.length > 0 && (entry.process == null || !wanted.includes(entry.process))) return false;
  }
  if (q.event) {
    if (entry.event == null || !entry.event.toLowerCase().includes(q.event.toLowerCase())) return false;
  }
  if (q.q) {
    if (!entry.raw.toLowerCase().includes(q.q.toLowerCase())) return false;
  }
  return true;
}

export async function logsRoutes(fastify: FastifyInstance) {
  fastify.get('/logs/sources', async (_request, reply) => {
    return reply.send({ sources: SOURCE_DEFS.map(sourceInfo) });
  });

  fastify.get('/logs/settings', async (_request, reply) => {
    return reply.send(readLogSettings());
  });

  // Applies live: the API-owned streams pick the new cap up on their next
  // write; the hourly external sweep reads the config fresh each run.
  fastify.post('/logs/settings', async (request, reply) => {
    const parsed = LogSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid settings' });
    }
    writeLogSettings(parsed.data);
    applyLogSettingsToStreams(parsed.data);
    fastify.log.info({ event: 'LOG_SETTINGS_UPDATED', ...parsed.data }, 'logs: settings updated');
    return reply.send(parsed.data);
  });

  fastify.get('/logs/tail', async (request, reply) => {
    const parsed = LogTailQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid query' });
    }
    const q = parsed.data;
    const def = SOURCE_DEFS.find((d) => d.id === q.source)!;
    const file = def.resolveFile();
    if (file == null || !existsSync(file)) {
      return reply.send({ source: q.source, entries: [], file_size_bytes: 0, scanned_bytes: 0 });
    }
    const filtered = Boolean(q.level_min != null || q.process || q.event || q.q);
    const tail = await readTailTextSized(file, filtered ? SCAN_BYTES_FILTERED : SCAN_BYTES_PLAIN);
    if (tail == null) {
      return reply.send({ source: q.source, entries: [], file_size_bytes: 0, scanned_bytes: 0 });
    }
    const lines = tail.text.split('\n');
    // Walk newest-first so the limit keeps the most recent matches, then
    // restore chronological order for the response.
    const out: LogEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < q.limit; i--) {
      const line = lines[i];
      if (!line) continue;
      const entry = parseLine(line, def.kind);
      if (matches(entry, q)) out.push(entry);
    }
    out.reverse();
    return reply.send({
      source: q.source,
      entries: out,
      file_size_bytes: tail.fileSize,
      scanned_bytes: tail.scanned,
    });
  });

  // Force-rotate a source the API owns the write stream for.
  fastify.post('/logs/rotate', async (request, reply) => {
    const parsed = LogMaintenanceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid source' });
    }
    const stream = getRotatingLogStream(parsed.data.source);
    if (stream == null) {
      return reply
        .status(400)
        .send({ error: `source '${parsed.data.source}' is not rotatable (not written by the API)` });
    }
    stream.rotate();
    fastify.log.info({ event: 'LOG_ROTATED', source: parsed.data.source }, 'logs: manual rotation');
    return reply.send({ ok: true, message: 'rotated' });
  });

  // Purge: truncate the active file and delete rotated files. Works for all
  // sources — external writers (LiquidSoap, Icecast) open their logs in
  // append mode, so truncation under them is safe.
  fastify.post('/logs/purge', async (request, reply) => {
    const parsed = LogMaintenanceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid source' });
    }
    const def = SOURCE_DEFS.find((d) => d.id === parsed.data.source)!;
    const file = def.resolveFile();
    if (file == null || !existsSync(file)) {
      return reply.status(404).send({ error: 'log file not found' });
    }
    let removed = 0;
    for (let i = 1; i <= 9; i++) {
      const f = `${file}.${i}`;
      if (!existsSync(f)) break;
      unlinkSync(f);
      removed++;
    }
    truncateSync(file, 0);
    getRotatingLogStream(parsed.data.source)?.noteTruncated();
    fastify.log.info(
      { event: 'LOG_PURGED', source: parsed.data.source, rotated_removed: removed },
      'logs: purged',
    );
    return reply.send({ ok: true, message: `cleared (${removed} rotated file${removed === 1 ? '' : 's'} removed)` });
  });
}
