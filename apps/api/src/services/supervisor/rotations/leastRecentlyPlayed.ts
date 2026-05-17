import type { RotationAlgorithm } from './types.js';

/**
 * Pick the track that hasn't aired in the longest time. Never-played tracks
 * are preferred over previously-played ones. Optional `pool_size` param caps
 * the candidate set to the N least-recently-played items before any tie-break.
 */
export const leastRecentlyPlayed: RotationAlgorithm = ({ pool, history, rotation }) => {
  if (pool.length === 0) return null;

  // Index the most recent play time per media_id.
  const lastPlayed = new Map<number, number>();
  for (const h of history) {
    if (h.media_id == null) continue;
    if (!lastPlayed.has(h.media_id)) {
      // history is ordered desc — the first occurrence is the most recent.
      lastPlayed.set(h.media_id, h.started_at.getTime());
    }
  }

  // Sort: never-played (no entry) first; otherwise oldest first.
  const sorted = [...pool].sort((a, b) => {
    const la = lastPlayed.get(a.id);
    const lb = lastPlayed.get(b.id);
    if (la == null && lb == null) return a.id - b.id;
    if (la == null) return -1;
    if (lb == null) return 1;
    return la - lb;
  });

  const poolSizeRaw = rotation.params.pool_size;
  const poolSize =
    typeof poolSizeRaw === 'number' && Number.isFinite(poolSizeRaw) && poolSizeRaw > 0
      ? Math.floor(poolSizeRaw)
      : null;
  const candidates = poolSize ? sorted.slice(0, poolSize) : sorted;
  const choice = candidates[0];
  const reason = lastPlayed.has(choice.id)
    ? `LRP eligible=${candidates.length}/${pool.length}`
    : `LRP never_played eligible=${candidates.length}/${pool.length}`;
  return { media: choice, reason };
};
