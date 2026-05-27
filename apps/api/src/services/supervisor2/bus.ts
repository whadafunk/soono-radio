import { EventEmitter } from 'events';

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
