import { bus } from '../bus.js';

export class PlannerProcess {
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    private readonly _bus: typeof bus,
  ) {}

  start(): void {
    // Phase 3: driven by Supervisor via bus messages.
    // Assembles draft and finalized plans; writes plan + plan_items to SQLite.
  }

  stop(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
  }
}
