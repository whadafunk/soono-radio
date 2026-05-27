import { bus } from '../bus.js';

// The Supervisor is the central orchestration process.
// It owns: outer event loop, drift accumulation, correction decisions,
// live takeover handling, safety-net heartbeat, and drives Planner + QueueFeeder.
// The deviation monitor is a logical module inside the Supervisor, not a separate process.
export class SupervisorProcess {
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    private readonly _bus: typeof bus,
  ) {}

  start(): void {
    // Phase 4: subscribe to LS_TRACK_STARTED and LS_TRACK_ENDING,
    // update supervisor_state table, drive Planner at segment boundaries,
    // accumulate drift, apply catching_up_order / coasting_order corrections.
    this.unsubscribers.push(
      this._bus.on('LS_TRACK_STARTED', (_msg) => {
        // Phase 4: update drift, check segment boundary, drive planner if needed.
      }),
    );
    this.unsubscribers.push(
      this._bus.on('LS_TRACK_ENDING', (_msg) => {
        // Phase 4: signal QueueFeeder to push next plan item.
      }),
    );
  }

  stop(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
  }
}
