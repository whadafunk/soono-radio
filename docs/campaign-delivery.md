# Campaign & Promo Delivery — Implementation Design

This document covers the **runtime delivery algorithm** for campaigns and promos: how the supervisor decides what goes into a stop-set, how it tracks delivery against targets, and how it enforces all campaign constraints. It is the detailed design for Phases 1–4 of the scheduler implementation.

**Pre-reading:** `docs/scheduling.md` (clock/segment model, supervisor architecture) and `docs/campaigns.md` (campaign entity fields). This document assumes familiarity with both.

---

## Mental Model

The clock segment is the central piece. Two contexts are possible when a segment fires:

**Show-driven context** — a calendar or template entry brought a Show into scope. The segment draws:
- Songs → from the show's tier playlists (hot/medium/cold), not from segment config
- Jingles → from the show's jingle pool
- Beds → from the show's bed pool
- Show-specific campaigns → campaigns with `show_id = current_show.id`

**Standalone context** — no show. The segment draws from its own `sources[]` config.

Campaigns and promos are **external constraints** imposed on top of whichever content context is active. They don't come from the show and don't come from the segment's `sources[]`. The stop-set segment says "I have 3 minutes of ad time" — the campaign/promo delivery system decides what fills it.

**Key distinction:** Promos have no delivery target. They are pure filler — squeezed in after all campaign spots are placed, using whatever time remains in the stop-set. If no time remains, no promo airs. No promo deficit is tracked.

---

## The Capacity Model

### Total stop-set airtime

For each day of the week, the weekly schedule template resolves to a series of clocks. Each clock may contain one or more `stop_set` segments. Summing them gives:

```
total_slots[DOW]   = number of stop_set segments that fire on that day
total_seconds[DOW] = sum of their duration_seconds
```

**Implemented:** `apps/api/src/services/supervisor/capacity.ts` — `computeWeeklyCapacity()`.  
**API endpoint:** `GET /supervisor/capacity` → `{ by_dow: DayCapacity[], by_interval: IntervalCapacity[] }`.

### Interval-scoped capacity

A campaign may have `interval_id` set, restricting it to a broadcast interval (e.g. "Morning Drive 6–9am weekdays"). For that campaign, only stop-sets that fall within the interval's time windows are eligible.

`computeWeeklyCapacity()` also computes `by_interval[]` — the same slot count and seconds breakdown for each `broadcastInterval`, by intersecting the clock schedule with the interval's `broadcastIntervalSlots`.

### What capacity is used for

1. **Over-booking detection** — if `sum(campaign plays_per_day)` across all campaigns > `total_slots[DOW]`, some campaigns will necessarily miss their target.
2. **First-in-slot feasibility** — a campaign with `first_in_slot_mode = 'always'` can only air once per stop-set (at position 1). If its `plays_per_day` target exceeds `total_slots[DOW]`, the constraint is structurally unsatisfiable. Flag this as a configuration error.
3. **Planning** — the capacity endpoint is meant to be shown in the operator dashboard so they can see whether the schedule has enough ad inventory.

---

## Play History Tracking

### Schema additions (migration 0029)

Four new nullable columns on `play_history`:

| Column | Type | Purpose |
|--------|------|---------|
| `campaign_id` | int FK → campaigns | Which campaign this spot belongs to |
| `promo_id` | int FK → promos | Which promo this play belongs to |
| `clock_segment_id` | int FK → clock_segments | Which segment was active |
| `stop_set_position` | int | 1-based position within the stop-set; null for non-stop-set plays |

All four are null for music, jingle, and any non-stop-set play. The stop-set picker (Phase 3) sets them.

### Why these columns are the foundation

Everything in Phase 2 and 3 queries play_history with these columns:

```sql
-- plays this campaign has aired today
SELECT count(*) FROM play_history
WHERE campaign_id = ? AND started_at >= <today_start> AND aborted = false;

-- has this campaign had a first-in-slot play today?
SELECT count(*) FROM play_history
WHERE campaign_id = ? AND stop_set_position = 1 AND started_at >= <today_start> AND aborted = false;

-- plays this week (for interval_plays_per_week cap)
SELECT count(*) FROM play_history
WHERE campaign_id = ? AND started_at >= <week_start> AND aborted = false;
```

`recordPushed()` in `playHistory.ts` already accepts all four as optional args. Existing callers pass nothing — all default to null.

---

## Campaign Eligibility

A campaign is eligible for a stop-set if ALL of the following hold:

