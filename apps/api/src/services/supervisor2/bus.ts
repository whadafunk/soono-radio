import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
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
      // LiquidSoap's OS process id at the moment this fired (Decision 88).
      // A value differing from supervisor_state.ls_pid is unambiguous,
      // retroactive proof LiquidSoap restarted since the last-seen event.
      ls_pid: number | null;
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
      // See LS_TRACK_STARTED.ls_pid — Decision 88.
      ls_pid: number | null;
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
      // Show id passed only to the branding process so it can return
      // show_start / show_end envelope candidates (D40). Null / omitted for
      // non-show segments or non-branding processes.
      show_id: number | null;
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
      // Show context resolved by the Supervisor (D40, D50). Null when no
      // show is scheduled for this segment's clock instance. The Planner
      // uses show_id to request show-start/end envelopes from Branding and
      // to determine is_show_start / is_show_end via a calendar query.
      show_id: number | null;
      show_name: string | null;
      // computeResolutionIdentity() of the ResolvedSegment behind this
      // request — stamped onto the plans row so a later reconcile pass can
      // detect a schedule change that resolves to the same clock/segment/
      // hour but from a different calendar/template row. Null only for
      // requests that don't come from a live resolution (none exist today,
      // but kept optional for that eventuality).
      resolution_identity: string | null;
      // ── Decision 93: drift-ledger inputs, persisted onto the plans row ──
      // Segment nominal at request time. Null for live segments and legacy
      // callers; the planner falls back to reading the segment row itself.
      nominal_duration_seconds: number | null;
      // Decision 91 prediction the target responded to (null where sizing
      // wasn't drift-driven: cold start, reconcile ground-truth establish).
      predicted_drift_seconds: number | null;
      // nominal − target after all clamps (Decision 92's honest value).
      applied_correction_seconds: number | null;
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
      // Drift-adjusted target the Planner must hit during second-pass
      // assembly (D49, D50). The Supervisor owns this computation:
      //   adjusted_target = nominal_segment_duration − current_drift_seconds
      // clamped to [60%, 140%] of nominal. When |drift_delta_seconds| ≥
      // second_pass_drift_delta_threshold_s the Planner does a full
      // re-assembly using this value; otherwise it only re-validates.
      adjusted_target_seconds: number;
      // drift_at_second_pass − drift_at_first_pass. Governs whether the
      // Planner does a full re-assembly (large delta) or lightweight
      // substitution only (small delta). See Decision 31.
      drift_delta_seconds: number;
      // Running drift at the moment finalization is triggered. Logged on
      // every PLAN_FINALIZE_COMPLETE entry for post-mortem analysis.
      current_drift_seconds: number;
      // ── Decision 93: drift-ledger inputs (see PLAN_DRAFT_REQUESTED) ──
      // Finalize overwrites the draft-time ledger values on the plans row.
      predicted_drift_seconds: number | null;
      applied_correction_seconds: number | null;
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
    }
  | {
      // Route → Supervisor: run the heavier reconcile() pass immediately
      // instead of waiting for the next start/restart. Emitted by the
      // align-to-wall-clock control route and by every schedule-affecting
      // mutation (Decision 54) — clock segment save/delete, calendar/template
      // entry CRUD, template run, show default-clock reassignment. Free-form
      // string like PUSH_NEXT_REQUESTED.reason below, not a closed union, so
      // a new call site never needs a type change here.
      type: 'RECONCILE_REQUESTED';
      request_id: string;
      now_ms: number;
      trigger: string;
    }
  // ─── Phase 4: Live takeover ─────────────────────────────────────────────────
  //
  // Fired by the API webhook routes when LiquidSoap reports its live harbor
  // input has connected / disconnected. The Supervisor switches into / out of
  // live-takeover mode and relays the status change to the Queue Feeder via
  // LIVE_STATUS_CHANGED so the latter can suspend pushes while the DJ is on.
  | {
      type: 'LS_LIVE_STARTED';
      source_name: string;
    }
  | {
      type: 'LS_LIVE_ENDED';
      source_name: string;
    }
  | {
      // Supervisor → Queue Feeder: live takeover entered (active=true) or left
      // (active=false). Sent in addition to LS_LIVE_STARTED / LS_LIVE_ENDED so
      // the Queue Feeder doesn't need to interpret LS-specific events.
      type: 'LIVE_STATUS_CHANGED';
      active: boolean;
    }
  | { type: 'PUSH_NEXT_REQUESTED'; reason: string }
  // QueueFeeder → Supervisor: a plan item was successfully pushed to harbor.
  // Used by the Supervisor to reset its silence-alert timer.
  | { type: 'PUSH_SENT'; plan_item_id: number; play_history_id: number };

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

// Convenience for route handlers that just need to nudge the Supervisor's
// reconcile() pass after a schedule-affecting mutation (Decision 54) — one
// less bus.emit({...}) shape to get wrong at each of the many call sites.
export function requestReconcile(trigger: string): void {
  bus.emit({ type: 'RECONCILE_REQUESTED', request_id: randomUUID(), now_ms: Date.now(), trigger });
}
