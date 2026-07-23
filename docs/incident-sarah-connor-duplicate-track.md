# Incident: the Sarah Connor duplicate track, and everything it led to

**Started:** 2026-07-21 (live incident) / 2026-07-22 (diagnosis, fix, deploy, and the design
work that followed). This document is the narrative version — a readable walkthrough of
the whole arc, including the parts that got corrected along the way. The terse, structured
decision-log entry lives at `docs/supervisor-v2-design.md`, Decision 114 — this document
tells the story behind it, plus everything that came after it (a container build incident,
and a stop-set design decision) that isn't recorded there.

---

## 1. The incident

An operator reported: Sarah Connor's "Das Leben ist schön" was queued twice inside 30
minutes. Diagnosis (via live DB queries against `plan_items` / `play_history`) found the
exact case: plan 9386 (clock segment 231, "Music-4," a 660s music block), positions 0 and
2 both resolved to media_id 654 — the same track — 7 minutes apart on air (4:47:18 AM and
4:54:32 AM, 2026-07-21). Position 1, with a different target duration, got something else.

## 2. Root cause

`finalizePlan`'s "lightweight substitution" path re-validates each pending plan item
against a freshly-drawn candidate pool, and replaces any item whose backing candidate had
disappeared (a campaign hitting its cap, a track no longer eligible, etc.). The
replacement logic (`pickReplacement`) picked each invalidated item's substitute
**independently** — closest duration match against the fresh pool — with no memory of
what it had already handed out earlier in the *same* pass. All three of plan 9386's music
items got invalidated in the same finalize call; positions 0 and 2 both needed ~208s of
music, and both resolved to the same closest-duration candidate, because nothing recorded
that position 0's pick had already used it.

Campaign substitutions already had a per-pass counter for exactly this shape of problem
(`spotPlacedCounts`, from an earlier decision, D109) — music's branch of `pickReplacement`
had no equivalent.

## 3. Why this was architectural, not a one-line miss

Draft assembly (`fillMusicItems`) already does the right thing: a greedy walk against a
shrinking duration budget, with a `usedMusicIds` set threaded through the whole call so
nothing repeats, ending in a single trailing boundary decision when nothing else fits.
`finalizePlan`'s *other* branch — full reassembly, triggered when aggregate drift/content
gap crosses a threshold — already reuses that exact same draft-assembly code, so it was
already correct too. Lightweight substitution was a *third*, bespoke algorithm that reused
neither the draft fill loop nor its dedup set. And which of the two finalize branches ran
was decided purely by *aggregate duration match*, not by how many items were invalidated —
so a plan where every item turned over could still land on the unguarded, per-item path,
exactly as happened here.

## 4. Design exploration — how the fix converged

Several shapes were discussed and discarded before landing on one:

- **Duration-matched multi-item gap-fill** — treat each contiguous run of invalidated
  positions as a combined duration budget and fill it freely (not 1-for-1 with what was
  dropped). Correct in spirit, but for stop-sets it would need a brand-new bidirectional
  separation check (see below) and doesn't obviously simplify the music case either.
- **Edge-butt compaction** — shift surviving items to the front, append fresh fill after.
  Rejected: for stop-sets, compacting removes spacing that `advertiser_separation_spots`
  relied on, creating new adjacency between items that were never adjacent when the draft
  validated them.
- **Smallest-eligible single filler per gap, then a seeded tail-fill** — the shape that
  stuck. Every contiguous run of invalidated positions gets exactly **one** replacement —
  the smallest-duration still-eligible candidate, with no attempt to match the gap's
  original size — and then whatever the segment's real budget still needs gets filled by
  the *same* greedy walk draft assembly already uses, continuing interstitial cadence from
  wherever the gap fillers left off. One dedup set spans survivors, every gap filler, and
  the tail fill.

