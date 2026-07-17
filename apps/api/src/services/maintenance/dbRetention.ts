// Database retention sweep — deletes OPERATIONAL records past a retention
// window: terminal plans (completed/Invalid) with their plan_items and
// stop_set_estimates, plus old live_events.
//
// What it deliberately never touches:
//   - play_history — ground truth for campaign reports (this month's billing)
//     and rotation/separation state. No retention until the D96 delivery
//     ledger aggregates it; aggregate first, prune later, never the reverse.
//   - anything newer than the start of the PREVIOUS calendar month — a hard
//     floor the configured day-count cannot override. The campaign report
//     views join play_history → plan_items for content-type filtering, so
//     items inside the reporting window must survive regardless of settings.
//   - non-terminal plans, at any age. A stuck non-terminal plan is a bug to
//     diagnose, not evidence to auto-delete.
//
// Runs at boot and every 24h (same pattern as the external log sweep).
// VACUUM runs only when something was actually deleted — that's what returns
// the space to the filesystem.
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { inArray, lt, sql } from 'drizzle-orm';
import type { DbSweepResult, MaintenanceSettings } from '@soono/shared';
import { db as defaultDb } from '../../db/index.js';
import {
  liveEvents,
  planItems,
  plans,
  stopSetEstimates,
} from '../../db/schema.js';
import type { SLogger } from '../supervisor2/supervisorLogger.js';

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const CONFIG_PATH =
  process.env.MAINTENANCE_CONFIG ||
  join(process.cwd(), '..', '..', 'data', 'maintenance-config.json');

export const DEFAULT_MAINTENANCE_SETTINGS: MaintenanceSettings = {
  plans_retention_days: 90,
};

interface MaintenanceConfigFile {
  plans_retention_days?: number;
  last_sweep?: DbSweepResult;
}

function readConfigFile(): MaintenanceConfigFile {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as MaintenanceConfigFile;
    }
  } catch {
    // corrupt config must never block anything — fall back to defaults
  }
  return {};
}

function writeConfigFile(cfg: MaintenanceConfigFile): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

export function readMaintenanceSettings(): MaintenanceSettings {
  const raw = readConfigFile();
  const days = raw.plans_retention_days;
  return {
    plans_retention_days:
      typeof days === 'number' && days >= 35 && days <= 3650
        ? days
        : DEFAULT_MAINTENANCE_SETTINGS.plans_retention_days,
  };
}

export function writeMaintenanceSettings(settings: MaintenanceSettings): void {
  writeConfigFile({ ...readConfigFile(), ...settings });
}

export function readLastSweep(): DbSweepResult | null {
  return readConfigFile().last_sweep ?? null;
}

// The deletion cutoff: whichever is OLDER of (now − retention) and the start
// of the previous calendar month. The month floor guarantees the current
// reporting period plus the one being reported on stay intact.
export function computeCutoffMs(nowMs: number, retentionDays: number): number {
  const retentionCutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const now = new Date(nowMs);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
  return Math.min(retentionCutoff, prevMonthStart);
}

export async function sweepDatabase(
  logger: SLogger | null,
  database: typeof defaultDb = defaultDb,
): Promise<DbSweepResult> {
  const settings = readMaintenanceSettings();
  const nowMs = Date.now();
  const cutoffMs = computeCutoffMs(nowMs, settings.plans_retention_days);

  const doomedPlanIds = database
    .select({ id: plans.id })
    .from(plans)
    .where(sql`${plans.created_at} < ${cutoffMs} AND ${plans.status} IN ('completed', 'Invalid')`);

  // Children explicitly before parents — deterministic even if the SQLite
  // connection ever runs without foreign_keys=ON (cascades would otherwise
  // silently not fire).
  const itemsRes = await database
    .delete(planItems)
    .where(inArray(planItems.plan_id, doomedPlanIds));
  const estimatesRes = await database
    .delete(stopSetEstimates)
    .where(inArray(stopSetEstimates.plan_id, doomedPlanIds));
  const plansRes = await database
    .delete(plans)
    .where(sql`${plans.created_at} < ${cutoffMs} AND ${plans.status} IN ('completed', 'Invalid')`);
  const liveRes = await database.delete(liveEvents).where(lt(liveEvents.started_at, cutoffMs));

  const result: DbSweepResult = {
    at_ms: nowMs,
    cutoff_ms: cutoffMs,
    plans_deleted: plansRes.rowsAffected ?? 0,
    plan_items_deleted: itemsRes.rowsAffected ?? 0,
    stop_set_estimates_deleted: estimatesRes.rowsAffected ?? 0,
    live_events_deleted: liveRes.rowsAffected ?? 0,
    vacuumed: false,
  };

  const deletedTotal =
    result.plans_deleted +
    result.plan_items_deleted +
    result.stop_set_estimates_deleted +
    result.live_events_deleted;
  if (deletedTotal > 0) {
    await database.run(sql`VACUUM`);
    result.vacuumed = true;
  }

  writeConfigFile({ ...readConfigFile(), last_sweep: result });
  logger?.info(
    { event: 'DB_SWEEP', ...result },
    deletedTotal > 0
      ? 'maintenance: database sweep deleted expired operational records'
      : 'maintenance: database sweep — nothing past retention',
  );
  return result;
}

export function startDbRetentionSweep(logger: SLogger | null): void {
  const run = () =>
    void sweepDatabase(logger).catch((err) => {
      logger?.error({ err, event: 'DB_SWEEP_FAILED' }, 'maintenance: database sweep failed');
    });
  run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref();
}
