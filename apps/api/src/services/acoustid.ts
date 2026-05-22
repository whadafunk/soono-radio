import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { media } from '../db/schema.js';
import { mediaPathForSha } from './ingest/paths.js';
import { runFpcalc } from './ingest/fpcalc.js';
import { getIntegrationsConfig } from './integrations/config.js';
import { parseFilename, searchMusicBrainz, searchMusicBrainzByArtist, searchMusicBrainzFreeText, artistAppearsInFilename, titleMatchesPart, findExtraCoverArtist } from './musicbrainz.js';

const ACOUSTID_URL = 'https://api.acoustid.org/v2/lookup';

function getAcoustIDClient(): string {
  return process.env.ACOUSTID_API_KEY || getIntegrationsConfig().acoustid_api_key;
}


export interface AcoustIDCandidate {
  acoustid: string;
  score: number;
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  /** acoustid  — matched by fingerprint
   *  musicbrainz — matched by text search
   *  filename    — synthesised from filename when cover detected but not in MB */
  source: 'acoustid' | 'musicbrainz' | 'filename';
  /** True when the result came from the free-text MusicBrainz fallback rather
   *  than the structured artist+title query. Free-text results score on token
   *  overlap so they can produce plausible-looking but wrong matches (e.g.
   *  "You Can't Rock me" for "Kid Rock - Until You Can't"). Never auto-apply. */
  fromFreeText?: boolean;
}

function synthesisCandidate(title: string, artist: string): AcoustIDCandidate {
  return { acoustid: 'filename', score: 0, title, artist, album: null, year: null, source: 'filename' };
}

