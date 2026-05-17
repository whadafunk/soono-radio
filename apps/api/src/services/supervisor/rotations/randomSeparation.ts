import { mulberry32 } from './rng.js';
import type { RotationAlgorithm } from './types.js';

/**
 * Random pick from the pool, excluding tracks (and optionally artists) that
 * have aired inside their separation windows. Falls back to ignoring artist
 * separation when that filter empties the pool — never goes silent because of
 * a single over-represented artist.
 */
export const randomSeparation: RotationAlgorithm = ({ pool, history, rotation, seed, now }) => {
  if (pool.length === 0) return null;

  const separationMinutes = numberParam(rotation.params.separation_minutes, 60);
  const artistSeparationMinutes = numberParam(rotation.params.artist_separation_minutes, 0);

  const sepCutoff = now.getTime() - separationMinutes * 60_000;
  const artistCutoff = now.getTime() - artistSeparationMinutes * 60_000;

  const blockedMedia = new Set<number>();
  const blockedArtists = new Set<string>();
  for (const h of history) {
    const t = h.started_at.getTime();
    if (h.media_id != null && t >= sepCutoff) blockedMedia.add(h.media_id);
    if (h.artist && t >= artistCutoff) blockedArtists.add(h.artist.toLowerCase());
  }

  let eligible = pool.filter(
    (m) =>
      !blockedMedia.has(m.id) && (!m.artist || !blockedArtists.has(m.artist.toLowerCase())),
  );
  let relaxedArtist = false;
  if (eligible.length === 0 && artistSeparationMinutes > 0) {
    // Artist separation alone emptied the pool — relax it. Track separation
    // is the harder rule (we never want the same track twice quickly).
    eligible = pool.filter((m) => !blockedMedia.has(m.id));
    relaxedArtist = true;
  }
  if (eligible.length === 0) return null;

  const rand = mulberry32(seed);
  const choice = eligible[Math.floor(rand() * eligible.length)];
  const reasonParts = [
    `random_separation eligible=${eligible.length}/${pool.length}`,
    `sep=${separationMinutes}min`,
  ];
  if (artistSeparationMinutes > 0) {
    reasonParts.push(
      relaxedArtist
        ? `artist_sep=${artistSeparationMinutes}min(relaxed)`
        : `artist_sep=${artistSeparationMinutes}min`,
    );
  }
  return { media: choice, reason: reasonParts.join(' ') };
};

function numberParam(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}
