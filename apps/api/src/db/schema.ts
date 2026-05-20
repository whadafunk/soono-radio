import { sqliteTable, text, integer, real, index, unique, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ─── Media ────────────────────────────────────────────────────────────────────

export const MEDIA_CATEGORIES = [
  'music',
  'jingle',
  'showenv',
  'spot',
  'promo',
  'bed',
  'recording',
] as const;
export type MediaCategory = (typeof MEDIA_CATEGORIES)[number];

export const INGEST_STATUSES = [
  'queued',
  'analyzing',
  'transcoding',
  'completed',
  'failed',
] as const;
export type IngestStatus = (typeof INGEST_STATUSES)[number];

export const media = sqliteTable(
  'media',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sha256: text('sha256').notNull().unique(),
    category: text('category', { enum: MEDIA_CATEGORIES }).notNull(),

    title: text('title'),
    artist: text('artist'),
    album: text('album'),
    genre: text('genre'),
    year: integer('year'),
    notes: text('notes'),

    original_filename: text('original_filename').notNull(),
    duration_seconds: real('duration_seconds').notNull(),
    bitrate_kbps: integer('bitrate_kbps').notNull(),
    samplerate_hz: integer('samplerate_hz').notNull(),
    channels: integer('channels').notNull(),
    filesize_bytes: integer('filesize_bytes').notNull(),
    was_transcoded: integer('was_transcoded', { mode: 'boolean' }).notNull(),

    loudness_lufs: real('loudness_lufs'),
    loudness_lra: real('loudness_lra'),
    loudness_peak: real('loudness_peak'),
    loudness_gain_db: real('loudness_gain_db'),
    loudness_warning: text('loudness_warning'),

    cue_in_seconds: real('cue_in_seconds'),
    cue_out_seconds: real('cue_out_seconds'),
    intro_seconds: real('intro_seconds'),
    outro_seconds: real('outro_seconds'),

    bpm: real('bpm'),
    musical_key: text('musical_key'),
    key_scale: text('key_scale'),
    mood_tags: text('mood_tags'),
    energy: real('energy'),
    danceability: real('danceability'),
    analysis_status: text('analysis_status'),
    analysis_error: text('analysis_error'),

    play_count: integer('play_count').notNull().default(0),
    last_played_at: integer('last_played_at', { mode: 'timestamp' }),
    favorite: integer('favorite', { mode: 'boolean' }).notNull().default(false),
    created_at: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updated_at: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    categoryIdx: index('media_category_idx').on(t.category),
    titleIdx: index('media_title_idx').on(t.title),
    artistIdx: index('media_artist_idx').on(t.artist),
    lastPlayedIdx: index('media_last_played_idx').on(t.last_played_at),
    playCountIdx: index('media_play_count_idx').on(t.play_count),
  }),
);

export type Media = typeof media.$inferSelect;
export type MediaInsert = typeof media.$inferInsert;

export const ingestJobs = sqliteTable(
  'ingest_jobs',
  {
    id: text('id').primaryKey(),
    status: text('status', { enum: INGEST_STATUSES }).notNull().default('queued'),

    uploaded_filename: text('uploaded_filename').notNull(),
    uploaded_size_bytes: integer('uploaded_size_bytes').notNull(),
    staging_path: text('staging_path').notNull(),

    category: text('category', { enum: MEDIA_CATEGORIES }).notNull(),
    detected_format: text('detected_format'),
    detected_bitrate: integer('detected_bitrate'),
    needs_transcode: integer('needs_transcode', { mode: 'boolean' }),

    measured_lufs: real('measured_lufs'),
    measured_lra: real('measured_lra'),
    measured_peak: real('measured_peak'),

    media_id: integer('media_id').references(() => media.id, { onDelete: 'set null' }),
    error_message: text('error_message'),

    created_at: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    started_at: integer('started_at', { mode: 'timestamp' }),
    completed_at: integer('completed_at', { mode: 'timestamp' }),
  },
  (t) => ({
    statusIdx: index('ingest_jobs_status_idx').on(t.status),
    createdAtIdx: index('ingest_jobs_created_at_idx').on(t.created_at),
  }),
);

export type IngestJob = typeof ingestJobs.$inferSelect;
export type IngestJobInsert = typeof ingestJobs.$inferInsert;

// ─── Play history ─────────────────────────────────────────────────────────────

