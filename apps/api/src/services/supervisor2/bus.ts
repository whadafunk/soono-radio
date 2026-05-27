import { EventEmitter } from 'events';
import type {
  BrandingCandidatePool,
  MusicCandidatePool,
  RundownCandidatePool,
  StopSetCandidatePool,
} from './types.js';

// Names of the four content processes. Used to route REQUEST_CANDIDATES and
// CANDIDATES traffic — each content process filters bus events to messages
// addressed to itself.
export type ContentProcessName = 'music' | 'campaign' | 'branding' | 'rundown';

// All cross-process messages use this discriminated union.
// In Level 1, the bus is an in-process EventEmitter wrapper.
// In Level 3, replacing bus.ts with an IPC router leaves all process modules unchanged.
export type BusMessage =
  | {
      type: 'LS_TRACK_STARTED';
      // Fields forwarded verbatim from LiquidSoap's on_track webhook.
      // on_air_timestamp: Unix epoch float — the exact moment audio started flowing.
      on_air_timestamp: number;
      // Annotated URI that LS is now playing.
      uri: string;
      // play_history_id annotation attached when the track was pushed.
      play_history_id: number | null;
      // Any additional LS metadata fields (title, artist, etc.).
      metadata: Record<string, string>;
    }
  | {
      type: 'LS_TRACK_ENDING';
      // Seconds remaining in the current track when this webhook fired.
      remaining_seconds: number;
      // URI of the track that is ending.
      uri: string;
      // play_history_id annotation on the ending track.
      play_history_id: number | null;
      metadata: Record<string, string>;
    }
  // ─── Phase 2: Planner ↔ content process protocol (Decision 11) ──────────────
  //
  // The planner emits REQUEST_CANDIDATES addressed to one content process per
  // message. The targeted process replies with CANDIDATES carrying a pool.
  // No state changes happen during the request/response cycle — pacing,
  // rotation position, and slot-1 tracking are updated only on CONFIRM_USED.
  // RETURN_UNUSED is informational. DROP_COMMITTED reverses a prior
  // CONFIRM_USED when a replan rejects items the planner had committed.
  | {
      type: 'REQUEST_CANDIDATES';
      request_id: string;
      process: ContentProcessName;
      segment_id: number;
      duration_needed_seconds: number;
      // Unix ms — identifies which clock-hour instance of the segment this
      // request belongs to. Lets the content process scope per-instance
      // queries (e.g. rundown assignments are keyed by clock instance).
      clock_instance_started_at: number;
      // Unix ms — the planner's notion of "now" at request time. Content
      // processes use this for time-windowed eligibility checks rather than
      // calling Date.now() themselves, so dry-run simulation can substitute
      // a synthetic clock without modifying the processes.
      now_ms: number;
    }
  | {
      type: 'CANDIDATES';
      request_id: string;
      process: ContentProcessName;
      payload:
        | MusicCandidatePool
        | StopSetCandidatePool
        | BrandingCandidatePool
        | RundownCandidatePool;
    }
  | {
      type: 'CONFIRM_USED';
      request_id: string;
      process: ContentProcessName;
      // ids the planner committed to the plan, in placement order
      used_ids: number[];
    }
  | {
      type: 'RETURN_UNUSED';
      request_id: string;
      process: ContentProcessName;
      unused_ids: number[];
    }
  | {
      type: 'DROP_COMMITTED';
      request_id: string;
      process: ContentProcessName;
      // ids the planner is removing from a previously-finalized plan; the
      // content process should reverse any state update CONFIRM_USED applied
      dropped_ids: number[];
    }
  // ─── Phase 3: Supervisor ↔ Planner protocol ─────────────────────────────────
  //
  // The Supervisor drives planning. It signals the Planner at segment start
  // (draft), 30–60s before the boundary (finalize), and any time drift
  // requires the remaining items to be rebuilt (replan).
  | {
      // Supervisor → Planner: request a draft plan for the next segment.
      type: 'PLAN_DRAFT_REQUESTED';
      request_id: string;
      segment_id: number;
      // Unix ms — identifies this clock-instance of the segment, scopes
      // per-instance lookups (rundown assignments etc.).
      clock_instance_started_at: number;
      // Segment duration already adjusted for drift by the Supervisor.
      target_duration_seconds: number;
      now_ms: number;
    }
  | {
      // Planner → Supervisor + Queue Feeder: draft plan written to SQLite.
      type: 'PLAN_DRAFT_READY';
      request_id: string;
      plan_id: number;
      segment_id: number;
    }
  | {
      // Supervisor → Planner: finalize the draft (fresh pacing, operator edits).
      type: 'PLAN_FINALIZE_REQUESTED';
      request_id: string;
      plan_id: number;
      now_ms: number;
    }
  | {
      // Planner → Supervisor + Queue Feeder: plan finalized, queue feeder may
      // start executing.
      type: 'PLAN_FINALIZED';
      request_id: string;
      plan_id: number;
    }
  | {
      // Supervisor → Planner: replan the remaining items in an active plan
      // (drift correction). Items at positions ≥ from_position are eligible
      // for replacement; everything before is already played or in-flight.
      type: 'PLAN_REPLAN_REQUESTED';
      request_id: string;
      plan_id: number;
      from_position: number;
      remaining_seconds: number;
      now_ms: number;
    }
  | {
      // Planner → Supervisor: replan complete.
      type: 'PLAN_REPLANNED';
      request_id: string;
      plan_id: number;
    };

const emitter = new EventEmitter();
// Prevent Node from printing spurious MaxListenersExceededWarning during
// development when many process modules subscribe at once.
emitter.setMaxListeners(50);

export const bus = {
  emit<T extends BusMessage>(msg: T): void {
    emitter.emit(msg.type, msg);
  },

  on<T extends BusMessage>(
    type: T['type'],
    handler: (msg: Extract<BusMessage, { type: T['type'] }>) => void,
  ): () => void {
    emitter.on(type, handler as (msg: BusMessage) => void);
    return () => {
      emitter.off(type, handler as (msg: BusMessage) => void);
    };
  },
};
