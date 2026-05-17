/**
 * Mulberry32 — small deterministic 32-bit PRNG. Two calls with the same seed
 * produce the same sequence, which the predictor relies on so dry-run and
 * "preview" diffs over the same snapshot land on the same picks.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Compose a seed from arbitrary integer-ish parts (deterministic across runs). */
export function composeSeed(...parts: number[]): number {
  let s = 0x9e3779b9;
  for (const p of parts) {
    s = (Math.imul(s ^ (p >>> 0), 0x85ebca6b) ^ (s >>> 13)) >>> 0;
  }
  return s >>> 0;
}

/** Weighted pick from an array. Returns null when total weight <= 0. */
export function weightedPick<T>(
  items: ReadonlyArray<{ value: T; weight: number }>,
  rand: () => number,
): T | null {
  let total = 0;
  for (const it of items) total += Math.max(0, it.weight);
  if (total <= 0) return null;
  let r = rand() * total;
  for (const it of items) {
    const w = Math.max(0, it.weight);
    if (r < w) return it.value;
    r -= w;
  }
  return items[items.length - 1].value;
}