export const PLAY_SOURCES = ['auto', 'live', 'manual'] as const;
export type PlaySource = (typeof PLAY_SOURCES)[number];

export const playHistory = sqliteTable(
  'play_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    media_id: integer('media_id').references(() => media.id, { onDelete: 'set null' }),
    source: text('source', { enum: PLAY_SOURCES }).notNull(),
    started_at: integer('started_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    ended_at: integer('ended_at', { mode: 'timestamp' }),
    aborted: integer('aborted', { mode: 'boolean' }).notNull().default(false),
    live_listener_count: integer('live_listener_count'),
    pick_reason: text('pick_reason'),
    // Campaign/promo tracking — set by the stop-set picker (Phase 3).
    // Null for music, jingle, and all non-stop-set plays.
    campaign_id: integer('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    promo_id: integer('promo_id').references(() => promos.id, { onDelete: 'set null' }),
    clock_segment_id: integer('clock_segment_id').references(() => clockSegments.id, { onDelete: 'set null' }),
    // 1-based position within the stop-set (1 = first spot). Null for non-stop-set plays.
    stop_set_position: integer('stop_set_position'),
    // Music-campaign tracking — set by the predictor when a play came from a
    // heavy_rotation-enabled rotation. Null for plays not attributable to a
    // music campaign.
    music_campaign_id: integer('music_campaign_id').references(() => musicCampaigns.id, { onDelete: 'set null' }),
  },
  (t) => ({
    startedAtIdx: index('play_history_started_at_idx').on(t.started_at),
    mediaIdx: index('play_history_media_id_idx').on(t.media_id),
    sourceIdx: index('play_history_source_idx').on(t.source),
    campaignIdx: index('play_history_campaign_idx').on(t.campaign_id),
    musicCampaignIdx: index('play_history_music_campaign_idx').on(t.music_campaign_id),
  }),
);

export type PlayHistory = typeof playHistory.$inferSelect;
export type PlayHistoryInsert = typeof playHistory.$inferInsert;

// ─── Playlists ────────────────────────────────────────────────────────────────

export const PLAYLIST_TYPES = ['music', 'jingle', 'bed', 'spot', 'promo', 'recording'] as const;
export type PlaylistType = (typeof PLAYLIST_TYPES)[number];

export const PLAYLIST_KINDS = ['static', 'dynamic'] as const;
export type PlaylistKind = (typeof PLAYLIST_KINDS)[number];

export const playlists = sqliteTable(
  'playlists',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    description: text('description'),
    type: text('type', { enum: PLAYLIST_TYPES }).notNull(),
    subcategory: text('subcategory'),
    // 'static' = manual track list; 'dynamic' = rules-based query
    kind: text('kind', { enum: PLAYLIST_KINDS }).notNull().default('static'),
    // JSON rules for dynamic playlists: { match: 'all'|'any', conditions: [...] }
    rules: text('rules', { mode: 'json' }),
    // One default per (type, subcategory) — eligible for music/jingle/bed only
    is_default: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    created_at: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updated_at: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    typeIdx: index('playlists_type_idx').on(t.type),
    kindIdx: index('playlists_kind_idx').on(t.kind),
  }),
);

export type Playlist = typeof playlists.$inferSelect;
export type PlaylistInsert = typeof playlists.$inferInsert;

export const playlistMedia = sqliteTable(
  'playlist_media',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    playlist_id: integer('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    media_id: integer('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
    sort_order: integer('sort_order').notNull().default(0),
    weight: integer('weight').notNull().default(1),
  },
  (t) => ({
    playlistIdx: index('playlist_media_playlist_idx').on(t.playlist_id),
    mediaIdx: index('playlist_media_media_idx').on(t.media_id),
    uniqueItem: unique('playlist_media_unique').on(t.playlist_id, t.media_id),
  }),
);

export type PlaylistMedia = typeof playlistMedia.$inferSelect;
export type PlaylistMediaInsert = typeof playlistMedia.$inferInsert;

export const mediaTags = sqliteTable(
  'media_tags',
  {
    media_id: integer('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.media_id, t.tag] }),
    tagIdx: index('media_tags_tag_idx').on(t.tag),
  }),
);

export type MediaTag = typeof mediaTags.$inferSelect;

// ─── Rotations ────────────────────────────────────────────────────────────────

