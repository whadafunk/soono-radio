// Decision 106 — content ownership resolution.
//
// When a segment airs under a show, WHO owns each content type: the show's
// configuration or the clock/segment's? Before this existed there was no
// rule — each content process hardcoded its own answer (branding happened to
// do show??clock for jingles, clock-only for station IDs; music read
// segment.sources with no show awareness while the show's entire
// show_playlists configuration — weights, rotations, tiers — was written by
// the UI and read by nothing).
//
// The doctrine (operator's design, 2026-07-18):
//   - WHOLE-TYPE ownership, never blended: each content type resolves
//     independently to exactly one owner. A show playlist is never weighted
//     against a clock playlist.
//   - Fallback is a feature, not an error: a show that configures no music
//     simply doesn't own music — the segment does. This deletes the
//     "half-configured show" error state entirely and prevents content
//     blind spots (an unfillable segment = empty plan = D94 skip = the
//     segment's nominal injected as early-arrival drift).
//   - Rotations travel with their playlists: show-owned music means the show
//     playlists' own rotation assignments (hot-play cadence and heavy
//     rotation ride with the rotation, D103); on fallback, the segment's
//     sources bring the segment's rotations. No cross-pollination.
//   - Envelopes are level-scoped (segment clips vs show clips), not a
//     fallback pair — resolved where they always were.
//   - Spots, promos, rundowns: owned outside both (campaigns / assignments).
import { asc, eq } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import {
  clocks as clocksTable,
  clockSegments,
  playlists as playlistsTable,
  showPlaylists as showPlaylistsTable,
  shows as showsTable,
  type ClockSegment,
} from '../../db/schema.js';

export interface ResolvedMusicSource {
  playlist_id: number;
  weight: number;
  rotation_id: number | null;
}

export interface ContentOwnership {
  music: { owner: 'show' | 'segment'; sources: ResolvedMusicSource[] };
  jingles: { owner: 'show' | 'clock'; playlist_id: number | null };
  station_ids: { owner: 'show' | 'clock'; playlist_id: number | null };
}

export async function resolveContentOwnership(
  db: typeof defaultDb,
  segment: ClockSegment,
  showId: number | null,
): Promise<ContentOwnership> {
  const [clock] = await db
    .select({
      jingle_playlist_id: clocksTable.jingle_playlist_id,
      station_id_playlist_id: clocksTable.station_id_playlist_id,
    })
    .from(clocksTable)
    .where(eq(clocksTable.id, segment.clock_id));

  const show =
    showId != null
      ? (
          await db
            .select({
              jingle_playlist_id: showsTable.jingle_playlist_id,
              station_id_playlist_id: showsTable.station_id_playlist_id,
            })
            .from(showsTable)
            .where(eq(showsTable.id, showId))
        )[0] ?? null
      : null;

  // Music: the show owns it iff it has at least one MUSIC playlist configured
  // (show_playlists also carries jingle/bed rows — only music playlists make
  // the show a music owner).
  let musicSources: ResolvedMusicSource[] = [];
  let musicOwner: 'show' | 'segment' = 'segment';
  if (showId != null) {
    const showMusic = await db
      .select({
        playlist_id: showPlaylistsTable.playlist_id,
        weight: showPlaylistsTable.weight,
        rotation_id: showPlaylistsTable.rotation_id,
        playlist_type: playlistsTable.type,
      })
      .from(showPlaylistsTable)
      .innerJoin(playlistsTable, eq(playlistsTable.id, showPlaylistsTable.playlist_id))
      .where(eq(showPlaylistsTable.show_id, showId))
      .orderBy(asc(showPlaylistsTable.sort_order));
    const musicRows = showMusic.filter((r) => r.playlist_type === 'music');
    if (musicRows.length > 0) {
      musicOwner = 'show';
      musicSources = musicRows.map((r) => ({
        playlist_id: r.playlist_id,
        weight: r.weight > 0 ? r.weight : 1,
        rotation_id: r.rotation_id ?? null,
      }));
    }
  }
  if (musicOwner === 'segment') {
    musicSources = parseSegmentMusicSources(segment.sources);
  }

  return {
    music: { owner: musicOwner, sources: musicSources },
    jingles:
      show?.jingle_playlist_id != null
        ? { owner: 'show', playlist_id: show.jingle_playlist_id }
        : { owner: 'clock', playlist_id: clock?.jingle_playlist_id ?? null },
    station_ids:
      show?.station_id_playlist_id != null
        ? { owner: 'show', playlist_id: show.station_id_playlist_id }
        : { owner: 'clock', playlist_id: clock?.station_id_playlist_id ?? null },
  };
}

// Segment sources JSON → the same shape show playlists resolve to. Tolerates
// both the drizzle-parsed array (json column mode) and a raw JSON string.
function parseSegmentMusicSources(sourcesJson: unknown): ResolvedMusicSource[] {
  let parsed: unknown = sourcesJson;
  if (typeof sourcesJson === 'string') {
    try {
      parsed = JSON.parse(sourcesJson);
    } catch {
      parsed = [];
    }
  }
  const raw = Array.isArray(parsed) ? parsed : [];
  const out: ResolvedMusicSource[] = [];
  for (const s of raw) {
    if (
      s != null &&
      typeof s === 'object' &&
      (s as { type?: string }).type === 'playlist' &&
      typeof (s as { playlist_id?: unknown }).playlist_id === 'number'
    ) {
      const src = s as { playlist_id: number; weight?: number | null; rotation_id?: number | null };
      out.push({
        playlist_id: src.playlist_id,
        weight: typeof src.weight === 'number' && src.weight > 0 ? src.weight : 1,
        rotation_id: src.rotation_id ?? null,
      });
    }
  }
  return out;
}
