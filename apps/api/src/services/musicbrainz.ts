import type { AcoustIDCandidate } from './acoustid.js';

const MB_URL = 'https://musicbrainz.org/ws/2/recording';
// MusicBrainz requires a descriptive User-Agent.
const USER_AGENT = 'RadioSonara/1.0 (radio-automation-server)';

export interface FilenameParseResult {
  partA: string;
  partB: string;
  /** Cover artist extracted from brackets, e.g. "Twenty One Two" from
   *  "[Rock Cover by Twenty One Two]" or "[Twenty One Two Cover]". */
  coverArtist: string | null;
}

/**
 * Scan bracket/paren content for a cover-artist hint.
 * Handles:
 *   "Cover by X"  /  "Rock Cover by X"  → artist = X
 *   "X Cover"  /  "X Rock Cover"        → artist = X (only if X is multi-word,
 *                                          to avoid treating genre words like
 *                                          "Rock" as an artist name)
 */
function extractCoverArtist(s: string): string | null {
  const brackets = s.match(/[\(\[](.*?)[\)\]]/g) ?? [];
  for (const bracket of brackets) {
    const inner = bracket.slice(1, -1);
    // "Cover by X" (most common YouTube pattern)
    const byMatch = inner.match(/cover\s+by\s+(.+)/i);
    if (byMatch) return byMatch[1].trim();
    // "X Cover" where X is multi-word (rules out single genre words like "Rock")
    const beforeMatch = inner.match(/^(.+\s.+?)\s+(?:\w+\s+)?cover\s*$/i);
    if (beforeMatch) return beforeMatch[1].trim();
  }
  return null;
}

/**
 * Split a filename into two parts around the first " - " separator, stripping
 * the extension and any parenthetical version suffixes from both sides.
 * Returns null when no separator is found.
 *
 * Also detects cover-artist hints in brackets so the caller can search for
 * the cover rather than the original.
 */
export function parseFilename(filename: string): FilenameParseResult | null {
  const base = filename.replace(/\.[^.]+$/, '');
  const sep = base.indexOf(' - ');
  if (sep === -1) return null;

  const rawA = base.slice(0, sep);
  const rawB = base.slice(sep + 3);

  // Extract cover artist from brackets BEFORE stripping them.
  const coverArtist = extractCoverArtist(rawB) ?? extractCoverArtist(rawA);

  const clean = (s: string) =>
    s.replace(/\s*[\(\[].*?[\)\]]\s*/g, '').trim() || s.trim();

  const partA = clean(rawA);
  const partB = clean(rawB);

  if (!partA || !partB) return null;
  return { partA, partB, coverArtist };
}

/** First name before comma, &, feat., ft. — used to loosen multi-artist queries. */
export function primaryName(s: string): string {
  return s.split(/\s*[,&]\s*|\s+(?:feat|ft)\.?\s*/i)[0].trim();
}

/** Normalise a string for loose comparison: lowercase, strip punctuation, collapse spaces. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Strip trailing video/live/quality descriptors that appear in YouTube rips
 * and poorly-tagged files. These tokens don't exist on MusicBrainz recordings
 * and cause false "cover detected" results by polluting structured queries.
 *
 * Examples:
 *   "Burning Heart Video"           → "Burning Heart"
 *   "Police and Thieves Live 2001"  → "Police and Thieves"
 *   "Eye of the Tiger HQ"           → "Eye of the Tiger"
 *   "Burning Heart Vide"            → "Burning Heart"  (truncated rip artifact)
 */
export function cleanTitleForSearch(s: string): string {
  return s
    // full phrases first (longest/most specific → applied before single-word pass)
    .replace(/\b(?:official\s+music\s+video|official\s+(?:audio|video)|music\s+video|lyric(?:s?\s+video)?|acoustic\s+version|radio\s+edit)\s*$/i, '')
    // "Live 2001", "Live at Wembley", "Live Version"
    .replace(/\bLive\s+(?:\d{4}|[Vv]ersion\b|[Aa]t\b.*)\s*$/i, '')
    // single-word quality / format tags and common truncation artefacts
    .replace(/\b(?:video|audio|hq|hd|4k|remastered?|re-?mastered?|vide)\s*$/i, '')
    .trim();
}

/**
 * Returns true when an MB artist name can be found inside either filename part.
 * Uses the primary (pre-comma) name so "Vanessa Carlton" still matches "Vanessa Carlton".
 * Used to detect cover recordings: if the original artist is absent from the filename
 * the file is almost certainly a cover version.
 */
export function artistAppearsInFilename(artist: string, partA: string, partB: string): boolean {
  const primary = norm(primaryName(artist));
  if (!primary) return false;
  return norm(partA).includes(primary) || norm(partB).includes(primary);
}

/**
 * Returns true when a MB recording title loosely matches one filename part.
 * Used to determine which filename part is the song title vs the cover artist.
 */
export function titleMatchesPart(title: string, part: string): boolean {
  const t = norm(title);
  const p = norm(part);
  return t === p || t.includes(p) || p.includes(t);
}