export const ROTATION_TYPES = [
  'random_separation',
  'least_recently_played',
  'round_robin',
  'weighted',
] as const;
export type RotationType = (typeof ROTATION_TYPES)[number];

export const ROTATION_KINDS = ['music', 'sweeper'] as const;
export type RotationKind = (typeof ROTATION_KINDS)[number];

export const SONG_POSITIONS = ['any', 'song_start', 'song_end'] as const;
export type SongPosition = (typeof SONG_POSITIONS)[number];

export const rotations = sqliteTable('rotations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  // 'music' rotations apply to playlist draws; 'sweeper' rotations apply to
  // sweep overlays (clock sweep config). Source pool is derived, not stored.
  kind: text('kind', { enum: ROTATION_KINDS }).notNull().default('music'),
  type: text('type', { enum: ROTATION_TYPES }).notNull(),
  // Sweeper-only: when in the underlying track to fire the overlay
  song_position: text('song_position', { enum: SONG_POSITIONS }),
  // Type-specific params: separation_minutes, artist_separation_minutes,
  // pool_size, order_by, distribution, etc.
  params: text('params', { mode: 'json' }).notNull().default('{}'),
  // One default per kind (music/sweeper)
  is_default: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  // Hot-play injection: when both fields are set, the picker slips one pick
  // from hot_play_playlist_id into the rotation every hot_play_every_n_tracks
  // main picks. Music-kind only. Both null = feature disabled.
  hot_play_playlist_id: integer('hot_play_playlist_id').references(
    () => playlists.id,
    { onDelete: 'set null' },
  ),
  hot_play_every_n_tracks: integer('hot_play_every_n_tracks'),
  // Heavy rotation: when true on a music-kind rotation, the picker consults
  // active music_campaigns and prioritizes the most-behind-pacing campaign's
  // tracks before drawing from this rotation's normal pool.
  heavy_rotation_enabled: integer('heavy_rotation_enabled', { mode: 'boolean' })
    .notNull()
    .default(false),
  created_at: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updated_at: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type Rotation = typeof rotations.$inferSelect;
export type RotationInsert = typeof rotations.$inferInsert;

// ─── Clocks ───────────────────────────────────────────────────────────────────

export const JOIN_POLICIES = ['join_top', 'join_mid'] as const;
export type JoinPolicy = (typeof JOIN_POLICIES)[number];

export const clocks = sqliteTable('clocks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  description: text('description'),
  // Legacy — superseded by per-segment sweeper_config. Kept inert in DB.
  sweep_config: text('sweep_config', { mode: 'json' }),
  // Playlist used as source for station_id sweepers across this clock
  station_id_playlist_id: integer('station_id_playlist_id'),
  // Jingle playlist for unassigned clocks (assigned clocks use show.jingle_playlist_id)
  jingle_playlist_id: integer('jingle_playlist_id'),
  // Handover policy — null means inherit from supervisor config defaults
  // NOTE: overrun_policy and finish_policy columns exist in DB but are no longer used.
  // Cannot drop via libsql migration — left as inert schema drift.
  join_policy: text('join_policy', { enum: JOIN_POLICIES }),
  created_at: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updated_at: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type Clock = typeof clocks.$inferSelect;
export type ClockInsert = typeof clocks.$inferInsert;

// ─── Clock segments ───────────────────────────────────────────────────────────

export const CLOCK_SEGMENT_TYPES = [
  'music',
  'live',
  'stop_set',
  'news',
  'voice_track',
  'bulletin',
] as const;
export type ClockSegmentType = (typeof CLOCK_SEGMENT_TYPES)[number];

export const SEGMENT_SOURCE_TYPES = [
  'show_playlist',   // current show's playlist, optionally filtered by tier
  'show_jingles',    // current show's jingle pool
  'show_beds',       // current show's music bed pool
  'promos',          // station/show promos pool
  'playlist',        // a specific playlist (source_playlist_id required)
  'campaigns',       // campaign spots via the ad algorithm
  'live',            // harbor input
  'recording',       // date-indexed show recording
] as const;
export type SegmentSourceType = (typeof SEGMENT_SOURCE_TYPES)[number];

export const SWEEPER_TYPES = ['commercial', 'promo', 'station_id', 'jingle'] as const;
export type SweeperType = (typeof SWEEPER_TYPES)[number];

export const SILENCE_DETECTION_ACTIONS = [
  'none',
  'switch_to_music',
  'alert',
  'fade_and_switch',
] as const;
export type SilenceDetectionAction = (typeof SILENCE_DETECTION_ACTIONS)[number];

export const clockSegments = sqliteTable(
  'clock_segments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clock_id: integer('clock_id')
      .notNull()
      .references(() => clocks.id, { onDelete: 'cascade' }),
    sort_order: integer('sort_order').notNull().default(0),
    name: text('name').notNull(),
    type: text('type', { enum: CLOCK_SEGMENT_TYPES }).notNull(),
    duration_seconds: integer('duration_seconds').notNull(),

    // ── Sources ──────────────────────────────────────────────────────────────
    // JSON array of { type, [tier], [playlist_id], [weight] } entries.
    // Music: weighted draw across sources. Stop set: combined pool.
    sources: text('sources', { mode: 'json' }).notNull().default('[]'),


    // ── Transition clips ─────────────────────────────────────────────────────
    start_clip_playlist_id: integer('start_clip_playlist_id').references(
      () => playlists.id,
      { onDelete: 'set null' },
    ),
    end_clip_playlist_id: integer('end_clip_playlist_id').references(
      () => playlists.id,
      { onDelete: 'set null' },
    ),
    // Bed audio played under harbor input (live / live_audience segments only)
    bed_playlist_id: integer('bed_playlist_id').references(
      () => playlists.id,
      { onDelete: 'set null' },
    ),
    // Between-track jingles — uses clock.jingle_playlist_id (same source as sweepers)
    interstitial_jingles_enabled: integer('interstitial_jingles_enabled', { mode: 'boolean' }).notNull().default(false),
    // Insert a jingle every N tracks (null = disabled); music segments only
    jingle_every_n_tracks: integer('jingle_every_n_tracks'),
    // Between-track station IDs — uses clock.station_id_playlist_id (same source as sweepers)
    interstitial_station_id_enabled: integer('interstitial_station_id_enabled', { mode: 'boolean' }).notNull().default(false),
    station_id_every_n_tracks: integer('station_id_every_n_tracks'),

    // ── Timing ───────────────────────────────────────────────────────────────
    // { type: 'hard' } | { type: 'flexible', late_seconds: number|null, early_seconds: number|null }
    start_policy: text('start_policy', { mode: 'json' })
      .notNull()
      .default('{"type":"flexible","late_seconds":null,"early_seconds":0}'),
    // NOTE: trailing_time and recovery_tactics columns remain in DB but are no longer used.
    // Superseded by can_skip/can_fill/can_reschedule/catching_up_order/coasting_order below.
    trailing_time: text('trailing_time', { mode: 'json' }).notNull().default('[]'),
    recovery_tactics: text('recovery_tactics', { mode: 'json' }).notNull().default('[]'),
    // End policy flags
    can_skip: integer('can_skip', { mode: 'boolean' }).notNull().default(false),
    can_fill: integer('can_fill', { mode: 'boolean' }).notNull().default(false),
    // Defer the whole segment when too late (voice_track / bulletin only)
    can_reschedule: integer('can_reschedule', { mode: 'boolean' }).notNull().default(false),
    // Ordered event types to skip when catching up; ordered types to fill when coasting
    catching_up_order: text('catching_up_order', { mode: 'json' }).notNull().default('[]'),
    coasting_order: text('coasting_order', { mode: 'json' }).notNull().default('[]'),

    // ── Sweepers & Live ──────────────────────────────────────────────────────
    // Whether the harbor (DJ mic) is open during this segment
    accept_live: integer('accept_live', { mode: 'boolean' }).notNull().default(true),
    // Legacy — superseded by sweeper_config. Kept inert in DB.
    accept_sweepers: text('accept_sweepers', { mode: 'json' }).notNull().default('[]'),
    // Per-segment sweeper distribution: { per_hour, min_gap_minutes, sources[] }
    sweeper_config: text('sweeper_config', { mode: 'json' }),
    // Legacy — superseded by silence_threshold_seconds. Kept inert in DB.
    silence_detection_action: text('silence_detection_action'),
    // Only for live / live_audience: threshold override (null = use global Mix Engine setting)
    silence_threshold_seconds: integer('silence_threshold_seconds'),
    // Simple rotation algorithm for stop_set/live segments
    rotation_type: text('rotation_type'),
    // Fallback playlist for news/bulletin/voice_track when no rundown assignment exists
    fallback_playlist_id: integer('fallback_playlist_id').references(() => playlists.id, { onDelete: 'set null' }),
  },
  (t) => ({
    clockIdx: index('clock_segments_clock_idx').on(t.clock_id),
    sortIdx: index('clock_segments_sort_idx').on(t.clock_id, t.sort_order),
  }),
);

export type ClockSegment = typeof clockSegments.$inferSelect;
export type ClockSegmentInsert = typeof clockSegments.$inferInsert;

// ─── Shows ────────────────────────────────────────────────────────────────────

// What to play when there is no clock assigned to cover part of the show's interval.
// repeat_last_clock: tile the last clock again; fall_through: play content without clock structure.
export const EXTENSION_POLICIES = ['repeat_last_clock', 'fall_through'] as const;
export type ExtensionPolicy = (typeof EXTENSION_POLICIES)[number];

export const SHOW_COLORS = [
  'indigo', 'violet', 'cyan', 'emerald', 'amber', 'rose', 'orange', 'teal',
] as const;
export type ShowColor = (typeof SHOW_COLORS)[number];

export const shows = sqliteTable(
  'shows',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    host: text('host'),
    producer: text('producer'),
    default_clock_id: integer('default_clock_id').references(
      () => clocks.id,
      { onDelete: 'set null' },
    ),
    jingle_playlist_id: integer('jingle_playlist_id').references(
      () => playlists.id,
      { onDelete: 'set null' },
    ),
    bed_playlist_id: integer('bed_playlist_id').references(
      () => playlists.id,
      { onDelete: 'set null' },
    ),
    // One-time lifecycle audio — not part of the clock template
    intro_media_id: integer('intro_media_id').references(
      () => media.id,
      { onDelete: 'set null' },
    ),
    outro_media_id: integer('outro_media_id').references(
      () => media.id,
      { onDelete: 'set null' },
    ),
    duration_minutes: integer('duration_minutes').notNull().default(60),
    // null = station default (repeat_last_clock). See EXTENSION_POLICIES.
    extension_policy: text('extension_policy', { enum: EXTENSION_POLICIES }),
    color: text('color', { enum: SHOW_COLORS }).notNull().default('indigo'),
    notes: text('notes'),
    created_at: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updated_at: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  () => ({}),
);

export type Show = typeof shows.$inferSelect;
export type ShowInsert = typeof shows.$inferInsert;

// ─── Show playlists ───────────────────────────────────────────────────────────

export const showPlaylists = sqliteTable(
  'show_playlists',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    show_id: integer('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    playlist_id: integer('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    // Rotation tier label — null for non-music playlists (jingles, beds, promos)
    rotation_tier: text('rotation_tier'),
    // Rotation algorithm — null means use the global default for this type
    rotation_id: integer('rotation_id').references(() => rotations.id, {
      onDelete: 'set null',
    }),
    // If this tier's playlist is exhausted, try this tier next
    fallback_tier: text('fallback_tier'),
    sort_order: integer('sort_order').notNull().default(0),
    weight: integer('weight').notNull().default(1),
  },
  (t) => ({
    showIdx: index('show_playlists_show_idx').on(t.show_id),
    uniqueShowPlaylist: unique('show_playlists_unique').on(t.show_id, t.playlist_id),
  }),
);

export type ShowPlaylist = typeof showPlaylists.$inferSelect;
export type ShowPlaylistInsert = typeof showPlaylists.$inferInsert;

// ─── Schedule ─────────────────────────────────────────────────────────────────

export const templateEntries = sqliteTable(
  'template_entries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    day_of_week: integer('day_of_week').notNull(), // 1=Mon, 7=Sun
    time_start: text('time_start').notNull(),      // "06:00"
    time_end: text('time_end').notNull(),          // "10:00"
    show_id: integer('show_id'),
    clock_id: integer('clock_id'),
    orphaned_show_name: text('orphaned_show_name'),
    orphaned_clock_name: text('orphaned_clock_name'),
  },
  (t) => ({
    dowIdx: index('template_entries_dow_idx').on(t.day_of_week),
  }),
);

