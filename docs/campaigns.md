# Campaigns & Ad Management

## Overview

The campaign system manages paid advertising (spots and sweeps) for customers. It defines delivery constraints — how many times an ad should air, in what time windows, with what separation from competitors — and tracks pacing against those targets.

---

## Entities

### Customer
An advertiser or sponsor. Has an account manager (a User).  
See [data-model.md](./data-model.md) for full fields.

### Campaign
An ad buy. Belongs to a customer. Key constraint fields:

| Field | Purpose |
|-------|---------|
| `plays_per_month` / `plays_per_day` | Delivery targets and caps |
| `sweeps_per_month` | Target for sweep plays (separate from spots) |
| `time_window_start/end` | Earliest/latest airtime (e.g. no ads before 6am) |
| `days_of_week` | Which days campaign is eligible (null = all) |
| `priority` | `hard` = must be delivered; `best_effort` = fill when possible |
| `first_in_slot` | Must be the first spot in the commercial block |
| `competing_exclusions` | Campaign IDs that cannot air in the same break |
| `advertiser_separation` | Minimum number of other spots between same advertiser |

`competing_exclusions` is bidirectional — the API automatically syncs both sides when updated.

### Campaign Media
Specific audio assigned to a campaign. Each item is tagged as:
- `play_as_spot` — runs as a standalone ad
- `play_as_sweep` — runs as part of a sweep sequence (multiple spots run together)
- `sort_order` — order within a sweep

---

## Spots vs. Sweeps

**Spot**: A single ad. Aired individually in a commercial segment.

**Sweep**: A sequence of spots played back-to-back as a unit. The clock segment specifies a duration (e.g. 3 minutes); the picker fills it with a sweep sequence from eligible campaigns.

---

## Campaign Pacing

`GET /campaigns/:id/pacing` returns current delivery vs. target.

The pacing system (not yet implemented in the picker) will:

1. Calculate expected plays to date: `target * (elapsed_days / days_in_month)`
2. Compute pacing ratio: `actual_plays / expected_plays`
3. Boost priority if under-pacing (ratio < 0.8)
4. Reduce priority if over-pacing (ratio > 1.2)
5. Apply `even_spread` distribution: spread plays evenly across dayparts

---

## Delivery Constraints Enforcement (Future)

When the Supervisor picks for a `commercial` clock segment, it will:

1. Gather all active campaigns (date range includes today, active=true)
2. Filter by time window and day-of-week
3. Filter out campaigns that have hit their daily cap
4. Apply `competing_exclusions` — remove conflicts from candidates
5. Apply `advertiser_separation` — remove campaigns from same advertiser aired too recently
6. Apply pacing boost/penalty to sort candidates
7. Respect `priority: 'hard'` — these must air before `best_effort`
8. Respect `first_in_slot` — place these at the top of the commercial block

---

## UI

Located at `/customers`.

Tabbed interface:
- **Customers tab**: list with search, create/edit customer, assign account manager
- **Campaigns tab**: list campaigns per customer, create/edit campaign with all constraint fields
- **Campaign media section**: add spots/sweeps to a campaign (picks from library), set spot/sweep flags
- Pacing indicator shown per campaign (on track / behind / over)
