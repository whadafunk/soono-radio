# SpotBudgetService Interface

Service that calculates available spot air time. Used by the operator dashboard (planning) and the supervisor (pre-scheduling checks).

See `docs/spot-budget-algorithm.md` for the full algorithm behind these calculations.

---

## Two Modes

- **estimated** — full planned demand for the window based on campaign configs. Used by the UI for planning (budget panel, campaign creation form).
- **remaining** — remaining demand only (planned − already aired). Used by the supervisor when making real-time scheduling decisions.

The service clamps `start` to `max(start, now)` internally in remaining mode. Callers always pass the full date range.

---

## Types

```typescript
type BudgetMode = 'estimated' | 'remaining'

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

  // L1 — raw + effective inventory (after promo margin on minutes only).
  // Cached. Invalidated on clock or calendar change.
  getInventory(period: DateRange, mode: BudgetMode): Promise<{
    raw: BudgetCuts
    effective: BudgetCuts
    promoMargin: number
  }>

  // L2 — aggregate demand across all campaigns + per-campaign breakdown.
  // Cached by date + mode (24h TTL). Invalidated on campaign save.
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

  // Pacing — always uses campaign's own date range (not the 30-day window).
  getPacing(campaignId: string): Promise<{
    expectedToDate: number
    actualToDate: number
    delta: number         // positive = ahead, negative = behind
    totalPlanned: number
    remaining: number
  }>

  // Cache control
  invalidateInventory(): void
  invalidateDemand(): void
}
```

---

## API Routes

```
GET /api/spot-budget
  ?mode=estimated|remaining
  &start=ISO&end=ISO

  → { inventory, demand, available }
  Used by: dashboard budget panel, campaign list

GET /api/spot-budget/campaign/:id
  ?mode=estimated|remaining
  &start=ISO&end=ISO

  → { available, firstSlotAvailable?, nonCompeteReduction?, pacing }
  Used by: campaign detail page, create/edit form budget impact

GET /api/spot-budget/campaign/:id/pacing
  → { expectedToDate, actualToDate, delta, totalPlanned, remaining }
  Used by: supervisor before each play, per-campaign pacing column
```

---

## Implementation Notes

- `getInventory` is the only expensive call — it projects clocks over the calendar for the period. Cached by SHA-256 of period + mode; invalidated on clock segment save, calendar entry save, or station settings change.
- `getDemand` is cached by window-start date + mode (24h natural TTL); invalidated on campaign create/update/delete.
- `getCampaignAvailable` is heavier on non-compete campaigns: resolves each partner and computes their remaining footprint before reducing the available pool.
- The supervisor calls `getCampaignAvailable` (remaining mode) + `getPacing`. It never needs the full inventory/demand breakdown.
- The UI always calls in `estimated` mode. The supervisor always calls in `remaining` mode.