export type TemplateEntry = typeof templateEntries.$inferSelect;
export type TemplateEntryInsert = typeof templateEntries.$inferInsert;

// Per-hour clock override in the weekly template.
// Hours without a record fall back to the show's default clock.
export const templateClockEntries = sqliteTable(
  'template_clock_entries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    day_of_week: integer('day_of_week').notNull(),
    hour: integer('hour').notNull(), // 0–23
    clock_id: integer('clock_id')
      .notNull()
      .references(() => clocks.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    uniqueDowHour: unique('template_clock_entries_dow_hour').on(t.day_of_week, t.hour),
  }),
);

export type TemplateClockEntry = typeof templateClockEntries.$inferSelect;
export type TemplateClockEntryInsert = typeof templateClockEntries.$inferInsert;

export const calendarEntries = sqliteTable(
  'calendar_entries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    date: text('date').notNull(),       // "2026-05-08"
    time_start: text('time_start').notNull(),
    time_end: text('time_end').notNull(),
    show_id: integer('show_id'),
    clock_id: integer('clock_id'),
    orphaned_show_name: text('orphaned_show_name'),
    orphaned_clock_name: text('orphaned_clock_name'),
    is_override: integer('is_override', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => ({
    dateIdx: index('calendar_entries_date_idx').on(t.date),
  }),
);

export type CalendarEntry = typeof calendarEntries.$inferSelect;
export type CalendarEntryInsert = typeof calendarEntries.$inferInsert;

// ─── Users ────────────────────────────────────────────────────────────────────

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  first_name: text('first_name').notNull(),
  last_name: text('last_name').notNull(),
  account_name: text('account_name'),
  email: text('email'),
  title: text('title'),
  created_at: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updated_at: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type User = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;

// ─── Customers ────────────────────────────────────────────────────────────────

export const customers = sqliteTable(
  'customers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    notes: text('notes'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    account_manager_id: integer('account_manager_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    created_at: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updated_at: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    activeIdx: index('customers_active_idx').on(t.active),
  }),
);

