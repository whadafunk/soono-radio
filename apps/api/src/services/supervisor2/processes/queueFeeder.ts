import { bus } from '../bus.js';

export class QueueFeederProcess {
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    private readonly _bus: typeof bus,
  ) {}

  start(): void {
    // Phase 4: subscribes to LS_TRACK_ENDING; reads next pending plan_item
    // and calls HarborClient.push(). Maintains queue depth = 1.
  }

  stop(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
  }
}
