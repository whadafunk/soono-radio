import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
import Fastify from 'fastify';
import pino from 'pino';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { icecastRoutes } from './routes/icecast.js';
import { certificateRoutes } from './routes/certificates.js';
import { liquidsoapRoutes } from './routes/liquidsoap.js';
import { libraryRoutes } from './routes/library.js';
import { supervisorRoutes } from './routes/supervisor.js';
import { lsWebhookRoutes } from './routes/lsWebhooks.js';
import { clockRoutes } from './routes/clocks.js';
import { showRoutes } from './routes/shows.js';
import { customerRoutes } from './routes/customers.js';
import { scheduleRoutes } from './routes/schedule.js';
import { rotationRoutes } from './routes/rotations.js';
import { userRoutes } from './routes/users.js';
import { playlistRoutes } from './routes/playlists.js';
import { integrationsRoutes } from './routes/integrations.js';
import { activityRoutes } from './routes/activity.js';
import { intervalRoutes } from './routes/intervals.js';
import { promoRoutes } from './routes/promos.js';
import { musicCampaignRoutes } from './routes/musicCampaigns.js';
import { rundownRoutes } from './routes/rundown.js';
import { spotBudgetRoutes } from './routes/spotBudget.js';
import { stationSettingsRoutes } from './routes/stationSettings.js';
import { supervisorStatusRoutes } from './routes/supervisorStatus.js';
import { supervisorControlRoutes } from './routes/supervisorControl.js';
import { logsRoutes } from './routes/logs.js';
import { maintenanceRoutes } from './routes/maintenance.js';
import { startDbRetentionSweep } from './services/maintenance/dbRetention.js';
import { createRotatingLogStream } from './services/logging/rotatingLog.js';
import { startExternalLogSweep } from './services/logging/externalLogSweep.js';
import {
  API_LOG_FILE,
  ICECAST_LOG_DIR,
  LIQUIDSOAP_LOG_DIR,
  LOG_DIR,
  newestLogIn,
} from './services/logging/logPaths.js';
import { db, runMigrations } from './db/index.js';
import { supervisorState as supervisorStateTable } from './db/schema.js';
import { ingestQueue, recoverInterruptedJobs, recoverLookupJobs } from './services/ingest/queue.js';
import { recoverInterruptedAnalysis } from './services/audioAnalysis.js';
import { ensureDirs } from './services/ingest/paths.js';
import { loadIntegrationsConfig } from './services/integrations/config.js';
import { generateRadioLiq, readLiquidsoapConfig, readRadioLiq } from './services/liquidsoapConfig.js';
import { ensureIcecastConfig } from './services/icecastConfig.js';
import { startPeakTracker } from './services/icecastPeakTracker.js';
import { bus } from './services/supervisor2/bus.js';
import { createSupervisorLogger, withProcess } from './services/supervisor2/supervisorLogger.js';
import { MusicProcess } from './services/supervisor2/processes/music.js';
import { CampaignProcess } from './services/supervisor2/processes/campaign.js';
import { BrandingProcess } from './services/supervisor2/processes/branding.js';
import { RundownProcess } from './services/supervisor2/processes/rundown.js';
import { PlannerProcess } from './services/supervisor2/processes/planner.js';
import { QueueFeederProcess } from './services/supervisor2/processes/queueFeeder.js';
import { SupervisorProcess } from './services/supervisor2/processes/supervisor.js';

// Write structured JSON logs to a size-rotated file so supervisor events can
// be reviewed after the fact with: tail -f logs/api.log | jq 'select(.event)'
try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* already exists */ }

const fastify = Fastify({
  bodyLimit: 4 * 1024 * 1024 * 1024, // 4 GB — large FLAC batches can easily exceed 500 MB
  logger: pino(
    { level: 'debug' },
    pino.multistream([
      // JSON stdout for the dev terminal / docker logs
      { stream: process.stdout, level: 'info' },
      // Full debug JSON to a size-rotated file for post-hoc analysis
      { stream: createRotatingLogStream('api', API_LOG_FILE), level: 'debug' },
    ]),
  ),
});

fastify.register(helmet);
const corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:3000,http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
fastify.register(cors, { origin: corsOrigins });
fastify.register(multipart, {
  limits: {
    // Audio uploads need much more headroom than certs. A typical 5-minute
    // FLAC sits around 30–50 MB; allow 4 GB per file so users can drop full albums.
    fileSize: 4 * 1024 * 1024 * 1024,
    // Batch imports of a whole back-catalog can easily exceed 100 files. When
    // this limit is hit, @fastify/multipart rejects the WHOLE request with its
    // own generic 413 (not our per-file size-limit check) — every file in the
    // batch shows the same "Payload Too Large" with no indication it was a
    // count limit, not a size one. Raised well above any realistic batch size.
    files: 1000,
  },
});