export type Customer = typeof customers.$inferSelect;
export type CustomerInsert = typeof customers.$inferInsert;

export const contacts = sqliteTable('contacts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  customer_id: integer('customer_id').references(() => customers.id, {
    onDelete: 'set null',
  }),
  name: text('name').notNull(),
  email: text('email'),
  phone: text('phone'),
  role: text('role'),
  notes: text('notes'),
  created_at: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updated_at: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type Contact = typeof contacts.$inferSelect;
export type ContactInsert = typeof contacts.$inferInsert;

export const customerContacts = sqliteTable(
  'customer_contacts',
  {
    customer_id: integer('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    contact_id: integer('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    is_primary: integer('is_primary', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.customer_id, t.contact_id] }),
  }),
);

export type CustomerContact = typeof customerContacts.$inferSelect;
export type CustomerContactInsert = typeof customerContacts.$inferInsert;

// ─── Broadcast Intervals ──────────────────────────────────────────────────────

export const broadcastIntervals = sqliteTable('broadcast_intervals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  color: text('color').notNull().default('#818cf8'),
  default_start_time: text('default_start_time').notNull().default('06:00'),
  default_end_time: text('default_end_time').notNull().default('09:00'),
  created_at: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updated_at: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type BroadcastInterval = typeof broadcastIntervals.$inferSelect;
export type BroadcastIntervalInsert = typeof broadcastIntervals.$inferInsert;

export const broadcastIntervalSlots = sqliteTable(
  'broadcast_interval_slots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    interval_id: integer('interval_id')
      .notNull()
      .references(() => broadcastIntervals.id, { onDelete: 'cascade' }),
    day_of_week: integer('day_of_week').notNull(), // 1=Mon … 7=Sun
    start_time: text('start_time').notNull(),
    end_time: text('end_time').notNull(),
    created_at: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    uniq: unique('interval_slot_day_uniq').on(t.interval_id, t.day_of_week),
  }),
);

