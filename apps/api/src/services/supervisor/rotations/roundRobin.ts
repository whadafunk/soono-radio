import type { RotationAlgorithm } from './types.js';
import type { PoolMedia } from '../snapshot.js';

type OrderBy = 'added_date' | 'title' | 'artist' | 'manual';

/**
 * Cycle through the ordered pool. The "current position" is derived from the
 * most recent play in `history` that belongs to the pool — the pick is the
 * next item after it. Cold start (nothing from this pool has aired yet)
 * returns the first item.
 */
export const roundRobin: RotationAlgorithm = ({ pool, history, rotation }) => {
  if (pool.length === 0) return null;

  const orderBy = parseOrderBy(rotation.params.order_by);
  const ordered = orderPool(pool, orderBy);
  const idToIndex = new Map(ordered.map((m, i) => [m.id, i]));

  let lastIndex: number | null = null;
  for (const h of history) {
    if (h.media_id != null && idToIndex.has(h.media_id)) {
      lastIndex = idToIndex.get(h.media_id)!;
      break;
    }
  }

  const nextIndex = lastIndex == null ? 0 : (lastIndex + 1) % ordered.length;
  return {
    media: ordered[nextIndex],
    reason: `round_robin order=${orderBy} pos=${nextIndex + 1}/${ordered.length}`,
  };
};

function parseOrderBy(v: unknown): OrderBy {
  if (v === 'title' || v === 'artist' || v === 'manual' || v === 'added_date') return v;
  return 'added_date';
}

function orderPool(pool: PoolMedia[], by: OrderBy): PoolMedia[] {
  const copy = [...pool];
  switch (by) {
    case 'manual':
      return copy.sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    case 'title':
      return copy.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? '') || a.id - b.id);
    case 'artist':
      return copy.sort(
        (a, b) => (a.artist ?? '').localeCompare(b.artist ?? '') || a.id - b.id,
      );
    case 'added_date':
      return copy.sort((a, b) => a.added_at.getTime() - b.added_at.getTime() || a.id - b.id);
  }
}
