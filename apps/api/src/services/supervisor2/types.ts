// Candidate pool types returned by the four content processes to the Planner.
//
// All `id` fields are unique within the response pool they appear in — the
// Planner uses them as the addressable handle when sending CONFIRM_USED,
// RETURN_UNUSED, and DROP_COMMITTED back to the content process. Most pools
// derive `id` from `media_id`, but the protocol does not require that — the
// content process is free to mint synthetic ids if it returns the same media
// in multiple slots (e.g. the same jingle as both an interstitial candidate
// and a coasting-fill candidate).

// ─── Music ────────────────────────────────────────────────────────────────────

export type MusicCandidateSource = 'rotation' | 'hot_play' | 'heavy_rotation';

export interface MusicCandidate {
  // Unique handle within this response. Generated from media_id by default
  // but the content process owns the namespace.
  id: number;
  media_id: number;
  // Effective duration: cue_out - cue_in when both are set, else media.duration_seconds.
  // The Planner uses this when summing the segment fill.
  duration_seconds: number;
  source: MusicCandidateSource;
  rotation_id: number;
  // Set only when source = 'heavy_rotation'.
  music_campaign_id?: number;
  // Set only when source = 'heavy_rotation' — urgency, where higher means more
  // behind the pacing target. Range [0, 1+]: 0 = on/ahead of target, 1 = no
  // plays yet today against a target ≥ 1.
  pacing_score?: number;
  // Free-form reason hint propagated into plan_items.reason for audit.
  reason_hint: string;
}

export interface MusicCandidatePool {
  candidates: MusicCandidate[];
  total_duration_seconds: number;
  // Hot-play cadence (D103). Present when a source has hot-play configured:
  // the assembly places a hot_play-tagged candidate after every N ordinary
  // rotation tracks; current_streak carries the play-history streak in, so
  // due-ness spans segment boundaries (a hot-play that missed its segment is
  // still owed in the next one).
  hot_play_every_n_tracks?: number | null;
  hot_play_current_streak?: number;
}

// ─── Campaigns / promos (stop-set) ────────────────────────────────────────────

export interface SpotCandidate {
  media_id: number;
  duration_seconds: number;
  campaign_id: number;
  // D96 weighted rotation: pick = lowest delivered ÷ weight among fitting
  // spots. Pool excludes weight-0 (benched) spots outright.
  weight: number;
  delivered: number;
}

export type PositionConstraint = 'any' | 'slot_1_required' | 'slot_1_preferred';

export interface CampaignCandidate {
  // Unique handle within this response. Derived from campaign_id.
  id: number;
  campaign_id: number;
  customer_id: number;
  name: string;
  // Urgency — higher means more behind the pacing target. Computed as the
  // worst of global / per-show / per-interval pacing deltas.
  pacing_score: number;
  position_constraint: PositionConstraint;
  // Whether this campaign already aired in slot 1 today.
  slot_1_satisfied_today: boolean;
  // campaign_ids that must be excluded from the same break once this one
  // is placed (bidirectional, applied by the Planner).
  competing_exclusions: number[];
  // Minimum spots between two spots from the same customer_id in this break.
  advertiser_separation_spots: number;
  // Spots whose effective duration fits the break.
  spot_pool: SpotCandidate[];
  // Significantly behind pacing (D96: was also gated on hard priority
  // before the priority field was dropped). The Planner must place
  // these unless competing constraints make it impossible.
  mandatory: boolean;
}

export interface PromoCandidate {
  // Unique handle within this response. Derived from promo_id.
  id: number;
  promo_id: number;
  media_id: number;
  duration_seconds: number;
  // Higher = more behind the daily min target.
  pacing_score: number;
}

export interface BreakSpaceEstimate {
  break_duration_seconds: number;
  // Sum of minimum spot durations for mandatory campaigns.
  hard_claimed_seconds: number;
  // Sum of average spot durations for best-effort campaigns.
  contested_seconds: number;
  // Likely available for promos and fillers after both above.
  free_seconds: number;
  // (hard_claimed + contested) / break_duration. Clamped at 1 in practice.
  occupation_ratio: number;
  // occupation_ratio > 0.90 — inventory warning, not a refusal to plan.
  oversubscribed: boolean;
  // Eligible campaign count for visibility into UI inventory dashboards.
  candidate_count: number;
}

// D96: Decision 75's recovery_multiplier is retired — breaks stay
// nominal-sized; catch-up redistributes plays across days (quota pacing)
// and may displace promos inside breaks, never stretch them.
export interface StopSetCandidatePool {
  candidates: CampaignCandidate[];
  promos: PromoCandidate[];
  space_estimate: BreakSpaceEstimate;
}

// ─── Branding ─────────────────────────────────────────────────────────────────

export type BrandingContentSubtype =
  | 'jingle'
  | 'station_id'
  | 'segment_start'
  | 'segment_end'
  | 'show_start'
  | 'show_end';

export interface BrandingCandidate {
  // Unique handle within this response.
  id: number;
  media_id: number;
  duration_seconds: number;
  content_subtype: BrandingContentSubtype;
  // The playlist this candidate was drawn from. 0 indicates the candidate
  // came from a single-media source (show.intro_media_id / outro_media_id),
  // not a playlist.
  playlist_id: number;
}

export interface BrandingCandidatePool {
  jingles: BrandingCandidate[];
  station_ids: BrandingCandidate[];
  // Single picks for envelope positions. Undefined when no playlist is
  // configured for that position or the playlist is empty.
  segment_start?: BrandingCandidate;
  segment_end?: BrandingCandidate;
  show_start?: BrandingCandidate;
  show_end?: BrandingCandidate;
}

// ─── Rundown ──────────────────────────────────────────────────────────────────

export interface RundownItem {
  // Unique handle within this response.
  id: number;
  media_id: number;
  // Position within the rundown segment (0-based), as assigned by the operator.
  position: number;
  duration_seconds: number;
}

export interface RundownCandidatePool {
  // Ordered list — mandatory, not subject to reorder by the Planner.
  items: RundownItem[];
  total_duration_seconds: number;
  // segment_duration - total_duration. The Planner is responsible for filling
  // this gap using the segment's normal coasting_order.
  gap_estimate_seconds: number;
}