export type BroadcastIntervalSlot = typeof broadcastIntervalSlots.$inferSelect;
export type BroadcastIntervalSlotInsert = typeof broadcastIntervalSlots.$inferInsert;

// ─── Campaigns ────────────────────────────────────────────────────────────────

export const PRIORITY_LEVELS = ['hard', 'best_effort'] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];

export const FIRST_IN_SLOT_MODES = ['always', 'at_least_one', 'at_least_one_shared'] as const;
export type FirstInSlotMode = (typeof FIRST_IN_SLOT_MODES)[number];

export const campaigns = sqliteTable(
  'campaigns',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    customer_id: integer('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    starts_on: text('starts_on').notNull(),       // ISO date "2026-01-01"
    ends_on: text('ends_on').notNull(),
    plays_per_month: integer('plays_per_month').notNull(),
    max_plays_per_day: integer('max_plays_per_day'),
    sweeps_per_month: integer('sweeps_per_month'),
    max_sweeps_per_day: integer('max_sweeps_per_day'),
    time_window_start: text('time_window_start'), // "06:00"
    time_window_end: text('time_window_end'),
    days_of_week: text('days_of_week'),           // comma-separated "1,2,3,4,5"
    advertiser_separation_spots: integer('advertiser_separation_spots')
      .notNull()
      .default(1),
    competing_exclusions: text('competing_exclusions', { mode: 'json' })
      .notNull()
      .default('[]'),
    priority: text('priority', { enum: PRIORITY_LEVELS }).notNull().default('best_effort'),
    show_id: integer('show_id').references(() => shows.id, { onDelete: 'set null' }),
    plays_per_show: integer('plays_per_show'),
    interval_id: integer('interval_id').references(() => broadcastIntervals.id, { onDelete: 'set null' }),
    interval_plays_per_week: integer('interval_plays_per_week'),
    first_in_slot: integer('first_in_slot', { mode: 'boolean' }).notNull().default(false),
    first_in_slot_mode: text('first_in_slot_mode', { enum: FIRST_IN_SLOT_MODES }),
    notes: text('notes'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    created_at: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updated_at: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    customerIdx: index('campaigns_customer_idx').on(t.customer_id),
    activeIdx: index('campaigns_active_idx').on(t.active),
    showIdx: index('campaigns_show_idx').on(t.show_id),
  }),
);

