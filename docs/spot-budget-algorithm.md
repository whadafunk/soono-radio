# Spot Budget Algorithm

Calculates how much ad/promo time is available in the schedule. Used by the operator dashboard (can I fit another campaign?) and by the supervisor (is there room to schedule this play?).

---

## Reference Window

All budget calculations use a **30-day rolling window**: today at 00:00 → today + 30 days.

- Day and week sub-cuts exist in the data structure for future use (scheduler planning) but are not surfaced in the UI.
- The start is always anchored to today, so there is no meaningful past/future split to worry about at the window level.
- New campaigns must start today or later — scheduling campaigns in the past is not allowed.

---

## Two Modes

The service supports two modes. The reference window is the same; what differs is how demand is counted.

| | Projection | Live Remaining |
|---|---|---|
| **L2 input** | planned plays in the window | remaining plays per campaign (planned − aired so far) |
| **Used by** | UI planning (campaign creation, budget panel) | Supervisor scheduling decisions |
| **Mode value** | `estimated` | `remaining` |

Because the window always starts from today, estimated and remaining are nearly identical for the UI. The distinction matters for the supervisor making real-time decisions about what to schedule next.

---

## Three Layers

```
L1  inventory (clock/calendar estimated for the 30-day window)
  × (1 − promo_margin)  [minutes only — break count is unchanged]
  = effective inventory

effective inventory
  − L2 (aggregate demand of all campaigns)
  = L3 (global remaining budget)

L3
  [simple campaign]   → check full L3
  [first-in-slot]     → check first-slot break sub-pool + full L3 minutes
  [non-compete]       → check L3 minus partner footprint
  [both]              → check first-slot sub-pool (minus partner breaks) + L3 minutes (minus partner minutes)

  [promo]             → minutes only, no break dimension
```

---

## Layer 1 — Inventory (Gross Capacity)

Derived from the clock/calendar configuration. No campaigns or promos involved.

Walks every day in the 30-day window. For each day, checks if there is a calendar override; if not, falls back to the weekly template. Applies per-hour clock overrides on top. For each clock that appears, finds its `stop_set` segments and records their duration.

### Two dimensions

- **Minutes** — sum of all stop-set segment durations in the window
- **Breaks** — count of all stop-set segments in the window

Every break has exactly one first position. The first-slot capacity equals the break count.

### Three cuts

| Cut | Minutes | Breaks |
|---|---|---|
| Global | sum of all stop-set durations | count of all stop-sets |
| Per interval | sum of stop-sets whose dates fall inside the interval | count within interval |
| Per show | sum of stop-sets in clocks assigned to that show | count in show's clocks |

### Promo margin

Applied as a reduction on **minutes only**. Break count is not reduced — promos play within a break, they do not eliminate breaks.

```
effective_minutes = raw_minutes × (1 − promo_margin)
effective_breaks  = raw_breaks   (unchanged)
```

Typical margin: 10–15%. Everything downstream uses effective numbers.

**Caching:** L1 is cached in memory keyed by SHA-256 of the period + mode. Invalidated when clocks, calendar, or station settings change.

---

## Layer 2 — Campaign Demand (Aggregate)

How much each campaign draws from the inventory. L2 is the sum across all campaigns.

### Plays in the window

For each active campaign overlapping the 30-day window:

- **Projection**: `P = (plays_per_month / 30) × overlap_days`  
  where `overlap_days = min(campaign_end, window_end) − max(campaign_start, window_start)`
- **Live**: `P = remaining_plays × (overlap_days / remaining_campaign_days)`  
  where `remaining_plays = planned_total − actual_plays_to_date`

### Demand per campaign

| First-in-slot mode | Minutes drawn | First-slot breaks drawn |
|---|---|---|
| None | P × avg_duration | 0 |
| Every play | P × avg_duration | P |
| Once per day | P × avg_duration | D (overlap days) |

**Minutes are always P × avg_duration regardless of first-in-slot mode.**

Average spot duration is computed from the campaign's attached media (defaults to 30s if no media is attached yet).

### Promos — minutes only

