# SpotBudgetService Interface

Service that calculates available spot air time. Used by the operator dashboard (planning) and the supervisor (pre-scheduling checks).

See `docs/spot-budget-algorithm.md` for the full algorithm behind these calculations.

---

## Two Modes

- **projection** — uses full period inventory and planned plays. UI planning and campaign creation.
- **live** — uses future-only inventory and remaining plays (planned − aired). UI live dashboard and supervisor.

Live mode: the service clamps `start` to `max(start, now)` internally. Callers always pass the campaign's full date range.

---

## Types

```typescript
type BudgetMode = 'projection' | 'live'

// The two budget dimensions
interface Budget {
  minutes: number
  breaks: number
}

// Budget split across the three cuts
interface BudgetCuts {
  global: Budget
  byInterval: Record<string, Budget>  // intervalId → budget
  byShow: Record<string, Budget>      // showId → budget
}

interface DateRange {
  start: Date
  end: Date
}
```

---

## Service Interface

```typescript
interface SpotBudgetService {

  // L1 — raw + effective inventory (after promo margin).
  // Cached. Invalidated on clock or calendar change.
  getInventory(period: DateRange, mode: BudgetMode): Promise<{
    raw: BudgetCuts
    effective: BudgetCuts
    promoMargin: number
  }>

  // L2 — aggregate demand across all campaigns + per-campaign breakdown.
  // Always computed fresh (cheap: just sums campaign fields).
  getDemand(period: DateRange, mode: BudgetMode): Promise<{
    totals: BudgetCuts
    byCampaign: Array<{
      campaignId: string
      minutes: number
      firstSlotBreaks: number
      scope: 'global' | { intervalId: string } | { showId: string }
    }>
  }>

  // L3 — available budget (L1 effective − L2 totals). Campaign-agnostic.
  getAvailable(period: DateRange, mode: BudgetMode): Promise<BudgetCuts>

  // L3 from a specific campaign's perspective.
  // Applies first-in-slot sub-pool and non-compete partner reduction.
  // Primary entry point for supervisor pre-scheduling check.
  getCampaignAvailable(
    campaignId: string,
    period: DateRange,
    mode: BudgetMode
  ): Promise<{
    available: Budget           // general available after all deductions
    firstSlotAvailable?: number // only present if campaign has first-in-slot
    nonCompeteReduction?: Budget // how much was deducted due to partners
  }>

  // Pacing — always live mode, no period arg (uses campaign's own date range).
  getPacing(campaignId: string): Promise<{
    expectedToDate: number
    actualToDate: number
    delta: number         // positive = ahead, negative = behind
    totalPlanned: number
    remaining: number
  }>

  // Cache control
  invalidateInventory(): void
}
```

---

## API Routes

```
GET /api/spot-budget
  ?mode=projection|live
  &start=ISO&end=ISO

  → { inventory, demand, available }
  Used by: dashboard, campaign list

GET /api/spot-budget/campaign/:id
  ?mode=projection|live
  &start=ISO&end=ISO

  → { available, firstSlotAvailable?, nonCompeteReduction?, pacing }
  Used by: campaign detail page, create form estimate

GET /api/spot-budget/campaign/:id/pacing
  → { expectedToDate, actualToDate, delta, totalPlanned, remaining }
  Used by: supervisor before each play, live dashboard per-campaign row
```

---

## Implementation Notes

- `getInventory` is the only expensive call — it projects clocks over the calendar for the period. Cache aggressively; invalidate on clock segment save, calendar entry save, or campaign scope change.
- `getDemand` is always computed fresh. It only sums campaign configuration fields — fast enough to skip caching.
- `getCampaignAvailable` is the heaviest on non-compete campaigns: it must resolve each partner campaign and compute their remaining footprint before reducing the available pool.
- The supervisor only calls `getCampaignAvailable` (live) + `getPacing`. It never needs the full inventory/demand breakdown.
- `invalidateInventory` must be called on: clock segment save, calendar entry save, campaign save (scope changes affect which L1 cut is relevant).
