# Supervisor Rebuild — Session Notes (2026-05-17)

> **SUPERSEDED (2026-07): historical document.** This describes the pre-V2 supervisor
> (`predictSegmentPick`, the snapshot/pure-decision-function model). None of that code
> exists anymore — the current system is `apps/api/src/services/supervisor2/`, designed
> in [supervisor-v2-design.md](./supervisor-v2-design.md). Kept as provenance for why
> decisions were made (e.g. the Phase D shadow-tables deferral). Do not use it to learn
> current behavior.

This document captures the architectural rebuild of the supervisor / picker / scheduler subsystem performed in a single session, the reasoning behind each major decision, and the work that was explicitly deferred. It is intentionally written as a retrospective rather than a how-to — for current behavior see [scheduling.md](./scheduling.md), [campaign-delivery.md](./campaign-delivery.md), and the inline JSDoc on the relevant TypeScript files.

Companion commits: `cff0bb8 feat: Supervisor rebuild — clock-aware picker, simulator, controls` and `c7c2f58 chore: Remove orphaned 0021_tan_yellow_claw migration`.

---

## Where things stood before

The supervisor's picker was a flat random-with-separation: it had no concept of clocks, segments, rotations, campaigns, or any of the scheduling structure modeled in the schema and UI. Every other piece — the data model, the React forms, the API endpoints — was already in place. The picker was the missing brain.

The original campaign-delivery plan (`docs/campaign-delivery.md`) sketched Phases 1–4 for adding clock-awareness incrementally. Phase 1 (capacity calculator + play_history columns for campaign attribution) had landed earlier. Phases 2–4 (campaign tracker, stop-set picker, music clock-awareness) were open.

---

## The unifying insight

Before writing any picker logic, we settled on a single architectural commitment that shaped everything afterward:

> Build the picker as a **pure decision function** over a **snapshot** of state.

Concretely:

```
predictSegmentPick(snapshot, now) → SegmentPick | null
```

The decision function does no I/O — no DB calls, no telnet, no `Date.now()`. All inputs come from `snapshot` (resolved segment, source pools, recent history, active campaigns, etc.) and `now`. A separate snapshot loader does DB reads up front; a separate scheduler does telnet pushes after.

Why this matters: the same engine can power four different consumers without duplication.

| Caller | `now` | History | After the call |
|--------|-------|---------|----------------|
| Live scheduler | `Date.now()` | Recent real plays | Insert play_history, push to LS |
| Dry-run simulator | `from + offset` | Real history + threaded synthetic | Append synthetic pick, advance offset |
| Next-up panel | `Date.now()` | Real + queued | Display only |
| Apply-preview diff (when shadow tables eventually land) | `Date.now()` | Real | Run twice, render delta |

Discipline rules that fall out:
- Rotations consult `snapshot.recentHistory`, not the DB
- Random draws use a seeded RNG (Mulberry32) keyed off `(now_minute, segment_id, ...)`, so the same snapshot + `now` produces the same pick — required for reproducible dry-runs and meaningful diff previews
- No module-level mutable singletons in the decision path

---

## Phases delivered