Promos have no first-in-slot condition and no break-level constraint. Their demand is purely minutes. No break dimension. Promos are not counted against the break budget.

### Campaign scope

Each campaign is scoped to exactly one of: **global**, **interval**, or **show**. Demand is attributed to that scope's budget cut only.

**Caching:** L2 is cached in memory keyed by the window start date + mode (e.g. `"2026-05-26:estimated"`). The date acts as a natural 24-hour TTL. Invalidated immediately on any campaign create/update/delete.

---

## Layer 3 — Available Budget

L3 = L1 effective − L2 totals. Floored at 0 per dimension.

In addition to per-campaign views, L3 exposes a **generic global available** `{ minutes, breaks }` with no campaign context — the raw remaining room in the schedule. This is what the global budget panel displays.

### Simple campaign (no constraints)

Check against full L3.

- Available minutes = L1 effective minutes − sum(all campaign minute demands)
- Available breaks  = L1 effective breaks  − sum(all first-slot break demands)

### First-in-slot campaign

Two independent checks against different pools:

1. **Break check** — against the first-slot sub-pool:
   - Available first-slot breaks = L1 effective breaks − sum(first-slot break demands of all first-in-slot campaigns)
   - Does D (once-per-day) or P (every-play) fit?

2. **Minutes check** — against full L3 minutes:
   - Does P × avg_duration fit?

### Non-compete campaign

Both dimensions reduced by the partner footprint:

- Available breaks for A  = L3 breaks  − sum(partner play counts)
- Available minutes for A = L3 minutes − sum(partner plays × partner avg_duration)

Non-compete is symmetric: if A excludes B, B's breaks are off-limits to A even if B did not declare the exclusion.

### Combined (first-in-slot + non-compete)

Each constraint checked against its pool independently:

1. Available first-slot breaks (minus partner first-slot footprint) — does D or P fit?
2. Available minutes (minus partner minutes) — does P × avg_duration fit?

---

## Variable Break Lengths and First-in-Slot

Breaks are not all the same length. The scheduler assigns first-in-slot plays to the **shortest available breaks first**. Benefits:

- Short breaks have the least residual space — least valuable to other campaigns
- Maximises total minutes left in remaining breaks for other campaigns

The budget estimate is therefore conservative: actual remaining minutes ≥ estimated remaining minutes.

For non-compete partner footprint estimation, the code uses `partnerP × partner_avg_duration` as a lower bound. The true footprint is slightly higher (includes unused space in claimed breaks), but the conservative direction is safe for planning.

---

## Pacing (Per Campaign)

Pacing uses the campaign's own full date range as the window — not the 30-day reference window. It answers whether the campaign is on track to deliver its contracted plays by end date.

```
total_planned      = (plays_per_month / 30) × total_campaign_days
expected_to_date   = total_planned × (elapsed_days / total_campaign_days)
actual_to_date     = count of play_history rows for this campaign
pacing_delta       = actual_to_date − expected_to_date
```

Positive = ahead of pace. Negative = behind.

**UI display rules:**
- Campaign not yet started (start date > today): no pacing shown
- Campaign started today: "Not enough data"
- Campaign started before today: pacing delta with colour (green / amber / red)

---

## Budget Impact in Campaign Forms

When creating or editing a campaign, the UI shows a budget impact estimate. It always uses the **30-day reference window**, not the campaign's full date range. The campaign's draw is pro-rated to its overlap with that window:

```
overlap_start   = max(campaign_start, today)
overlap_end     = min(campaign_end, today + 30)
overlap_days    = max(0, overlap_end − overlap_start)

plays_in_window = (overlap_days / 30) × plays_per_month
minutes_in_window = plays_in_window × avg_spot_duration
```

This gives the operator a consistent "next 30 days" view regardless of campaign length.

---

## Campaign Date Rules

- **Create**: start date must be today or in the future. Past start dates are rejected by both the API (Zod schema) and the UI (`min` attribute on date input).
- **Edit**: start date is locked — only end date can be extended. The supervisor uses the original start date for pacing and inventory attribution.
