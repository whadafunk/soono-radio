import type { PoolMedia, SnapshotPlayRecord, SnapshotRotation } from '../snapshot.js';

export interface RotationContext {
  pool: PoolMedia[];
  history: SnapshotPlayRecord[];
  rotation: SnapshotRotation;
  /** Deterministic seed — same seed + same context → same pick. */
  seed: number;
  now: Date;
}

export interface RotationPick {
  media: PoolMedia;
  /** Short string describing why this pick was made. Goes to pick_reason. */
  reason: string;
}

export type RotationAlgorithm = (ctx: RotationContext) => RotationPick | null;