fastify.register(icecastRoutes);
fastify.register(certificateRoutes);
fastify.register(liquidsoapRoutes);
fastify.register(libraryRoutes);
fastify.register(supervisorRoutes);
fastify.register(lsWebhookRoutes);
fastify.register(clockRoutes);
fastify.register(showRoutes);
fastify.register(customerRoutes);
fastify.register(scheduleRoutes);
fastify.register(rotationRoutes);
fastify.register(userRoutes);
fastify.register(playlistRoutes);
fastify.register(integrationsRoutes);
fastify.register(activityRoutes);
fastify.register(intervalRoutes);
fastify.register(promoRoutes);
fastify.register(musicCampaignRoutes);
fastify.register(rundownRoutes);
fastify.register(spotBudgetRoutes);
fastify.register(stationSettingsRoutes);
fastify.register(supervisorStatusRoutes);
fastify.register(supervisorControlRoutes);
fastify.register(logsRoutes);
fastify.register(maintenanceRoutes);

fastify.get('/', async () => {
  return { message: 'Soono API' };
});

// Load .env from the repo root (written by start-liquidsoap.sh with
// LS_MEDIA_DIR=/media). Runs before any process reads env vars so lazy
// readers like lsMediaPathForSha() see the correct value.
function loadDotEnv(): void {
  try {
    const envPath = join(fileURLToPath(new URL('../../../.env', import.meta.url)));
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim();
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch { /* no .env file — fine */ }
}

const start = async () => {
  loadDotEnv();
  try {
    await runMigrations();
    fastify.log.info('Database migrations applied');
    await ensureIcecastConfig();
    await loadIntegrationsConfig();

    // Always regenerate the LiquidSoap script on startup so that template
    // changes (e.g. new settings) take effect after a deploy without needing
    // to delete the file manually. In Docker Compose, liquidsoap depends on
    // this service's healthcheck, so the script is ready before LS reads it.
    {
      const config = await readLiquidsoapConfig();
      await generateRadioLiq(config);
      fastify.log.info('Generated LiquidSoap script');
    }
    await ensureDirs();
    await startPeakTracker();
    const recovered = await recoverInterruptedJobs();
    if (recovered > 0) {
      fastify.log.info({ recovered }, 'Marked interrupted ingest jobs as failed');
    }
    const recoveredAnalysis = await recoverInterruptedAnalysis();
    if (recoveredAnalysis > 0) {
      fastify.log.info({ recovered: recoveredAnalysis }, 'Marked interrupted audio analysis as failed');
    }
    // Re-run identification for ingest jobs that completed but whose
    // fire-and-forget lookup was cut short by the previous shutdown.
    // Fire-and-forget — involves external API calls and must not block startup.
    recoverLookupJobs().catch((err) => fastify.log.error(err, 'recoverLookupJobs failed'));
    // Pick up any jobs that were left in 'queued' across restarts.
    ingestQueue.signal();

    // Ensure the singleton supervisor_state row exists before any process
    // tries to read/update it.
    await db
      .insert(supervisorStateTable)
      .values({ id: 1, current_drift_seconds: 0, paused: false })
      .onConflictDoNothing();

    // Create a dedicated supervisor logger — writes to logs/supervisor.log so
    // supervisor events are separated from HTTP noise in logs/api.log.
    const supervisorLog = createSupervisorLogger(LOG_DIR);

    // Instantiate and start all seven Supervisor V2 processes (Level 1 — all
    // share this Node.js process, communicating exclusively via the bus).
    const musicProcess = new MusicProcess(bus, db, supervisorLog);
    const campaignProcess = new CampaignProcess(bus, db, supervisorLog);
    const brandingProcess = new BrandingProcess(bus, db, supervisorLog);
    const rundownProcess = new RundownProcess(bus, db, supervisorLog);
    // Planner is the one process that doesn't stamp `process` per call —
    // bind it here so its lines are selectable in the Logs UI.
    const plannerProcess = new PlannerProcess(bus, db, withProcess(supervisorLog, 'planner'));
    const queueFeederProcess = new QueueFeederProcess(bus, db, supervisorLog);
    const supervisorProcess = new SupervisorProcess(bus, db, supervisorLog);

    const supervisorProcesses = [
      musicProcess,
      campaignProcess,
      brandingProcess,
      rundownProcess,
      plannerProcess,
      queueFeederProcess,
      supervisorProcess,
    ];
    for (const p of supervisorProcesses) p.start();
    fastify.log.info(
      { count: supervisorProcesses.length },
      'Supervisor V2 processes started',
    );

    // Hourly size sweep for the log files the API doesn't write itself
    // (LiquidSoap, Icecast) — their writers hold the files open in append
    // mode, so the sweep archives+truncates instead of renaming.
    startExternalLogSweep(
      () => [
        newestLogIn(LIQUIDSOAP_LOG_DIR),
        join(ICECAST_LOG_DIR, 'error.log'),
        join(ICECAST_LOG_DIR, 'access.log'),
      ],
      supervisorLog,
    );

    // Nightly database retention sweep (terminal plans + operational records
    // past retention; hard floor at the previous month's start — see
    // services/maintenance/dbRetention.ts for what it never touches).
    startDbRetentionSweep(supervisorLog);

    await fastify.listen({ port: 3000, host: '0.0.0.0' });

    const shutdown = async (signal: string) => {
      fastify.log.info(`Received ${signal}, shutting down`);
      for (const p of supervisorProcesses) {
        try {
          p.stop();
        } catch (err) {
          fastify.log.error({ err }, 'Supervisor process stop() threw');
        }
      }
      await fastify.close();
      process.exit(0);
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
