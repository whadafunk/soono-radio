import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const MEDIA_CATEGORIES = [
  'music',
  'jingle',
  'ad',
  'intro',
  'promo',
  'voice',
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

    // Display metadata — operator-editable.
    title: text('title'),
    artist: text('artist'),
    album: text('album'),
    genre: text('genre'),
    year: integer('year'),
    notes: text('notes'),

    // Technical metadata — set at ingest, treated as immutable.
    original_filename: text('original_filename').notNull(),
    duration_seconds: real('duration_seconds').notNull(),
    bitrate_kbps: integer('bitrate_kbps').notNull(),
    samplerate_hz: integer('samplerate_hz').notNull(),
    channels: integer('channels').notNull(),
    filesize_bytes: integer('filesize_bytes').notNull(),
    was_transcoded: integer('was_transcoded', { mode: 'boolean' }).notNull(),

    // Loudness — measured at ingest, gain applied at playout (ReplayGain-style).
    loudness_lufs: real('loudness_lufs'),
    loudness_lra: real('loudness_lra'),
    loudness_peak: real('loudness_peak'),
    loudness_gain_db: real('loudness_gain_db'),
    loudness_warning: text('loudness_warning'),

    // Cue points — placeholder columns; editing arrives in Phase 4.
    cue_in_seconds: real('cue_in_seconds'),
    cue_out_seconds: real('cue_out_seconds'),
    intro_seconds: real('intro_seconds'),
    outro_seconds: real('outro_seconds'),

    // Bookkeeping.
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
  },
  (t) => ({
    startedAtIdx: index('play_history_started_at_idx').on(t.started_at),
    mediaIdx: index('play_history_media_id_idx').on(t.media_id),
    sourceIdx: index('play_history_source_idx').on(t.source),
  }),
);

export type PlayHistory = typeof playHistory.$inferSelect;
export type PlayHistoryInsert = typeof playHistory.$inferInsert;
