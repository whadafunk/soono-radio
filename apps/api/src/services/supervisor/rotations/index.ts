import type { RotationType } from '../../../db/schema.js';
import { leastRecentlyPlayed } from './leastRecentlyPlayed.js';
import { randomSeparation } from './randomSeparation.js';
import { roundRobin } from './roundRobin.js';
import { weighted } from './weighted.js';
import type { RotationAlgorithm, RotationContext, RotationPick } from './types.js';

const ALGORITHMS: Record<RotationType, RotationAlgorithm> = {
  least_recently_played: leastRecentlyPlayed,
  random_separation: randomSeparation,
  round_robin: roundRobin,
  weighted,
};

/** Run the rotation algorithm named by `ctx.rotation.type` against the pool. */
export function runRotation(ctx: RotationContext): RotationPick | null {
  return ALGORITHMS[ctx.rotation.type](ctx);
}

export type { RotationContext, RotationPick } from './types.js';