export type Campaign = typeof campaigns.$inferSelect;
export type CampaignInsert = typeof campaigns.$inferInsert;

export const campaignMedia = sqliteTable(
  'campaign_media',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    campaign_id: integer('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    media_id: integer('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
    play_as_spot: integer('play_as_spot', { mode: 'boolean' }).notNull().default(true),
    play_as_sweep: integer('play_as_sweep', { mode: 'boolean' }).notNull().default(false),
    created_at: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    campaignIdx: index('campaign_media_campaign_idx').on(t.campaign_id),
  }),
);

export type CampaignMedia = typeof campaignMedia.$inferSelect;
export type CampaignMediaInsert = typeof campaignMedia.$inferInsert;

// ─── Music campaigns ──────────────────────────────────────────────────────────
//
// Parallel to spot `campaigns` — promotes specific songs (a playlist of
// contracted music) at a per-day target rate within a date interval. Delivered
// during music segments whose rotation has heavy_rotation_enabled = true.
//
// Simpler than spot campaigns: no time windows, advertiser separation, first
// in slot, exclusions, or interval scoping. Only the per-day play count and
// the date interval matter.

export const musicCampaigns = sqliteTable(
  'music_campaigns',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    customer_id: integer('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    playlist_id: integer('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'restrict' }),
    starts_on: text('starts_on').notNull(), // ISO date "2026-01-01"
    ends_on: text('ends_on').notNull(),
    plays_per_day: integer('plays_per_day').notNull(),
    notes: text('notes'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    created_at: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updated_at: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    customerIdx: index('music_campaigns_customer_idx').on(t.customer_id),
    activeIdx: index('music_campaigns_active_idx').on(t.active),
  }),
);

export type MusicCampaign = typeof musicCampaigns.$inferSelect;
export type MusicCampaignInsert = typeof musicCampaigns.$inferInsert;

// ─── Promos ───────────────────────────────────────────────────────────────────

export const promos = sqliteTable(
  'promos',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    show_id: integer('show_id').references(() => shows.id, { onDelete: 'set null' }),
    starts_on: text('starts_on').notNull(),   // ISO date "2026-01-01"
    ends_on: text('ends_on').notNull(),
    min_plays_per_day: integer('min_plays_per_day').notNull().default(1),
    max_plays_per_day: integer('max_plays_per_day').notNull().default(3),
    no_air_during_show: integer('no_air_during_show', { mode: 'boolean' }).notNull().default(false),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    notes: text('notes'),
    created_at: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updated_at: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    showIdx: index('promos_show_idx').on(t.show_id),
    activeIdx: index('promos_active_idx').on(t.active),
  }),
);

