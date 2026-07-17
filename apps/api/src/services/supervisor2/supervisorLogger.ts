// Minimal logger interface — subset of pino.Logger / FastifyBaseLogger that
// supervisor processes actually use. Both pino.Logger and FastifyBaseLogger
// satisfy this at runtime.
export interface SLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

import { join } from 'path';
import pino from 'pino';
import { createRotatingLogStream } from '../logging/rotatingLog.js';

// Creates a pino logger that writes INFO+ to stdout and DEBUG+ to
// logs/supervisor.log (size-rotated). Separate from the Fastify HTTP logger
// so that supervisor events never appear in logs/api.log and HTTP noise never
// appears in logs/supervisor.log.
export function createSupervisorLogger(logDir: string): SLogger {
  const logFile = join(logDir, 'supervisor.log');
  const streams = pino.multistream([
    { stream: process.stdout, level: 'info' as const },
    { stream: createRotatingLogStream('supervisor', logFile), level: 'debug' as const },
  ]);
  return pino({ level: 'debug' }, streams);
}

// Stamps a fixed `process` field onto every line, unless the call site
// already provides its own. The supervisor/feeder/content processes all pass
// `process` explicitly per call; the planner never did, which left its lines
// the only ones a log view can't select by process. An explicit field in the
// call always wins over the binding.
export function withProcess(logger: SLogger, processName: string): SLogger {
  const bind =
    (fn: (obj: Record<string, unknown>, msg: string) => void) =>
    (obj: Record<string, unknown>, msg: string) =>
      fn.call(logger, { process: processName, ...obj }, msg);
  return {
    info: bind(logger.info),
    warn: bind(logger.warn),
    error: bind(logger.error),
    debug: bind(logger.debug),
  };
}