export async function identifyMedia(id: number): Promise<AcoustIDCandidate[]> {
  const rows = await db.select().from(media).where(eq(media.id, id)).limit(1);
  if (rows.length === 0) throw new Error(`Media ${id} not found`);
  const row = rows[0];
  const path = mediaPathForSha(row.sha256);

  const { fingerprint, duration } = await runFpcalc(path);

  const client = getAcoustIDClient();
  if (!client) throw new Error('AcoustID API key not configured — set it in Settings → Integrations');

  // Build query string manually: the meta separator must be a literal '+' sign.
  // URLSearchParams would encode '+' as '%2B which is correct, but encoding
  // spaces as '+' (form-encoding) would be decoded back to spaces by the server.
  const qs = new URLSearchParams({ client, fingerprint, duration: String(duration) });
  const url = `${ACOUSTID_URL}?${qs}&meta=recordings%2Breleasegroups%2Breleases`;

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`AcoustID API error: ${res.status} — ${body}`);
  }

  const data = (await res.json()) as AcoustIDResponse;
  if (data.status !== 'ok') {
    const msg = (data as any).error?.message ?? data.status;
    throw new Error(`AcoustID error: ${msg}`);
  }

  const candidates: AcoustIDCandidate[] = [];

  for (const result of data.results ?? []) {
    const score = result.score ?? 0;
    const recordings = result.recordings ?? [];

    if (recordings.length === 0) {
      candidates.push({ acoustid: result.id, score, title: null, artist: null, album: null, year: null, source: 'acoustid' });
      continue;
    }

    for (const rec of recordings) {
      const title = rec.title ?? null;
      const artist = rec.artists?.[0]?.name ?? null;

      const rgs = rec.releasegroups ?? [];
      const rg = rgs.find((r) => r.type === 'Album') ?? rgs[0] ?? null;
      const album = rg?.title ?? null;

      let year: number | null = null;
      for (const release of rg?.releases ?? []) {
        const y = release.date?.year;
        if (y && (!year || y < year)) year = y;
      }

      candidates.push({ acoustid: result.id, score, title, artist, album, year, source: 'acoustid' });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  // Fall back to MusicBrainz when fingerprint returned nothing useful.
  // "Nothing useful" means either no results at all, or only null-title entries
  // (AcoustID recognised the fingerprint but has no recording metadata for it).
  const hasUsefulMatch = candidates.some((c) => c.title !== null);
  if (!hasUsefulMatch) {
    const parsed = parseFilename(row.original_filename);
    if (parsed) {
      if (parsed.coverArtist) {
        // Explicit cover artist from brackets — we don't know which filename part
        // is the title, so try both as candidates in a single query.
        const mbResults = await searchMusicBrainzByArtist(parsed.coverArtist, [parsed.partA, parsed.partB]);
        if (mbResults.length > 0) return mbResults;
        // Cover not found in MusicBrainz — synthesise from both orderings so the
        // operator can pick the correct title in the picker.
        return [
          synthesisCandidate(parsed.partA, parsed.coverArtist),
          synthesisCandidate(parsed.partB, parsed.coverArtist),
        ];
      }

      // Standard search: try both orderings + primary-artist variants + free-text.
      const mbResults = await searchMusicBrainz(parsed.partA, parsed.partB);

      if (mbResults.length > 0) {
        const top = mbResults[0];

        // Work out which filename part is the song title and which is the "artist side".
        const titleIsPartB = top.title ? titleMatchesPart(top.title, parsed.partB) : true;
        const [artistSide, titleSide] = titleIsPartB
          ? [parsed.partA, parsed.partB]
          : [parsed.partB, parsed.partA];

        if (top.artist && artistAppearsInFilename(top.artist, parsed.partA, parsed.partB)) {
          // Original artist IS in the filename.
          // Check whether there is *extra* artist content not already credited in the
          // MB result — e.g. "Twenty One Two ft. Zara Larsson" where the MB result
          // only credits Zara Larsson.  That leftover is a likely cover artist.
          const extraArtist = findExtraCoverArtist(artistSide, top.artist);
          if (extraArtist) {
            await new Promise((r) => setTimeout(r, 1100));
            const coverResults = await searchMusicBrainz(extraArtist, titleSide, { freeTextFallback: false });
            if (coverResults.length > 0) return coverResults;
            return [synthesisCandidate(titleSide, extraArtist)];
          }
          // All filename artists are accounted for — genuine match.
          return mbResults;
        }

        // Original artist is entirely absent from the filename → cover.
        // Try a targeted structured search with the filename's artist side.
        await new Promise((r) => setTimeout(r, 1100));
        const coverResults = await searchMusicBrainz(artistSide, titleSide, { freeTextFallback: false });
        if (coverResults.length > 0) return coverResults;
        return [synthesisCandidate(titleSide, artistSide)];
      }

      return [];
    }

    // Filename has no " - " separator (e.g. "Focus (feat. DJ Quik & Xzibit).mp3").
    // Try a free-text MusicBrainz search on the bare filename as a last resort.
    // Results are tagged fromFreeText so they never auto-apply — picker only.
    const base = row.original_filename.replace(/\.[^.]+$/, '').replace(/\s*[\(\[].*?[\)\]]\s*/g, ' ').trim();
    if (base.length > 2) {
      const freeResults = await searchMusicBrainzFreeText(base);
      return freeResults;
    }
  }

  // Strip null-title entries — they carry no metadata worth applying or displaying.
  // If that empties the list the MB fallback already ran above, so return as-is.
  return candidates.filter((c) => c.title !== null);
}

export function isAutoApply(
  candidates: AcoustIDCandidate[],
  { allowMusicBrainz = false }: { allowMusicBrainz?: boolean } = {},
): boolean {
  if (candidates.length === 0) return false;
  const top = candidates[0];
  if (top.source === 'filename') return false; // synthesised from filename, always needs human review
  if (top.source === 'musicbrainz') {
    // Free-text results are unreliable for auto-apply — token overlap can match
    // completely wrong songs (e.g. "You Can't Rock me" for "Kid Rock - Until You Can't").
    if (top.fromFreeText) return false;
    // Structured MusicBrainz results: auto-apply in bulk if confidence is high.
    return allowMusicBrainz && top.score >= 0.80;
  }
  const { acoustid_min_score, acoustid_min_gap } = getIntegrationsConfig();
  if (top.score < acoustid_min_score) return false;
  if (candidates.length === 1) return true;
  return top.score - candidates[1].score >= acoustid_min_gap;
}

export interface IngestIdentificationResult {
  outcome: 'applied' | 'skipped' | 'failed';
  filename: string;
  /** Present when outcome === 'applied' */
  appliedCandidate?: { title: string | null; artist: string | null; album: string | null; year: number | null; score: number };
  /** Present when outcome === 'skipped' */
  reason?: string;
  candidates?: Pick<AcoustIDCandidate, 'acoustid' | 'score' | 'title' | 'artist' | 'album' | 'year' | 'source' | 'fromFreeText'>[];
  /** Present when outcome === 'failed' */
  error?: string;
}

/**
 * Run identification for a single track and return a structured result.
 * Applies metadata immediately when the match clears the auto-apply threshold.
 * Used by the ingest worker to feed per-file outcomes into the batch lookup job.
 */
export async function identifyForIngest(mediaId: number, filename: string): Promise<IngestIdentificationResult> {
  try {
    const candidates = await identifyMedia(mediaId);
    if (candidates.length === 0 || !isAutoApply(candidates, { allowMusicBrainz: true })) {
      let reason: string;
      if (candidates.length === 0) {
        reason = 'No matches found';
      } else if (candidates[0].source === 'filename') {
        reason = 'Cover detected — not in MusicBrainz. Use per-track Lookup ID to apply.';
      } else if (candidates[0].source === 'musicbrainz' && candidates[0].fromFreeText) {
        reason = 'Loose text match only — cannot auto-apply. Use per-track Lookup ID to verify.';
      } else if (candidates[0].source === 'musicbrainz') {
        reason = `Filename search — low confidence (${Math.round(candidates[0].score * 100)}%). Use per-track Lookup ID to pick manually.`;
      } else {
        reason = `Low confidence (${Math.round(candidates[0].score * 100)}%)`;
      }
      return {
        outcome: 'skipped',
        filename,
        reason,
        candidates: candidates.map((c) => ({
          acoustid: c.acoustid, score: c.score, title: c.title, artist: c.artist,
          album: c.album, year: c.year, source: c.source, fromFreeText: c.fromFreeText,
        })),
      };
    }
    const top = candidates[0];
    await db.update(media).set({
      title: top.title,
      artist: top.artist,
      album: top.album,
      year: top.year,
      notes: sql`COALESCE(${media.notes}, ${media.original_filename})`,
      updated_at: new Date(),
    }).where(eq(media.id, mediaId));
    return {
      outcome: 'applied',
      filename,
      appliedCandidate: { title: top.title, artist: top.artist, album: top.album, year: top.year, score: top.score },
    };
  } catch (err) {
    return { outcome: 'failed', filename, error: (err as Error).message };
  }
}

// Raw AcoustID API response types
interface AcoustIDResponse {
  status: string;
  results?: AcoustIDResult[];
}

interface AcoustIDResult {
  id: string;
  score: number;
  recordings?: AcoustIDRecording[];
}

interface AcoustIDRecording {
  id: string;
  title?: string;
  artists?: { id: string; name: string }[];
  releasegroups?: {
    id: string;
    title: string;
    type?: string;
    releases?: { date?: { year?: number; month?: number; day?: number } }[];
  }[];
}
