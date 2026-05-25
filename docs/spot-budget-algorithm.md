# Spot Budget Algorithm

Calculates how much ad/promo time is available in the schedule. Used by the operator dashboard (can I fit another campaign?) and by the supervisor kitchen (is there room to schedule this play?).

---

## Three Layers

```
L1  raw inventory (clock/calendar, no campaigns)
  × (1 − promo_margin)
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

### Two dimensions

- **Minutes** — sum of all stop-set segment durations in the period
- **Breaks** — count of all stop-set segments in the period

Every break has exactly one first position. The first-slot capacity equals the break count — no separate sub-budget needed at this layer.

### Three cuts

| Cut | Minutes | Breaks |
|---|---|---|
| Global | sum of all stop-set durations | count of all stop-sets |
| Per interval | sum of stop-sets whose dates fall inside the interval | count within interval |
| Per show | sum of stop-sets in clocks assigned to that show | count in show's clocks |

Show-level inventory is zero on days when the show is not scheduled.

### Three time windows

All cuts are computed at: **per day / per week / per 30-day rolling window**.

### Promo margin

Applied as a flat reduction before anything else:

```
effective_minutes = raw_minutes × (1 − promo_margin)
effective_breaks  = raw_breaks  × (1 − promo_margin)
```

Typical margin: 10–15%. Everything downstream uses effective numbers.

---

## Layer 2 — Campaign Demand (Aggregate)

How much each campaign draws from the inventory. L2 is the sum across all campaigns — not yet viewed from any specific campaign's perspective.

### Campaigns — demand per campaign

| First-in-slot mode | Minutes drawn | First-slot breaks drawn |
|---|---|---|
| None | P × duration | 0 |
| Every play | P × duration | P |
| Once per day | P × duration | D |

- **P** = number of plays in the period
- **D** = number of campaign days in the period
- **duration** = spot duration

**Minutes are always P × duration regardless of first-in-slot mode.**

For once-per-day campaigns the minutes decompose as D × duration (first-slot airings) + (P − D) × duration (non-first airings), but the total is still P × duration and is checked against one minutes pool.

### Promos — minutes only

Promos have no first-in-slot condition, no non-compete, and no break-level constraint. Their demand is purely:

- **Minutes drawn** = plays_per_day × duration × days_in_interval

No break dimension. Promos are not counted against the break budget.

### Campaign scope

Each campaign is scoped to exactly one of: **global**, **interval**, or **show** (mutually exclusive). Demand is attributed to that scope's budget cut.

---

## Layer 3 — Available Budget

L3 = L1 − L2. One global remaining budget. What varies is which slice each campaign checks against.

### Simple campaign (no constraints)

Check against full L3. Campaign-agnostic — same answer regardless of which simple campaign is asking.

- Available minutes = L1 minutes − sum(all campaign minute demands)
- Available breaks  = L1 breaks  − sum(all first-slot break demands)

### First-in-slot campaign

Two independent checks against different pools:

1. **Break check** — against the first-slot sub-pool only:
   - Available first-slot breaks = L1 breaks − sum(first-slot break demands of all first-in-slot campaigns)
   - Does D (once-per-day) or P (every-play) fit?

2. **Minutes check** — against full L3 minutes (same as simple campaign):
   - Does P × duration fit?

### Non-compete campaign

Both dimensions are reduced by the footprint of the non-compete partner(s). Computed from campaign A's perspective:

- Available breaks for A  = L3 breaks  − sum(partner play counts)
- Available minutes for A = L3 minutes − sum(partner plays × partner duration)

Non-compete is symmetric: if A excludes B, B's breaks are off-limits to A even if B did not declare it.

### Combined constraints (first-in-slot + non-compete)

Check each constraint against its pool independently:

1. Available first-slot breaks (minus partner first-slot footprint) — does D or P fit?
2. Available minutes (minus partner minutes) — does P × duration fit?

---

## Variable Break Lengths and First-in-Slot

Breaks are not all the same length. This matters when converting "N remaining breaks" into a minutes figure — the answer depends on which specific breaks were claimed by first-in-slot campaigns.

### Scheduling policy: shortest breaks first

The scheduler always assigns first-in-slot plays to the shortest available breaks first. This is a hardcoded policy with two benefits:

- Short breaks have the least non-first-slot space anyway — they are the least valuable for other campaigns
- It maximises the total minutes left in the remaining break pool

With this policy the budget estimate is conservative: actual remaining minutes ≥ estimated remaining minutes.

### Implication for non-compete minutes estimation

When computing available minutes for a non-compete campaign A, the partner B's breaks are excluded. The minutes lost to B's claimed breaks should be estimated using the average duration of B's breaks — which, given the shortest-first policy, will be lower than the overall average:

```
partner_minutes_footprint ≈ B.play_count × avg_duration_of_shortest_N_breaks
```

For a coarser approximation, `B.play_count × B.spot_duration` (the partner's direct time consumption only) is the lower bound. The true footprint is higher because it includes the unused space in the partner's breaks, but quantifying that exactly requires knowing the full break-length distribution.

---

## Pacing (Per Campaign)

Whether a campaign is on pace to meet its play target by end of period.

```
expected_plays_to_date = total_plays × (elapsed_days / total_days)
pacing_delta           = actual_plays_to_date − expected_plays_to_date
```

Positive = ahead of pace. Negative = behind.
