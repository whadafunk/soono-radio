# Station timezone (design)

**Status: design agreed in conversation 2026-11-25, awaiting approval. Nothing built.**
**Prerequisite for the Recordings work (`reports-recordings-design.md`).**

## Intent

Clock times in the schedule should mean what the studio clock says. Today they
do not: every clock time in the app (shows, calendar and template slots,
campaign time windows, campaign start and end dates) is stored as a plain time
such as `08:00`, and the API turns it into a real moment using its own
container's clock, which in production is UTC. A slot entered as `08:00` airs at
10:00 Romanian time in winter and 11:00 in summer; campaign days and "today"
roll over at 02:00 or 03:00 local. Nobody chose this — the app simply has no
notion of a station timezone. On the developer's Mac the same code runs in
Romanian time, which is why it never showed up in development.

## Goals

- One **station timezone** setting, default `Europe/Bucharest`, that every
  clock time and calendar day in the backend is read in.
- Changing it takes effect without redeploying or editing files.
- The operator can see which timezone the station is running on.

## Non-goals

- Changing how anything is stored. Clock times stay plain (`08:00`); moments
  that happened stay absolute timestamps.
- Making the web pages follow the station timezone. They display times in the
  browser's timezone; the operator confirmed the app is only ever opened from
  Romania, so the two are the same.
- Shifting existing schedule entries. The operator does not care about the
  current schedule (a single clock template, no shows); it will be replaced by a
  real calendar later.
- Special handling of the two nights a year the clocks change. A slot inside
  the skipped or repeated hour is shortened or stretched that night. Accepted.
- Setting a timezone on any container in `docker-compose.yml`.

## Anti-goals

- Two sources of truth for the timezone (a setting and a container variable
  that can disagree).
- A timezone change that silently leaves the supervisor running a plan chosen
  under the old timezone with no reconcile.

## Approaches considered

1. **The setting sets the API process's timezone — chosen.** The API reads the
   setting at startup and on save and applies it to itself
   (`process.env.TZ`). All existing code that asks "what hour / day is it"
   then answers in station time, with no rewrite. Verified on the live image
   (2026-11-25): the change is honoured at startup and at runtime, including
   summer time.
2. **`TZ` in the compose file.** Same effect on the backend, but the value
   lives in a file on the server, cannot be changed from the app, and cannot
   be shown or validated by it. Rejected as the hidden version of approach 1.
3. **Rewrite every time read to name the timezone explicitly** (a date
   library, zone passed everywhere). The most explicit, but it means touching
   about 57 call sites in the scheduler, campaign pacing and spot budget — the
   riskiest code in the project — for the same outcome. Rejected for now.

## Design

### The setting

- New column on `station_settings`: `timezone`, text, default
  `Europe/Bucharest` (generated with `drizzle-kit generate`).
- `PATCH /settings/station` accepts it; the value is validated as a real zone
  name (the runtime's own list) — never a numeric offset, because Romania's
  offset changes twice a year and the zone name carries that.
- UI: a field on the existing scheduling settings page, a searchable list of
  zone names, with the current station time shown beside it. *(Placement is my
  call.)* The form says the change is cleanest while the station is Off Air.
- The station timezone and current station time are shown somewhere always
  visible (the Dashboard header is the expected place). *(My call.)*

### Applying it

- At startup: after database migrations and **before** the supervisor
  processes start, the API reads the setting and applies it to its own
  process. Nothing that reads clock time runs before that point.
- On save: apply immediately, then request a supervisor reconcile, the same
  way schedule edits already do. Which clock or show covers "now" may have
  changed, and the existing rules decide whether that takes effect at once or
  at the next segment boundary.
- Stored moments are untouched: plans, play history and logs hold absolute
  times. Hour boundaries are identical in both zones (the offset is a whole
  number of hours), so the hourly clock instances already drafted still line up.

### What follows the setting with no code change

Everything that reads local hour or local day in the API process — about 57
places:

| Area | Files |
|---|---|
| Which clock / show is on now | `supervisor2/clockResolver.ts` |
| Campaign time windows, daily and weekly pacing | `supervisor2/processes/campaign.ts`, `services/campaignValidator.ts`, `routes/customers.ts`, `routes/musicCampaigns.ts` |
| Spot budget | `services/spotBudget.ts` |
| Rundown and music day logic | `routes/rundown.ts`, `supervisor2/processes/rundown.ts`, `supervisor2/processes/music.ts` |
| "Today" figures | `routes/supervisorStatus.ts` |
| Retention cut-off (start of previous month) | `services/maintenance/dbRetention.ts` |

### What needs looking at, one by one

Places that mix local dates with UTC date strings. They agree today only
because the container is UTC:

- `routes/schedule.ts` — the calendar week window and the date enumeration.
- `apps/shared` `scheduling.ts` — "start date cannot be in the past" computes
  today in UTC.
- Any other `toISOString()`-based date found while doing this.

Each is checked for a wrong day in the hours around local midnight and fixed
to use the station's local date.

### Logs

API log lines carry absolute timestamps and are unaffected. Mix engine and
Icecast log lines are written in their containers' time, which stays UTC; the
Logs page labels them as UTC. *(My call.)*

### The mix engine container

Pinned to UTC explicitly (`TZ=UTC`) so recording file names never depend on
host settings. That is a pin of today's behaviour, not a station-time setting,
and is done as part of the Recordings work.

## Tests

- Resolver tests run under `Europe/Bucharest`: an ordinary day, the hour either
  side of local midnight, the March night (hour skipped) and the October night
  (hour repeated). The resolver's date logic is pure enough to test with a
  fixed clock.
- The same cases for the campaign day and week boundaries.

## Rollout

- The station is Off Air at the time of writing, which is the clean moment.
- On deploy the default applies at once: the schedule moves two hours earlier
  in real terms (three in summer), and campaign days start at local midnight.
  Delivery counts for the day of the switch may look uneven; history is not
  rewritten.
- The migration adds one column with a default; no data conversion.

## Left to the builder

- Exactly where on the scheduling settings page the field goes, and the
  Dashboard placement of the station clock.
- How the list of zone names is presented (full list vs. a short common list
  with search).
- Whether the three mixed-date spots share a small helper for "station-local
  date string".
