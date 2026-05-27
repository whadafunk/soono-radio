import { bus } from '../bus.js';

export class RundownProcess {
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    private readonly _bus: typeof bus,
  ) {}

  start(): void {
    // Phase 2: register REQUEST_CANDIDATES handler for news/bulletin segments.
    // Returns ordered list of calendar-assigned clips + gap_estimate_seconds.
  }

  stop(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
  }
}
