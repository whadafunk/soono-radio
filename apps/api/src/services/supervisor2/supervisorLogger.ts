// Minimal logger interface — subset of pino.Logger / FastifyBaseLogger that
// supervisor processes actually use. Both pino.Logger and FastifyBaseLogger
// satisfy this at runtime.
export interface SLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

import { createWriteStream } from 'fs';
import { join } from 'path';
import pino from 'pino';

// Creates a pino logger that writes INFO+ to stdout and DEBUG+ to
// logs/supervisor.log. Separate from the Fastify HTTP logger so that
// supervisor events never appear in logs/api.log and HTTP noise never
// appears in logs/supervisor.log.
export function createSupervisorLogger(logDir: string): SLogger {
  const logFile = join(logDir, 'supervisor.log');
  const streams = pino.multistream([
    { stream: process.stdout, level: 'info' as const },
    { stream: createWriteStream(logFile, { flags: 'a' }), level: 'debug' as const },
  ]);
  return pino({ level: 'debug' }, streams);
}