The reasoning for "smallest, don't try to match the gap": the system already has a whole
mechanism (drift correction) for absorbing "actual content total ≠ nominal target" — a
filler that over- or under-shoots its gap isn't a new problem, it's the same one already
solved. Constraining the filler to be smaller-than-the-gap was considered and rejected too:
it can fail to find any candidate at all, for no benefit, since the imbalance gets absorbed
downstream regardless.

Full write-up with all the intermediate reasoning: `docs/supervisor-v2-design.md`,
Decision 114.

## 5. Implementation — music only

Scoped deliberately to `content_type === 'music'` for this pass — the reported bug was
music, and the stop-set version of this same idea needs materially harder new code (a
*forward* separation check that doesn't exist anywhere today, since draft/full-reassembly
never build into an already-populated tail; see §7 below for how that later got resolved
differently). Built:

- `finalizeMusicGapFill` (`planner.ts`) — groups contiguous invalidated music runs, picks
  one smallest-eligible filler per run, then runs a seeded-cadence tail fill.
- `musicGapFill.ts` — the gap-detection and candidate-selection logic pulled into their own
  dependency-free module (no DB/bus import) specifically so they're unit-testable.
  `groupInvalidMusicRuns` + `pickSmallestEligibleCandidate`.
- `fillMusicItems` gained an optional `initialCadence` parameter (`musicCount`/
  `jingleCursor`/`stationIdCursor`) so the tail-fill call continues interstitial spacing
  instead of restarting the count at zero. Existing call sites are unaffected (the
  parameter is optional, appended last).
