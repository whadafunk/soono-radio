import { bus } from '../bus.js';

export class CampaignProcess {
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    private readonly _bus: typeof bus,
  ) {}

  start(): void {
    // Phase 2: register REQUEST_CANDIDATES handler for stop_set segments.
    // Also owns promo pacing (embedded, not a separate process).
  }

  stop(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
  }
}
