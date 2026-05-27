import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
import Fastify from 'fastify';
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
import { db, runMigrations } from './db/index.js';
import { supervisorState as supervisorStateTable } from './db/schema.js';
import { ingestQueue, recoverInterruptedJobs, recoverLookupJobs } from './services/ingest/queue.js';
import { ensureDirs } from './services/ingest/paths.js';
import { loadIntegrationsConfig } from './services/integrations/config.js';
import { bus } from './services/supervisor2/bus.js';
import { MusicProcess } from './services/supervisor2/processes/music.js';
import { CampaignProcess } from './services/supervisor2/processes/campaign.js';
import { BrandingProcess } from './services/supervisor2/processes/branding.js';
import { RundownProcess } from './services/supervisor2/processes/rundown.js';
import { PlannerProcess } from './services/supervisor2/processes/planner.js';
import { QueueFeederProcess } from './services/supervisor2/processes/queueFeeder.js';
import { SupervisorProcess } from './services/supervisor2/processes/supervisor.js';

const fastify = Fastify({
  logger: true,
});

fastify.register(helmet);
fastify.register(cors, {
  origin: ['http://localhost:3000', 'http://localhost:5173'],
});
fastify.register(multipart, {
  limits: {
    // Audio uploads need much more headroom than certs. A typical 5-minute
    // FLAC sits around 30–50 MB; allow 500 MB so users can drop full albums.
    fileSize: 500 * 1024 * 1024,
    files: 100,
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

fastify.get('/', async () => {
  return { message: 'Radio API Server' };
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
    await loadIntegrationsConfig();
    await ensureDirs();
    const recovered = await recoverInterruptedJobs();
    if (recovered > 0) {
      fastify.log.info({ recovered }, 'Marked interrupted ingest jobs as failed');
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

    // Instantiate and start all seven Supervisor V2 processes (Level 1 — all
    // share this Node.js process, communicating exclusively via the bus).
    const musicProcess = new MusicProcess(bus, db);
    const campaignProcess = new CampaignProcess(bus, db);
    const brandingProcess = new BrandingProcess(bus, db);
    const rundownProcess = new RundownProcess(bus, db);
    const plannerProcess = new PlannerProcess(bus, db, fastify.log);
    const queueFeederProcess = new QueueFeederProcess(bus, db, fastify.log);
    const supervisorProcess = new SupervisorProcess(bus, db, fastify.log);

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