| Check | Schema field | Logic |
|-------|-------------|-------|
| Active | `campaigns.active` | `= true` |
| Date range | `starts_on`, `ends_on` | today is within [starts_on, ends_on] |
| Time window | `time_window_start`, `time_window_end` | current time is within window (null = any time) |
| Day of week | `days_of_week` | today's DOW is in the comma-separated list (null = any day) |
| Daily cap | `max_plays_per_day` | `plays_today < max_plays_per_day` (null = no cap) |
| Interval cap | `interval_plays_per_week` | plays this week within this interval < cap (null = no cap) |
| Show scope | `show_id` | null (all shows) OR matches current show |

**Pacing** is not an eligibility filter — it's a sort-order modifier applied after the eligible set is built.

---

## Pacing

```
pacing_ratio = plays_to_date / (plays_per_month * elapsed_days / days_in_month)
```

Where `plays_to_date` = plays this month from play_history, `elapsed_days` = today's day-of-month.

| Ratio | Interpretation | Priority boost |
|-------|---------------|----------------|
| < 0.8 | Under-pacing | +2 |
| 0.8–1.2 | On track | 0 |
| > 1.2 | Over-pacing | −1 (deprioritise but don't suppress) |

`hard` priority campaigns get an additional +10 boost on top of pacing, ensuring they always sort above `best_effort` campaigns regardless of pacing.

---

## First-in-Slot

### Two modes (only two — `at_least_one_shared` is dropped as redundant)

**`first_in_slot: true, first_in_slot_mode: 'always'`**  
Every play of this campaign must be at `stop_set_position = 1`. If position 1 is already claimed in a given stop-set, this campaign **skips that stop-set entirely** — it does not air at a later position.

**`first_in_slot: true, first_in_slot_mode: 'at_least_one'`**  
This campaign must air at position 1 at least once today. After it has had one position-1 play, it can fill any position in subsequent stop-sets.

**`first_in_slot: false`**  
No constraint — campaign can air at any position.

### Interaction in the picker

```
For each stop-set:

  1. Identify position-1 candidates:
       - 'always' campaigns that are eligible
       - 'at_least_one' campaigns that haven't had a position-1 play today

  2. If both types compete for position 1:
       'always' wins (it has no fallback position).
       The losing 'at_least_one' campaign waits for the next stop-set.

  3. Fill positions 2, 3, … with all other eligible campaigns
     ('always' campaigns that already got position 1 in an earlier stop-set
      this day are blocked — they can only air once per stop-set at position 1,
      so if this stop-set's position 1 is taken by another campaign, they skip).
```

### Feasibility check (capacity calculator)

If an `'always'` campaign's implied `plays_per_day` exceeds `total_slots[DOW]`, it is impossible to satisfy — every play would need position 1, but there are fewer stop-sets than required plays. This should be surfaced as a warning in the capacity API response.

---

## Non-Concurrency (competing_exclusions)

`campaigns.competing_exclusions` is a JSON array of campaign IDs that cannot air in the same stop-set. The field is bidirectionally synced by the API.

**At pick time (reactive):** Once campaign A is selected for a stop-set, all campaigns in `A.competing_exclusions` are removed from the candidate pool for the remaining positions in that stop-set.

**No proactive slot reservation** — the picker does not pre-assign slots to conflicting campaigns across stop-sets. It simply reacts per stop-set.

**Capacity planning note** (not enforced by picker, used for operator warnings only):

```
effective_slots_for_A[DOW] = total_slots[DOW]
  - expected_daily_plays_of_campaigns_that_exclude_A_and_have_higher_priority
```

If this is negative, A and its competitors are over-booked relative to available slots. Surface as a warning from the capacity endpoint.

---

## Advertiser Separation

`campaigns.advertiser_separation_spots` — minimum number of other spots that must air between two spots from the same advertiser (i.e. from any campaign belonging to the same `customer_id`).

Enforced at pick time: before adding campaign X to a stop-set, check whether any already-selected spot in this stop-set belongs to the same customer. If yes, and if the inter-spot gap is less than `advertiser_separation_spots`, skip X.

Note: separation is scoped to the current stop-set, not across stop-sets. Cross-stop-set separation is not tracked.

---

## Promo Delivery

Promos have no target — they are filler. After all campaign spots have been placed in a stop-set:

1. Compute remaining time: `remaining = segment.duration_seconds - sum(selected_spot_durations)`
2. Gather eligible promos: `active = true`, today within `[starts_on, ends_on]`, `plays_today < max_plays_per_day`
3. If current show is set AND `promo.no_air_during_show = true` AND `promo.show_id = current_show.id` → exclude that promo
4. Sort promos: those below `min_plays_per_day` first (need-to-air), then by least-recently-played
5. Greedily fill: pick promos whose duration fits in remaining time, subtract, repeat until nothing fits

Promos that can't fit are skipped silently. There is no "missed promo" tracking.

---

## The Stop-Set Picker Algorithm (Phase 3)

Input: `(segment: ClockSegment, now: Date, currentShow: Show | null)`  
Output: `Array<{ media_id, campaign_id?, promo_id?, stop_set_position, duration_seconds }>`

```
remaining_seconds  = segment.duration_seconds
selected           = []                      // growing list of (media, campaign, position)
selected_campaigns = new Set<number>()       // campaign_ids already chosen this stop-set
excluded_campaigns = new Set<number>()       // from competing_exclusions

// ── Step 1: Gather eligible campaigns ───────────────────────────────────────

eligible = getCampaignEligibility(now, currentShow)
  // returns active campaigns that pass all eligibility checks above

// ── Step 2: Compute pacing boosts ──────────────────────────────────────────

for each campaign in eligible:
  campaign.sort_score = pacingBoost(campaign) + (campaign.priority === 'hard' ? 10 : 0)

// ── Step 3: Determine position-1 candidates ─────────────────────────────────

position1_always   = eligible.filter(c => c.first_in_slot && c.first_in_slot_mode === 'always')
position1_atleast  = eligible.filter(c =>
  c.first_in_slot && c.first_in_slot_mode === 'at_least_one' && !hasPositon1PlayToday(c)
)
position1_candidates = [...position1_always, ...position1_atleast]
  .sort by sort_score desc

// ── Step 4: Fill positions ──────────────────────────────────────────────────

position = 1

// 4a. Place position-1 winner (if any)
if position1_candidates.length > 0:
  winner = position1_candidates[0]
  spot = pickSpot(winner)          // pick a campaign_media (play_as_spot=true) using LRP
  if spot.duration_seconds <= remaining_seconds:
    selected.push({ ...spot, position })
    selected_campaigns.add(winner.id)
    excluded_campaigns.addAll(winner.competing_exclusions)
    remaining_seconds -= spot.duration_seconds
    position++

// 4b. Fill remaining positions
non_first = eligible
  .filter(c =>
    !selected_campaigns.has(c.id) &&
    !excluded_campaigns.has(c.id) &&
    // 'always' campaigns that didn't win position 1 are blocked for this stop-set
    !(c.first_in_slot && c.first_in_slot_mode === 'always')
  )
  .sort by sort_score desc

for each campaign in non_first:
  if remaining_seconds < MIN_SPOT_DURATION: break     // nothing will fit
  if excluded_campaigns.has(campaign.id): continue
  spot = pickSpot(campaign)
  if spot.duration_seconds > remaining_seconds: continue   // look-ahead: won't fit
  selected.push({ ...spot, position })
  selected_campaigns.add(campaign.id)
  excluded_campaigns.addAll(campaign.competing_exclusions)
  remaining_seconds -= spot.duration_seconds
  position++

// ── Step 5: Fill remaining time with promos ─────────────────────────────────

promos = getEligiblePromos(now, currentShow)
  .sort(needsMinPlaysToday desc, lastPlayedAt asc)
for each promo in promos:
  if remaining_seconds < MIN_PROMO_DURATION: break
  spot = pickPromoMedia(promo)
  if spot.duration_seconds > remaining_seconds: continue
  selected.push({ ...spot, position, promo_id: promo.id })
  remaining_seconds -= spot.duration_seconds
  position++

return selected
```

`MIN_SPOT_DURATION` and `MIN_PROMO_DURATION` — below this threshold (e.g. 15 seconds) don't bother trying to fill. Avoids infinite loops on tiny time gaps.

`pickSpot(campaign)` — selects the least-recently-played `campaign_media` row where `play_as_spot = true`, using the same LRP (least-recently-played) logic as music rotation but scoped to that campaign's media.

---

## Spot Media Selection Within a Campaign

A campaign can have multiple media items (`campaign_media` rows). When it's the campaign's turn to air:

1. Load `campaign_media` for this campaign where `play_as_spot = true`
2. Join with `play_history` to find the last played `campaign_media_id`
3. Pick the one not played most recently (LRP within the campaign's own media pool)

This ensures spots within a campaign rotate rather than always playing the same creative.

---

## Integration with picker.ts

The existing `picker.ts` (`pickNext()`) runs for all segment types and currently returns a random music track. After Phase 3, `pickNext()` becomes a dispatcher:

```typescript
async function pickNext(context: SchedulerContext): Promise<PickResult | null> {
  const segment = context.currentSegment;
  if (!segment) return pickMusic(context);   // fallback: no clock

  switch (segment.type) {
    case 'music':       return pickMusic(context, segment);
    case 'stop_set':    return pickStopSet(context, segment);   // new Phase 3
    case 'news':
    case 'bulletin':
    case 'voice_track': return pickFromPlaylist(context, segment);
    case 'live':
    case 'live_audience': return null;        // no pick — harbor input
    default:            return pickMusic(context);
  }
}
```

`SchedulerContext` = `{ now, currentShow, currentClock, currentSegment }`. The scheduler resolves this before calling the picker.

---

## Phase Checklist

### Phase 1 — Schema + Capacity Calculator ✓ DONE
- [x] Migration `0029`: add `campaign_id`, `promo_id`, `clock_segment_id`, `stop_set_position` to `play_history`
- [x] `schema.ts`: new columns with FK references and index on `campaign_id`
- [x] `playHistory.ts`: `recordPushed()` accepts all 4 new fields as optional args
- [x] `capacity.ts`: `computeWeeklyCapacity()` — weekly slot count + seconds by DOW and by interval
- [x] `GET /supervisor/capacity` endpoint

### Phase 2 — CampaignTracker
Build `apps/api/src/services/supervisor/campaignTracker.ts`:

- [ ] `getCampaignEligibility(now, show)` — loads all active campaigns, applies all eligibility filters, returns sorted list with pacing scores
- [ ] `getPlaysToday(campaignId)` — COUNT from play_history WHERE campaign_id = ? AND started_at >= today_start AND aborted = false
- [ ] `getPlaysThisMonth(campaignId)` — same but month window
- [ ] `getPlaysThisWeek(campaignId)` — for interval_plays_per_week cap
- [ ] `hasPosition1PlayToday(campaignId)` — checks stop_set_position = 1 today
- [ ] `computePacingRatio(campaign, playsThisMonth)` → float
- [ ] `computePacingBoost(ratio)` → integer score modifier
- [ ] Over-booking detection: compare sum(plays_per_day) vs capacity.by_dow[today]
- [ ] First-in-slot feasibility check: flag 'always' campaigns whose target exceeds slot count

### Phase 3 — StopSetPicker
Build `apps/api/src/services/supervisor/stopSetPicker.ts`:

- [ ] `pickStopSet(context, segment)` — implements the algorithm above, returns ordered sequence
- [ ] `pickSpot(campaign)` — LRP across campaign's own media pool
- [ ] `getEligiblePromos(now, show)` — promo eligibility + sort
- [ ] `pickPromoMedia(promo)` — LRP within promo's media pool
- [ ] Wire into `picker.ts` as the dispatcher for `type = 'stop_set'`
- [ ] `recordPushed()` callers updated to pass `campaign_id`, `promo_id`, `clock_segment_id`, `stop_set_position`

### Phase 4 — Music Segment Clock-Awareness
Build `apps/api/src/services/supervisor/clockResolver.ts` and extend `picker.ts`:

- [ ] `resolveCurrentSegment(now)` — clock resolution: Calendar > TemplateClockEntry > TemplateEntry > null
- [ ] `resolveCurrentShow(now)` — show from the same resolution chain
- [ ] Weighted multi-source draw for music segments (`sources[]` with `weight`)
- [ ] Per-source rotation algorithms: `least_recently_played`, `random_separation`, `round_robin`, `weighted`
- [ ] Tier fallback: hot → medium → cold
- [ ] Interstitial jingle injection (every N tracks counter)
- [ ] `start_policy` enforcement: hard cut vs soft window

---

## Key Files

| File | Role |
|------|------|
| `apps/api/src/db/schema.ts` | Source of truth for all table shapes |
| `apps/api/drizzle/` | Migration SQL files + `meta/_journal.json` |
| `apps/api/src/services/supervisor/capacity.ts` | Weekly stop-set capacity calculator (Phase 1) |
| `apps/api/src/services/supervisor/campaignTracker.ts` | Campaign eligibility + pacing (Phase 2, to build) |
| `apps/api/src/services/supervisor/stopSetPicker.ts` | Stop-set content selection (Phase 3, to build) |
| `apps/api/src/services/supervisor/picker.ts` | Current picker — to become a dispatcher in Phase 3 |
| `apps/api/src/services/supervisor/playHistory.ts` | DB ops for play_history rows |
| `apps/api/src/services/supervisor/scheduler.ts` | Push loop — calls picker, calls recordPushed |
| `apps/api/src/routes/supervisor.ts` | API routes including `/supervisor/capacity` |
| `docs/scheduling.md` | Full scheduling system design (clocks, delay policy, drift) |
| `docs/campaigns.md` | Campaign entity fields and UI |

---

## Resuming in a Fresh Session

To pick up Phase 2 implementation:

1. Read `docs/campaign-delivery.md` (this file) — full design
2. Read `docs/scheduling.md` — supervisor architecture
3. Read `apps/api/src/db/schema.ts` — campaigns (line ~720), promos (~795), play_history (~133), broadcastIntervals (~673)
4. Read `apps/api/src/services/supervisor/capacity.ts` — Phase 1 reference implementation
5. Read `apps/api/src/services/supervisor/playHistory.ts` — recordPushed signature
6. Start with `campaignTracker.ts` — `getCampaignEligibility()` is the first function to write