/**
 * Given the "artist side" of a filename and the full MB original-artist string,
 * returns any leftover artist name that is NOT already credited in the MB result.
 *
 * Examples:
 *   "Twenty One Two ft. Zara Larsson"  +  "Zara Larsson"         → "twenty one two"
 *   "Luis Fonsi ft. Daddy Yankee"       +  "Luis Fonsi & Daddy Yankee" → null (all accounted for)
 *   "Zara Larsson"                      +  "Zara Larsson"         → null
 *
 * The returned string is normalised (lowercase, no punctuation) — suitable for
 * passing straight to searchMusicBrainz.
 */
export function findExtraCoverArtist(artistSide: string, originalArtist: string): string | null {
  // Split the original artist into individual credited names.
  const creditedNames = norm(originalArtist)
    .split(/\s*[,&]\s*|\s+(?:feat|ft|featuring|vs|x|and)\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);

  // Strip every credited name from the filename artist side.
  let remaining = norm(artistSide);
  for (const name of creditedNames) {
    remaining = remaining.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
  }

  // Remove connector words left behind (ft, feat, x, &, vs …).
  remaining = remaining
    .replace(/\b(?:ft|feat|featuring|vs|x|and|cover|by)\b\.?\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  return remaining.length > 2 ? remaining : null;
}

async function fetchMBResults(query: string, freeText = false): Promise<AcoustIDCandidate[]> {
  const qs = new URLSearchParams({ query, fmt: 'json', limit: '8' });
  const res = await fetch(`${MB_URL}?${qs}`, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`MusicBrainz search error: ${res.status} ${res.statusText}`);

  const data = (await res.json()) as MBResponse;
  const seen = new Set<string>();
  const candidates: AcoustIDCandidate[] = [];

  for (const rec of data.recordings ?? []) {
    if (seen.has(rec.id)) continue;
    seen.add(rec.id);

    const score = (rec.score ?? 0) / 100;
    const recTitle = rec.title ?? null;
    const recArtist =
      rec['artist-credit']
        ?.map((ac) => (ac.artist?.name ?? '') + (ac.joinphrase ?? ''))
        .join('')
        .trim() || null;
    const release = rec.releases?.[0] ?? null;
    const album = release?.title ?? null;
    const year = release?.date ? parseInt(release.date.slice(0, 4), 10) || null : null;

    candidates.push({ acoustid: rec.id, score, title: recTitle, artist: recArtist, album, year, source: 'musicbrainz', fromFreeText: freeText });
  }
  return candidates;
}

/**
 * Search MusicBrainz when the cover artist is known but we don't know which
 * filename part is the song title. Tries every title candidate in a single
 * OR query — no free-text fallback (avoids returning the original artist's
 * recording instead of the cover).
 */
export async function searchMusicBrainzByArtist(
  artist: string,
  titles: string[],
): Promise<AcoustIDCandidate[]> {
  const a = artist.replace(/"/g, '');
  const pA = primaryName(a);

  const clauses: string[] = [];
  for (const title of titles) {
    const t = cleanTitleForSearch(title.replace(/"/g, ''));
    if (!t) continue;
    clauses.push(`(recording:"${t}" AND artist:"${a}")`);
    if (pA !== a) clauses.push(`(recording:"${t}" AND artist:"${pA}")`);
  }
  if (clauses.length === 0) return [];

  const candidates = await fetchMBResults(clauses.join(' OR '));
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 5);
}

/**
 * Free-text MusicBrainz search for filenames with no " - " separator.
 * Always tagged fromFreeText — never auto-applied, picker only.
 */
export async function searchMusicBrainzFreeText(query: string): Promise<AcoustIDCandidate[]> {
  const candidates = await fetchMBResults(query, true);
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 5);
}

/**
 * Search MusicBrainz without assuming which part of the filename is the
 * artist and which is the title. Tries structured queries first, then falls
 * back to free-text so that apostrophes / alternate spellings still match.
 */
export async function searchMusicBrainz(
  partA: string,
  partB: string,
  { freeTextFallback = true }: { freeTextFallback?: boolean } = {},
): Promise<AcoustIDCandidate[]> {
  const a = cleanTitleForSearch(partA.replace(/"/g, ''));
  const b = cleanTitleForSearch(partB.replace(/"/g, ''));
  const pA = primaryName(a); // e.g. "Luis Fonsi" from "Luis Fonsi, Manuel Turizo"
  const pB = primaryName(b);

  // Build a single OR query covering both orderings and primary-artist variants.
  const clauses: string[] = [
    `(recording:"${b}" AND artist:"${a}")`,
    `(recording:"${a}" AND artist:"${b}")`,
  ];
  if (pA !== a) clauses.push(`(recording:"${b}" AND artist:"${pA}")`);
  if (pB !== b) clauses.push(`(recording:"${a}" AND artist:"${pB}")`);

  let candidates = await fetchMBResults(clauses.join(' OR '));

  // Free-text fallback: handles apostrophes, alternate spellings, etc.
  // Results are marked fromFreeText=true so auto-apply is blocked for bulk.
  // Callers can disable this when they control what to do on zero results.
  if (freeTextFallback && candidates.length === 0) {
    await new Promise((r) => setTimeout(r, 1100)); // respect MusicBrainz 1 req/sec limit
    candidates = await fetchMBResults(`${a} ${b}`, true);
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 5);
}

interface MBResponse {
  recordings?: MBRecording[];
}

interface MBRecording {
  id: string;
  score?: number;
  title?: string;
  'artist-credit'?: { artist?: { name: string }; joinphrase?: string }[];
  releases?: { title?: string; date?: string }[];
}
