import { mulberry32, weightedPick } from './rng.js';
import type { RotationAlgorithm } from './types.js';

/**
 * Random pick where each track's probability is proportional to its
 * `playlist_media.weight`. Tracks with weight 0 are skipped.
 */
export const weighted: RotationAlgorithm = ({ pool, seed }) => {
  if (pool.length === 0) return null;
  const rand = mulberry32(seed);
  const choice = weightedPick(
    pool.map((m) => ({ value: m, weight: Math.max(0, m.weight) })),
    rand,
  );
  if (!choice) return null;
  return { media: choice, reason: `weighted pool=${pool.length}` };
};