- Folded in an unrelated but adjacent finding while touching this code (D113's silent-
  failure audit, finding #7): a failed substitution/gap-fill now logs
  (`FINALIZE_GAP_FILL_FAILED` / `FINALIZE_SUBSTITUTION_FAILED`) instead of silently
  leaving a stale item in place.
- **First test infrastructure this project has ever had.** Confirmed via full git history
  search — no `.test.ts`/`.spec.ts`/`__tests__` had ever existed anywhere in this repo
  before this session (the only prior artifact was a one-off `test-app.mjs` Playwright
  smoke script from the second commit ever, long deleted). Set up vitest for `apps/api`
  (`pnpm --filter api test`, or `pnpm test` from root). `musicGapFill.test.ts` has 8
  passing tests, including one built directly from the plan-9386 incident shape and one
  that encodes the exact regression (two gaps in one pass must never resolve to the same
  candidate).

Deployed as two commits: `4994036` (the fix), `ec9d471` (the test infra + two related
build-hygiene fixes — see next section for why those existed). Verified live: healthy,
stable, tracks pushing and on-air webhooks confirmed normal.

## 6. The container rebuild detour

Wiring up vitest surfaced two real build issues, and fixing one of them properly turned
into its own small saga.

**Issue 1 (caught immediately, no risk):** `tsc` was compiling `*.test.ts` into `dist/` —
harmless at runtime (nothing imports the compiled test file) but pointless bloat. Fixed
with a build-only tsconfig (`tsconfig.build.json`, excludes `*.test.ts`) that `pnpm build`
uses while `type-check` keeps using the base config — test files stay type-checked, just
never shipped.

**Issue 2 (caused a real, if brief, live outage):** the Docker image was installing all
devDependencies (vitest and its whole tree) with no pruning. First attempt — `pnpm prune
--prod` after the build step — failed the build outright with
`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` (pnpm refuses to remove the modules dir
without a TTY to confirm). Fixed with `CI=true pnpm prune --prod` (pnpm's own documented
non-interactive opt-in) — this built successfully, but **removed `fastify` itself**, a
real production dependency, not a devDependency. `docker compose up --build -d` went
straight from "build succeeded" to recreating the live `soono-api` container, which
crashed on boot (`ERR_MODULE_NOT_FOUND: fastify`); `soono-liquidsoap` (which waits on
`soono-api`'s healthcheck) never started. Genuine dead air for a few minutes, caught via
`docker ps`/`docker logs` immediately after, fixed by reverting the prune step
(commit `12393de`) and redeploying.

**Root cause, found afterward (not under incident pressure — the operator explicitly
deprioritized dead-air risk for this specific follow-up investigation):** `pnpm prune`
has no `--filter`/scoping option at all. Run unscoped at the workspace root, it only
understands the *root* `package.json`'s own dependency graph — confirmed directly
(`pnpm why fastify` at the root returns nothing; `pnpm --filter @soono/api why fastify`
resolves it correctly). The root `package.json` has zero real `dependencies` (only two
devDependencies), so from prune's perspective, *everything* not root-level — including
`fastify`, which only `apps/api/package.json` declares — looked extraneous.

**The real fix:** `pnpm deploy --filter @soono/api --legacy --prod <dir>` — pnpm's own
tool for assembling one workspace package's correctly-scoped production closure.
`--legacy` avoids needing `dependenciesMeta.injected` config for the `workspace:*`
dependency on `@soono/shared`. Implemented as a genuine multi-stage Dockerfile: a builder
stage (same as before, ending in `pnpm deploy`) and a fresh runtime stage that copies only
that output plus the Python analysis venv (not a node concept, so not part of `deploy`'s
output — copied separately from the builder stage onto the same path). Verified two ways
before it ever touched the live compose stack: a standalone `docker build` + `docker run`
against the exact Dockerfile (no volumes mounted, so the real DB was never touched) — got
past all dependency resolution, only failed on the expected missing `/data/radio.db`;
and the Python venv confirmed present and runnable. Along the way, local Docker Desktop's
buildx got into an unrelated broken state (a `docker-container` builder failing to locate
`-f apps/api/Dockerfile`, possibly related to the space in this repo's directory name) —
worked around by testing directly against the *server's* Docker daemon instead (still
never through `compose`, still never touching live volumes), which is the daemon that
actually matters for the real deploy anyway.

Deployed (commit `581298d`) — verified live: `soono-api` healthy, `soono-liquidsoap`
started, stable, tracks pushing normally. Image size 2.36GB → 2.19GB, and — more
importantly than the size — architecturally correct now: the runtime stage never inherits
the builder's full dependency tree, so there's no over-broad tree left to prune
incorrectly in the first place.

A local macOS filesystem permission hiccup (Documents-folder access briefly revoked for
the session's hosting app, mid-investigation) delayed committing this fix by one round of
back-and-forth, but didn't affect the fix itself — it was already fully verified on the
server before the permission issue even came up.

## 7. Stop-sets: always full replan, instead of building gap-fill for them

The music-only scope left an open question: what to do for stop-sets (`content_type ===
'campaign'`), where building the equivalent gap-fill needs a *new* bidirectional
separation check that doesn't exist anywhere in the codebase (draft/full-reassembly never
build into an already-populated tail, so they've never needed a *forward* check — only
gap-fill would).

The alternative proposed and analyzed: don't build stop-set gap-fill at all — whenever
finalize decides a stop-set's content needs to change, always do a full reassembly (drop
every pending item, re-request content, rebuild with all the same rules draft already
uses — envelopes, separation, slot-1, everything), the same path `needsFullReassembly`
already takes for music sometimes.

**Churn analysis — why this costs less than it sounds like:**
1. Stop-set breaks are short, and (see §8) finalize turns out to almost always fire before
   any of a segment's own content has aired — so "rebuild the pending remainder" and
   "rebuild everything" cover the same scope in the common case.
2. Stop-set assembly has **zero randomness** — the fill loop sorts deterministically by
   `mandatory` desc, `pacing_score` desc, `campaign_id` asc. Re-running that sort against
   pacing data that's barely moved in the 30-60s between draft and finalize reproduces the
   *same* sequence for every position not directly forced to change.

**Why it's a correctness improvement, not just a simplicity trade:** what's live *today*
for stop-set substitutions (`pickReplacement`) enforces **zero** separation rules —
forward or backward, nothing. Full reassembly at least enforces separation against
everything it builds. So "always full replan for stop-sets" isn't churn-vs-correctness —
it's a straight upgrade over what's currently live, at the cost of one narrower,
already-pre-existing gap (below).

Decision: keep music's already-shipped gap-fill as-is (no further work, no further risk).
Apply "always full replan" to stop-sets going forward, rather than building the harder,
unproven gap-fill machinery for them.

## 8. The already-aired adjacency gap — found, overstated, then corrected

While validating the full-replan decision, a real gap surfaced: `assembleStopSetPlan`'s
separation/adjacency checks live entirely in an in-memory array (`placed`) that starts
empty on every call — no persistence, no connection to `play_history`. First framing: a
full reassembly that fires *mid-break*, after some of that break's own content has
already aired, would rebuild the remainder with zero memory of what already played,
risking a same-advertiser adjacency violation against real content already on air.

**Two challenges from the operator corrected this framing, and both were right:**

1. *"Why would a spot reach its cap after being picked — shouldn't the picker not hand
   it out in the first place?"* — Answered directly: the picker isn't wrong. Between
   draft (segment N starting) and finalize (T-30s before N ends), real time passes, and
   the *same* campaign can air in other breaks elsewhere in the schedule in that window,
   pushing it over its cap for real. The picker was correct under draft-time conditions;
   finalize exists to catch cases where reality moved since then. This part held up.

2. *"Isn't replanning only at finalize, and isn't mid-break lengthening handled as its
   own thing — is this even handled like a plan?"* — This one corrected a real error.
   Checking `supervisor.ts`'s actual state machine: draft for N+1 is requested the moment
   segment N *starts*; finalize for N+1 fires "T-30s before N ends." **Both happen before
   N+1 has aired at all.** All three trigger paths for `PLAN_FINALIZE_REQUESTED` (the
   routine gate, an edit-reconcile path, a cold-start path) fire on plans that haven't
   started airing. So the routine "mid-break reassembly" scenario doesn't really happen —
   finalize is essentially always pre-air. The one narrow exception: a separate mechanism
   (D44, "queue-ahead") can push the *first* item of the next plan into the harbor
   slightly early, and if that item gets confirmed on-air just before the T-30s gate
   fires, it's already `'playing'` by finalize time — at most one item, never several. And
   "ongoing lengthening of an *already-airing* plan" is a genuinely separate mechanism
   (`replanRemaining`, driven by real-time drift correction) that stop-sets are exempted
   from entirely (D73 removed them from drift correction) — so it basically doesn't apply
   here at all.

**The corrected, much smaller fix:** since the exposure is now understood as "at most one
already-committed item, ever," there's no need for a new `play_history` query.
`finalizePlan` already fetches that one possibly-committed item into memory (the
`committedItems` query, today used only to net out its duration) — adding `campaign_id`
to that existing query is the entire "remembering" fix. And whether slot 1 was already
decided reduces to "is `committedItems` non-empty" — no need to check
`play_history.stop_set_position` (which already exists, from D96, and does record this
fact, but isn't even needed given the narrowed scope) — if anything is committed at all
at finalize time, it's provably the break's true position 0, by construction.

## 9. Status as of this document

| Piece | Status |
|---|---|
| Music gap-fill (`finalizeMusicGapFill`) | **Deployed & live**, unit-tested |
| Test infrastructure (vitest) | **Deployed & live**, first in this project |
| Container rebuild (multi-stage + `pnpm deploy`) | **Deployed & live**, verified stable |
| Stop-sets: always full replan (decision) | **Decided**, not yet implemented |
| Committed-item context for stop-set full replan | **Decided** (add `campaign_id` to the existing `committedItems` query; skip slot-1 contest when non-empty), not yet implemented |

Next step, whenever picked back up: implement the stop-set full-replan change plus the
small committed-item-context addition together, since they're the same trigger condition
and the fix is now understood to be small — not the elaborate gap-fill machinery this
document spent most of its length working through and ultimately deciding *against*
building.