export type Promo = typeof promos.$inferSelect;
export type PromoInsert = typeof promos.$inferInsert;

export const promoMedia = sqliteTable(
  'promo_media',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    promo_id: integer('promo_id')
      .notNull()
      .references(() => promos.id, { onDelete: 'cascade' }),
    media_id: integer('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
    created_at: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    promoIdx: index('promo_media_promo_idx').on(t.promo_id),
  }),
);

export type PromoMedia = typeof promoMedia.$inferSelect;
export type PromoMediaInsert = typeof promoMedia.$inferInsert;

// ─── Background jobs ─────────────────────────────────────────────────────────

export const JOB_TYPES = ['lookup_id', 'analyse', 're-transcode'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['running', 'completed', 'review_pending', 'done'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const backgroundJobs = sqliteTable('background_jobs', {
  id: text('id').primaryKey(),
  type: text('type', { enum: JOB_TYPES }).notNull(),
  label: text('label').notNull(),
  status: text('status', { enum: JOB_STATUSES }).notNull().default('running'),
  total: integer('total').notNull().default(0),
  succeeded: integer('succeeded').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  review_pending: integer('review_pending').notNull().default(0),
  results_json: text('results_json'),
  created_at: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  completed_at: integer('completed_at', { mode: 'timestamp' }),
});

export type BackgroundJob = typeof backgroundJobs.$inferSelect;
export type BackgroundJobInsert = typeof backgroundJobs.$inferInsert;

// ─── Recordings (stub — full workflow comes later) ────────────────────────────

export const RECORDING_STATUSES = ['pending', 'ready', 'played'] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

export const recordings = sqliteTable(
  'recordings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    show_id: integer('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    broadcast_date: text('broadcast_date').notNull(), // "2026-05-08"
    media_id: integer('media_id').references(() => media.id, { onDelete: 'set null' }),
    status: text('status', { enum: RECORDING_STATUSES }).notNull().default('pending'),
    created_at: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updated_at: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    showDateIdx: index('recordings_show_date_idx').on(t.show_id, t.broadcast_date),
  }),
);

export type Recording = typeof recordings.$inferSelect;
export type RecordingInsert = typeof recordings.$inferInsert;

// ─── Rundown ──────────────────────────────────────────────────────────────────
// Per-instance content assignments and duration overrides for news/bulletin/
// voice_track segments. Keyed by (date, time_start, clock_id, segment_index)
// to avoid pre-materialising calendar entries for template-derived slots.

export const rundownAssignments = sqliteTable(
  'rundown_assignments',
  {
    id:            integer('id').primaryKey({ autoIncrement: true }),
    date:          text('date').notNull(),           // "2026-05-20"
    time_start:    text('time_start').notNull(),     // "08:00"
    clock_id:      integer('clock_id').notNull().references(() => clocks.id, { onDelete: 'cascade' }),
    segment_index: integer('segment_index').notNull(),
    media_id:      integer('media_id').references(() => media.id, { onDelete: 'set null' }),
    notes:         text('notes'),
    assigned_at:   integer('assigned_at', { mode: 'timestamp' }),
    created_at:    integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updated_at:    integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    slotUniq: unique('rundown_assignments_slot_uniq').on(t.date, t.time_start, t.clock_id, t.segment_index),
    dateIdx:  index('rundown_assignments_date_idx').on(t.date),
  }),
);

export type RundownAssignment = typeof rundownAssignments.$inferSelect;
export type RundownAssignmentInsert = typeof rundownAssignments.$inferInsert;

export const rundownDurationOverrides = sqliteTable(
  'rundown_duration_overrides',
  {
    id:               integer('id').primaryKey({ autoIncrement: true }),
    date:             text('date').notNull(),
    time_start:       text('time_start').notNull(),
    clock_id:         integer('clock_id').notNull().references(() => clocks.id, { onDelete: 'cascade' }),
    segment_index:    integer('segment_index').notNull(),
    duration_seconds: integer('duration_seconds').notNull(),
    created_at:       integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updated_at:       integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    slotUniq: unique('rundown_duration_overrides_slot_uniq').on(t.date, t.time_start, t.clock_id, t.segment_index),
  }),
);

export type RundownDurationOverride = typeof rundownDurationOverrides.$inferSelect;
export type RundownDurationOverrideInsert = typeof rundownDurationOverrides.$inferInsert;
