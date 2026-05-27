import { bus } from '../bus.js';

export class BrandingProcess {
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    private readonly _bus: typeof bus,
  ) {}

  start(): void {
    // Phase 2: register REQUEST_CANDIDATES handler for jingles,
    // station IDs, and segment/show envelopes.
  }

  stop(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
  }
}