Seven phases were planned and tracked through a memory plan (`plan_supervisor_scheduler_rebuild.md`). Six landed, one was deliberately deferred (see [Deferred work — Phase D](#deferred-work--phase-d)).

### Phase A — Clock resolver + status surface

Built `apps/api/src/services/supervisor/clockResolver.ts`. Walks the priority chain `calendar > template_clock_entries > template_entries` to find the active segment, computes elapsed/remaining within the segment, tiles when the clock is shorter than its slot. Show context (which show is on air right now) is resolved **independently** of clock context — a per-hour clock override doesn't change which show is running, only which clock fires for that hour.

The resolver runs every 5s in `refreshScheduled()`, caching the result into `state.scheduled` so `getStatus()` stays synchronous (dashboard polls it). `SupervisorStatusSchema` gained a `scheduled` field.

Notable: the legacy `delay_policy` column we expected to migrate didn't exist — migration 0027 had already replaced it with `start_policy` + `can_skip` / `can_fill` / `can_reschedule` / `catching_up_order` / `coasting_order`. The drift recovery model in this schema is richer than what the original plan assumed.

### Phase B — Predictor for music / news / bulletin / voice_track

The biggest piece. Five new files:

- `snapshot.ts` — `loadMusicPickSnapshot(scheduled, now)`. Resolves every `segment.sources` entry to a concrete `{pool, rotation, fallback}`. Show-playlist sources walk `fallback_tier` chains. Interstitial pools come from the show's `jingle_playlist_id` when assigned, else the clock's.
- `rotations/` — one file per algorithm (LRP, random_separation, round_robin, weighted) + a seeded-RNG helper + a dispatcher. Each algorithm is a pure function over a pool and history.
- `predictor.ts` — the public `predictSegmentPick`. Pipeline: interstitial jingle/station_id → weighted source draw → source-internal tier fallback → cross-source fallback.
- `picker.ts` — rewritten as a dispatcher: routes by `segment.type`. Music / news / bulletin / voice_track → predictor. Live → null. Stop_set → (Phase C). No-segment → random fallback safety net.
- `scheduler.ts` — passes `clock_segment_id` through to `recordPushed` (existing column).

### Phase B.1 — hot_play on rotations (mid-flight feature)

Mid-Phase B the operator raised that two rotation features modeled in the schema (`hot_play: boolean`, `heavy_rotation: boolean` on the playlist source entry) hadn't been surfaced in the UI and weren't being honored by the picker. We discussed and converged on:

- **hot_play** = insertion-style "slip a track from this playlist every N rotation picks". Lives on the *rotation document*, not the source entry. The boolean on the source entry becomes inert schema drift (per CLAUDE.md's "additive only" rule we'd just locked in).

Schema migration 0033: `rotations.hot_play_playlist_id` (FK) + `hot_play_every_n_tracks`. Both nullable; null = disabled. UI added under the algorithm-params section of `RotationsPage` (music-kind only). Picker streak counter walks `recentHistory` backward to the current clock-instance boundary, counting picks attributable to the source's main rotation pool since the last hot-play pick.

### Phase B.2 — heavy_rotation + music_campaigns (mid-flight feature)

Same conversation, second feature:

- **heavy_rotation** = "songs under a contractual obligation to play N times per day". The operator's framing was: this looks like an advertising spot campaign but for music. So model it the same way — a new `music_campaigns` entity parallel to spot campaigns, owned by a customer, with a playlist of contracted songs and a per-day target. Rotations opt in via `heavy_rotation_enabled = true`.

Schema migration 0034:
- New `music_campaigns` table (parallel to `campaigns` but simpler — no time windows, advertiser separation, first-in-slot, exclusions)
- `rotations.heavy_rotation_enabled`
- `play_history.music_campaign_id`

New API: `/music-campaigns` CRUD + `/pacing`. New UI: a "Music Campaigns" tab on the Customers page with a list view and create/edit modal. Customers stayed under the existing top-level "Customers" nav — we explicitly chose **not** to rename the existing `campaigns` table or routes (would be too much surface change for marginal benefit).

Picker integration: a new `musicCampaignTracker.ts` (pure pacing helpers) + extensions to snapshot.ts + a new `pickHeavyRotation` step in the predictor. Priority: pacing-first — the campaign most behind its daily target wins.

The final predictor priority order:

1. Interstitial jingle / station_id
2. Heavy rotation (pacing-first for music campaigns)
3. Hot play (streak-based)
4. Weighted source draw
5. Source-internal tier fallback
6. Cross-source fallback

Hard contractual targets sit ahead of preference-based features.

### Phase C — Stop-set picker

Built `campaignTracker.ts` (pure eligibility/pacing helpers for spot campaigns) and `stopSetPicker.ts` (per-slot decision per scheduler tick). One slot per call — the next tick computes the next slot from `play_history` filtered to `clock_segment_id` + `segment_started_at`.

Algorithm per slot:
1. Compute remaining seconds; bail if < `MIN_SPOT_DURATION_SECONDS (5)`
2. Position = `already_played.length + 1`
3. Build excluded_campaigns from already-selected campaigns' `competing_exclusions`
4. Filter by: baseline eligibility + daily/weekly caps + advertiser_separation against the prior N picks + spot duration fits
5. Position-1 handling: prefer `first_in_slot` campaigns at slot 1; if none qualify, fall through to all eligibles. For slot ≥ 2, block `always`-mode campaigns that didn't win slot 1.
6. Sort by composite score (priority +10 if `hard` + pacing boost), tie-break by id
7. Pick the campaign's LRP spot from `play_as_spot=true` media
8. If no campaign fits, fall through to promos: need-min-today first, then by today-count ascending. Exclude promos whose `no_air_during_show` + current show match.
9. Return null when nothing fits — `pickStopSetSlot` in picker.ts deliberately does **not** fall back to random music in a paid break.

`PickResult` and `SegmentPick` carry `campaign_id`, `promo_id`, `stop_set_position` end-to-end through to `recordPushed`.

### Phase D — Deferred

See [Deferred work — Phase D](#deferred-work--phase-d) below.

### Phase E — Dry-run / Simulator + Schedule Preview

Built `simulator.ts`: walks the predictor forward from `from` to `to`, threading synthetic play_history so rotations honor the simulated past. Capped at 7 days / 2000 picks per call.

`SchedulePreviewPage` lets operators pick a date range, click Generate, see the hour-grouped output table with each pick's reason. Default range is "tomorrow 00:00–23:59" — the "is my schedule healthy" workflow.

Dashboard gained a **Next Up** panel that calls `fetchSimulate(now, now+30min)` every 60s and shows the next 5 picks. Subtitle reads "simulated · won't perfectly match live picks" so it's clear this isn't the LS queue.

**Simplification flagged in code**: live / live_audience / stop_set segments emit a single placeholder row per segment rather than walking position-by-position. Per-spot stop-set simulation would require synthesizing campaign attribution + durations on synthetic history records, which we punted on for v1. The preview is still useful for verifying clock structure and music programming.

### Phase F — Supervisor controls + observability

Five POST endpoints under `/supervisor/`:

| Endpoint | Effect |
|---|---|
| `/pause` | Picker skips push step. Queue/live polling continues so UI stays fresh. |
| `/resume` | Re-enables picking. |
| `/resync` | Triggers an immediate scheduler tick. **Limitation**: does not flush LS's existing queue. Aggressive flush requires Pause → drain → Resume. |
| `/hold` | Pins the resolved segment. `refreshScheduled` returns the held segment with `elapsed += time-since-hold`, `remaining = 0`. Drift + hard-cut warning are zeroed while held. |
| `/release-hold` | Clears the hold. |

Implementation note: the scheduler keeps its own `paused: boolean` flag with a `setPaused(b)` setter, called by the supervisor index. Earlier attempt to import `isPaused()` from index.ts into scheduler.ts created a circular dependency — reversed by keeping the flag local to Scheduler.

Dashboard gained a **Now Running** card between Now Playing and Live Stream Stats:
- Clock · Segment · type (lowercase mono) + show name
- Elapsed / remaining progress bar
- Pause ↔ Resume button (toggle)
- Resync button (with `confirm()` prompt)
- Hold ↔ Release hold button (toggle)
- Pills for paused / held / hard-cut warning / drift

### Phase G — Look-ahead + drift surfacing

Three pieces:

**Drift computation** in `refreshScheduled`:
```
drift_seconds = segment_elapsed_seconds − sum(media.duration_seconds for completed plays in this segment)
```
Positive = music behind segment clock. Updates discretely at track endings (uses `ended_at IS NOT NULL`) for a stable signal.

**Hard-cut warning** in `refreshScheduled`: walks the clock's sibling segments by `sort_order`, fires when:
1. Current segment is `can_skip = false`
2. Next segment has `start_policy.type === 'hard'`
3. We're within `HARD_CUT_WARNING_SECONDS (120)` of the boundary

**Look-ahead protection** in the predictor: `predictSegmentPick = applyLookAhead(pickCandidate(...))`. When the candidate would overrun a fixed-end segment (`can_skip = false`), reject and try `filler_playlist_id`. If even filler doesn't fit, return null — silence at end-of-news beats overrunning into the next hard-start segment.

Surfaced in the Now Running card as colored chips: amber `+Ns BEHIND`, cyan `Ns AHEAD` (within rounding noise the chip is hidden), rose `HARD CUT IN ~Ns`.

---

## Deferred work — Phase D

**Phase D in the original plan was shadow tables.** Every schedule-affecting entity (clocks, clock_segments, calendar_entries, template_entries, template_clock_entries, campaigns, music_campaigns, rotations, shows, show_playlists, plus dependents) would get a `*_draft` mirror. The UI would be in "draft mode" by default — edits accumulate; an Apply transaction atomically swaps draft → live and triggers a Resync; Discard truncates the drafts. The predictor would gain a `useDrafts: boolean` flag, making "preview the schedule after Apply" a pure diff of two predictor runs over the same window.

### What shadow tables would have protected against

The failure mode is **multi-edit storms during live broadcast**. Without staging, every save to a clock segment, calendar entry, or template lands immediately. When an operator is mid-redesigning a clock that's currently airing — reordering segments, changing durations, deleting and adding — the picker may iterate the clock mid-mutation. The result is one or two awkward transitions a listener might or might not notice: a song picked from a segment that no longer exists, a clock resolver that flips mid-tick between calendar entry and template, a randomly-picked filler when the picker's pool query lands during a structural change.

For solo single-field edits (rename a show, bump a campaign's plays_per_month), there's no problem. The hazard is specifically multi-edit sessions on schedule-shaping data.

### Why we chose the lightweight path instead

Scope:

- Shadow tables: ~11 tables doubled, every PATCH/POST/DELETE on those tables rerouted, an Apply transaction with FK ordering, a diff engine, UI for pending-changes badge + Apply/Discard, an audit log. Realistic estimate: 20+ files, ~2000 LOC, multiple sessions.
- Lightweight: edits write through; the Resync button (which we built in Phase F anyway) flushes and re-picks after an edit storm. Zero new infrastructure.

Lightweight handles **80% of operator edits cleanly** — anything that isn't structurally rearranging an airing clock. For the remaining 20%, the operator hits Resync after their edit session and the supervisor re-evaluates from the new state. A single bad transition during the edit window is the cost.

The investment-to-protection ratio didn't justify shadow tables for a single-station deployment with one operator at a time. The conversation that decided this is preserved in the saved plan (`memory/plan_supervisor_scheduler_rebuild.md`); the operator explicitly said "I am tempted by simplicity" after understanding both options.

### When to revisit

Shadow tables stay on the table for a future version of the app. Specific triggers that would justify the investment:

1. **Multi-operator deployments.** Two operators editing the same clock concurrently want isolation — drafts give it. Without them, last-write-wins on every field.
2. **Edit-then-preview workflows become routine.** If operators frequently want to "see the schedule for tomorrow with these proposed changes" before committing, shadow tables make that diff trivially possible (predictor with `useDrafts: true` vs `false`). Today's workaround is to make the change live, run a dry-run, and roll back if needed.
3. **Audible incidents during edit storms.** If logs show a meaningful rate of weird transitions during clock-editing sessions, the protection becomes worth the cost.
4. **Audit / compliance requirements.** Shadow tables would naturally produce a who-changed-what audit log; lightweight needs that built separately.

The saved plan keeps Phase D's design documented (struck out as "skipped 2026-05-17" but readable), so a future session can pick it up without re-deriving the design.

### Other deferred work

| Item | Phase | Why deferred |
|---|---|---|
| Full `catching_up_order` / `coasting_order` execution | G.2 | Phase G surfaces drift; acting on it requires deciding threshold semantics, eviction logic for already-queued LS requests (Resync's limitation), and operator UI to configure beyond what the clock-segment editor offers. Worth a dedicated session once drift becomes a real pain point. |
| `can_reschedule` for voice_track / bulletin | G.2 | Same — schema exists, picker doesn't act on it yet. |
| Per-spot stop_set simulation in the dry-run | E.2 | Synthesizing campaign attribution + durations on synthetic history records for accurate advertiser-separation / competing-exclusion playback is non-trivial. Current placeholder is "X-second commercial break — spot-by-spot simulation not yet implemented". |
| Aggressive LS queue flush in `/supervisor/resync` | F.2 | Requires `request.trash <rid>` / equivalent LS telnet commands; needs LS-version verification. Current Resync re-evaluates but doesn't cancel already-queued requests. |

---

## Key design decisions and their rationale

### "UI is the spec for scheduling logic"

Added to CLAUDE.md mid-session: the UI's option lists, validation rules, defaults, and field combinations encode the intended behavior. When implementing supervisor/picker logic, read the relevant UI pages and components first.

The rule has two parts:
- **Additive UI changes are expected and fine** — adding new fields, controls, or pages to surface capability is part of the work.
- **Destructive UI changes require explicit confirmation** — dropping a field, removing a control, replacing an option list with a different one, or renaming something in a way that changes its meaning. Even when the field looks unused or "obviously redundant".

Reasoning preserved verbatim in CLAUDE.md.

### Tier fallback on show_playlists — schema-supported, UI-surfaced mid-session

The schema's `show_playlists.fallback_tier` existed but had no UI control. Phase B's snapshot loader implemented the fallback walk anyway. When the operator asked to surface it, we added text inputs for `rotation_tier` + `fallback_tier` to each show music playlist row, with a `<datalist>` autocompleting from tiers already in use on the same show. End-to-end now works: operator labels playlists with tiers, segments reference a tier via `show_playlist` source, picker tries it then walks fallback when exhausted.

### Migration timestamp drift — manual application required

Migrations 0033 and 0034 had to be applied **manually** following the recipe in CLAUDE.md. Drizzle-kit stamps each migration's `when` field with current real-time, but prior migrations in the repo had been hand-edited with future timestamps (1779581000008 = Sept 2026) for ordering reasons. New migrations stamped with today (2026-05-17 ≈ 1778971400000) fail the libsql migrator's "when > last_applied.created_at" check and get silently skipped.

Recipe (documented in CLAUDE.md, executed for both migrations):
1. `sqlite3 data/radio.db < migration.sql`
2. Compute the migration file's SHA-256
3. `INSERT INTO __drizzle_migrations (hash, created_at)` with `created_at = max(created_at) + 1`
4. Patch the `when` field in `_journal.json` to match

### Stop-set picker returns one slot per tick

The original campaign-delivery plan implied the stop-set picker returns the whole break in one call, then the scheduler pushes each item as the queue drains. We chose the simpler shape: one slot per tick, with `play_history` filtered to `clock_segment_id` + `segment_started_at` as the position cursor. Each tick naturally walks the next slot. Easier to reason about, re-derivable on demand (which Phase G's drift accounting depends on), and aligns with the existing one-pick-per-tick scheduler architecture.

### Music campaigns vs spot campaigns — parallel, not renamed

The conversation considered renaming `campaigns` → `spot_campaigns` for symmetry with the new `music_campaigns`. Rejected on cost-benefit grounds: the rename would touch the DB column, every API route, the menu label, the shared schemas, the existing UI page, and require a migration to rename FKs from `campaign_id` to `spot_campaign_id` everywhere. The operator's call was "Keep using campaigns, and for the songs we do music campaigns" — no rename, parallel tables.

A small concession: the Customers layout gained tabs ("Customers & Spot Campaigns" / "Music Campaigns") — additive, no existing controls disturbed.

---

## What's verified

### Live-tested in this session

- Hot_play UI: set MegaHits playlist + cadence 3, saved, reloaded, persisted in DB
- Music_campaigns CRUD: created "Test Promo" for Libraria Conte / MegaHits / 3 plays-per-day, pacing endpoint returned 0/3
- Heavy_rotation_enabled toggle: enabled on `gigica` rotation, persisted via API
- Tier + fallback_tier on show playlists: MegaHits tier=hot fallback=medium, All The Hits tier=medium; chain configured and persisted
- Simulator: 1h window generated 16 picks with round_robin walking playlist 9 positions 1, 2, 3 + a stop_set placeholder
- Schedule Preview page: full render with controls + hour-grouped output
- Dashboard Next Up panel: 5 simulated picks from now
- Now Running card: rendered current segment with progress bar
- Pause: toggled on, API confirmed `paused: true`, UI showed PAUSED chip, button toggled to Resume
- Resume: toggled off, API confirmed `paused: false`
- Drift surfacing: `+37S BEHIND` amber chip rendered with real drift from real play_history

### Type-check-verified but not exercised by a live scheduler tick

- Stop-set picking during an actual segment (requires a clock with a stop_set segment scheduled now + active campaign + spot media)
- Heavy_rotation actually injecting a music-campaign track at pick time
- Hot_play streak triggering at cadence N
- Look-ahead routing to filler in a fixed-end segment near boundary
- Hard-cut warning chip firing (needs current segment `can_skip=false`, next segment `start_policy=hard`, within 2 min)

Plumbing is correct per type-check and code review; runtime verification awaits configured test cases.

---

## Files of interest

| File | Purpose |
|---|---|
| `apps/api/src/services/supervisor/clockResolver.ts` | Schedule-priority chain → `ResolvedSegment` |
| `apps/api/src/services/supervisor/snapshot.ts` | DB-loaded snapshot for the predictor (sources, history, campaigns, filler) |
| `apps/api/src/services/supervisor/rotations/` | Pure rotation algorithm implementations |
| `apps/api/src/services/supervisor/predictor.ts` | Pure decision function — `predictSegmentPick` |
| `apps/api/src/services/supervisor/campaignTracker.ts` | Pure helpers for spot-campaign eligibility + pacing |
| `apps/api/src/services/supervisor/musicCampaignTracker.ts` | Pure helpers for music-campaign pacing |
| `apps/api/src/services/supervisor/stopSetPicker.ts` | Per-slot stop-set decision |
| `apps/api/src/services/supervisor/picker.ts` | Dispatcher by segment type |
| `apps/api/src/services/supervisor/scheduler.ts` | Tick loop, queue depth, push to LS |
| `apps/api/src/services/supervisor/simulator.ts` | Forward-walking dry-run engine |
| `apps/api/src/services/supervisor/index.ts` | Supervisor lifecycle + state + controls + refresh |
| `apps/api/src/routes/musicCampaigns.ts` | Music-campaign CRUD + pacing |
| `apps/api/src/routes/supervisor.ts` | Status + simulate + controls |
| `apps/web/src/pages/customers/MusicCampaignsPage.tsx` | List view + create/edit modal |
| `apps/web/src/pages/schedule/SchedulePreviewPage.tsx` | Dry-run UI |
| `apps/web/src/pages/Dashboard.tsx` | Now Running + Next Up sections |

---

## See also

- [scheduling.md](./scheduling.md) — supervisor architecture (current state)
- [campaign-delivery.md](./campaign-delivery.md) — campaign + promo delivery design
- [clocks-rotations-redesign.md](./clocks-rotations-redesign.md) — the rotation/clock/sweeper/handover model
- [data-model.md](./data-model.md) — entity reference (now includes music_campaigns + new rotation columns)
