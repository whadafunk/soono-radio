# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Start for Development

```bash
# Install Node dependencies (one time)
pnpm install

# Install system tools (one time, if not present)
brew install ffmpeg chromaprint python@3.11   # Mac
# apt install ffmpeg libchromaprint-tools python3.11 python3-pip  # Ubuntu

# Set up Python venv + install audio analysis deps (one time)
./apps/api/analysis/setup.sh

# Download Essentia mood models (one time, ~200MB)
./apps/api/analysis/download_models.sh

# Terminal 1: Start Icecast (streaming server)
./start-icecast.sh

# Terminal 2: Start API + Web dev servers (both together)
pnpm dev

# Terminal 3 (optional): Check TypeScript for errors
pnpm type-check
```

**Web dev server**: http://localhost:5173 (hot-reload enabled)  
**API server**: http://localhost:3000  
**Icecast**: http://localhost:8000  

> Python + Essentia are optional for dev — audio analysis (BPM/key/mood) will be skipped gracefully if not installed.

**First task?** Use `/plan` for non-trivial changes. Refer to "Development Workflow & SDLC" below.

**Deploying?** See `docs/deployment.md` — covers Docker Compose (recommended) and Linux install. All system dependencies (ffmpeg, fpcalc, Python 3.11, essentia, mood models) are documented there.

## Project Overview

**Soono**: A radio automation and streaming server that provides station operators with an all-in-one platform to manage broadcasts. The system combines backend streaming infrastructure with a modern web-based control panel.

Core features include:
- Playlist management and scheduling
- Jingle organization and automation
- Real-time player controls
- Stream broadcasting via Icecast
- LiquidSoap integration for audio processing

## Technology Stack

### Production Stacks

| Layer | Tech | Why |
|-------|------|-----|
| **Frontend** | React 18 + TypeScript + Vite | Modern, type-safe, fast dev server |
| **Styling** | Tailwind CSS | Utility-first, responsive by default, pairs with Radix |
| **Forms** | React Hook Form + Zod | Minimal boilerplate, shared validation schemas |
| **State** | Zustand + React Query | Lightweight global state, automatic server caching |
| **Backend** | Fastify + Node.js 20 | Fast I/O, typed, same language as frontend |
| **Database** | SQLite (future) | Zero setup, file-based, good for config storage |
| **Streaming** | Icecast + LiquidSoap | Industry standard radio automation stack |
| **Infra** | Docker Compose | Dev and prod use same containers |

### Monorepo Structure

```
apps/api/      → Fastify backend (Node.js, TypeScript)
apps/web/      → React frontend (Vite, Tailwind)
packages/shared/ → Zod schemas (shared types between API + UI)
icecast/       → Icecast config template
```

**Deployment strategy**: Start with containerized development. Installable versions and Linux distro support can be added later without redesigning the core architecture.

## Architecture Overview

The application has two main components:

1. **Backend**: LiquidSoap audio engine with configuration/control interface
2. **Frontend**: Web-based graphical control panel for operators

Start with implementing LiquidSoap settings control panel, then expand to player, playlist, and jingle management.

## Content Types & Playlists

### Library content categories (all 7)

| Category | Description |
|----------|-------------|
| `music` | Music tracks |
| `spot` | Advertisement spots |
| `promo` | Station promotions |
| `jingle` | Jingles — two subcategories: `stationid` and `show` |
| `bed` | Background music/beds |
| `recording` | General recordings |
| `envelope` | Show/segment bookends — four subcategories: `show_open`, `show_close`, `segment_open`, `segment_close` |

Source of truth: `packages/shared/src/schemas/library.ts` → `MEDIA_CATEGORIES`.

### Playlist types (6)

Playlists exist for every content category **except** `envelope` (envelopes are not playlist-managed today):

`music` · `jingle` · `spot` · `promo` · `bed` · `recording`

Each playlist type only holds content of the matching category (`playlistMediaCategory()` in `packages/shared/src/schemas/playlists.ts`).

**Playlist subcategories** (only relevant fields per type):
- `music`: `standard` · `hot_play` · `heavy_rotation`
- `jingle`: `stationid` · `show`
- All others: none

**Playlist kinds** (music only): `static` (manually ordered) · `dynamic` (rule-matched)

## Implementation Notes

- Begin with container-based development (Docker Compose)
- Focus on core features before adding packaging complexity
- The frontend should provide intuitive control over LiquidSoap settings
- Design the API layer to support future extensibility

### The UI is the spec for scheduling logic

All the scheduling/clock/rotation/campaign logic has been modeled in the UI already. The UI covers nearly every use case the operator could think about — clocks, segments, sources, sweepers, rotations, calendar overrides, campaign constraints, all of it.

When implementing the supervisor/picker/scheduler algorithm — which is genuinely complicated — **the direction can be deduced from the UI**. The UI's option lists, validation rules, defaults, and field combinations encode the intended behavior. Read the relevant pages and components before writing or revising backend logic.

**Additive UI changes are expected and fine.** As features get built out, adding new fields, controls, or pages to surface capability is part of the work. Don't ask before adding.

**Destructive UI changes require explicit confirmation.** Dropping a field, removing a control, replacing an option list with a different one, or renaming something in a way that changes its meaning — STOP and consult the user first. Each field in the UI represents an accumulated thought about how the station should work; once gone, the feature is hard to remember and reconstruct. This rule applies even when the field looks unused or "obviously redundant" — the field is there because at some point the operator decided it should be. If you genuinely believe a control is wrong or redundant, raise it as a question; never delete it in passing.

If you're unsure whether a change is additive or destructive, treat it as destructive and ask.

---

## Development Workflow & SDLC

### Feature Development Process

1. **Planning** (use `/plan` for non-trivial changes)
   - Define scope clearly: what changes, what stays the same
   - Identify affected files and components
   - Confirm tech choices (new dependencies, architectural decisions)

2. **Implementation**
   - Start with API endpoints, then UI
   - Keep commits focused: one feature = one (or a few) related commits
   - Build and test frequently with `pnpm build` and `pnpm dev`
   - Update shared schemas in `packages/shared` before using in other packages

3. **Testing Before Ship**
   - Start the dev server: `pnpm dev` in one terminal, `docker compose up` in another
   - Test the feature end-to-end in the browser at `http://localhost:5173`
   - Check TypeScript: `pnpm type-check`
   - Verify API calls work via browser DevTools Network tab
   - Test error cases (invalid input, server down, timeouts)

4. **Commit & Document**
   - Write clear commit messages: what changed and why (not just what)
   - Update CLAUDE.md if new patterns or gotchas emerge
   - Keep commit history clean; squash work-in-progress commits

### Git Strategy

- **Main branch** is the source of truth — always deployable and tested
- **Commits** should be logical units: one feature, one refactor, one fix
- **Messages** should explain intent: "Add Icecast listener count polling" not "WIP"
- **pnpm-lock.yaml** is checked in; dependency changes are tracked
- Keep `.gitignore` updated; no `node_modules`, `dist`, `.env` files in git

### UI Contrast & Visibility Standards

Text and interactive elements must be readable against the dark background. These classes are too dark for anything the user needs to read or click:

- **Never use for body text or labels:** `text-zinc-600`, `text-zinc-700` — these are near-invisible on dark backgrounds. Use `text-zinc-400` as the minimum for secondary/helper text, `text-zinc-300` for normal text.
- **Never use for interactive icons (X, chevrons, etc.):** `text-zinc-600` or `text-zinc-700`. Use `text-zinc-400` as the default state for clickable icons.
- **Explanation / hint text:** use `text-zinc-400` minimum, not `text-zinc-500` or darker.
- **Read-only / locked state:** `opacity-80` on a card is fine, but text inside must still use `text-zinc-300`+ for content and `text-zinc-400`+ for labels.

When in doubt: if you'd squint to read it, it's too dark.

### Code Quality Standards

**Type Safety**
- TypeScript `strict: true` enforced; no `any` types except justified edge cases
- Shared schemas via `packages/shared` are the source of truth for data shapes
- Frontend and backend must validate with the same Zod schemas

**Forms (React Hook Form + Zod) — silent-failure gotchas**

Three failure modes that produce a form which "does nothing" on submit, with the zod error rendered nowhere visible. All three shipped as real bugs in the campaign forms (fixed 2026-07-19, e6c8378):

- **Never use `valueAsNumber` on a select with an empty option.** The empty value becomes `NaN`, zod rejects with "Expected number, received nan", submit is silently blocked.
- **`setValueAs` also runs against the field's *default* value, not just user input.** `v => v === '' ? null : Number(v)` with a `null` default yields `Number(null) = 0`, which fails `.positive()` on an untouched, fully valid form. Always use the null-safe form: `setValueAs: v => (v === '' || v == null) ? null : Number(v)`.
- **Don't guard sync effects on a fallback-coalesced watch value.** `const watched = useWatch(...) ?? serverValue` makes `watched == null` unfireable once the server value exists — keep the raw watch value separate when an effect needs to test "form value still unset".

Every form must surface validation failures visibly: pass a second argument to `handleSubmit` that collects error paths into a summary rendered next to the submit button (see `collectErrorPaths` in `CustomersList.tsx` / `LiquidSoapSettings.tsx`). A submit button that can fail with no on-screen feedback is a bug.

**Modularity**
- API routes in `apps/api/src/routes/`; services in `apps/api/src/services/`
- React pages in `apps/web/src/pages/`; reusable components in `src/components/`
- No duplicated validation logic; always use schemas from `packages/shared`

**No Technical Debt**
- Don't add `.skip` markers or `// TODO: remove when X` — either do it or don't ship it
- Don't add unused exports, unused dependencies, or backwards-compatibility shims
- Avoid premature abstraction; three similar lines is okay, four is a signal

**Logging & Debugging**
- Backend: Fastify logger (already configured) for all events
- Frontend: React Query DevTools for API request/response inspection
- No `console.log()` in production code; use proper logging
- Browser DevTools Network tab is your friend for API debugging

### Testing Strategy

**Frontend**
- Manual testing in dev mode is the primary validation
- Use React Query DevTools browser extension to inspect server state
- Test happy path AND error states (API down, validation errors, loading states)
- Type checking with `pnpm type-check` catches most bugs

**Backend**
- `apps/api` uses vitest (added 2026-07-22). Run with `pnpm --filter api test` (or `pnpm test` from the root, which runs `test` across every workspace package that defines one). Watch mode: `pnpm --filter api test:watch`. Test files live next to the code they cover, named `*.test.ts` (see `apps/api/src/services/supervisor2/processes/musicGapFill.test.ts`).
- DB- and bus-coupled code (drizzle client, the supervisor2 bus) isn't easily unit-testable as-is — importing `db/index.ts` opens a real libsql connection at module load. When a piece of logic is worth a real test, prefer extracting the pure/decision-making part into its own dependency-free module (type-only imports of shapes like `PlanItem`/`MusicCandidate` are fine — they're erased at compile time) rather than mocking the DB or the bus.
- Write minimal integration tests for new API endpoints
- Test against real Icecast XML file (mocking not recommended for config changes)
- Validate Zod schemas catch all malformed input before hitting logic
- Use Docker Compose to test with real Icecast container

**End-to-End**
- `docker compose up` should boot all services without errors
- Test full user flow: load page → fetch data → edit → save → see changes
- Check Icecast restart works: trigger save, verify XML updated, confirm Icecast running

### Feature Prioritization & Iteration Strategy

**Current Roadmap** (in order):
1. ✓ UI shell + Icecast settings form (done)
2. Live dashboard stats (Icecast admin API polling)
3. LiquidSoap control panel
4. Playlist management
5. Jingle organization
6. Billing: rate card and invoice generation based on campaign duration_bracket x plays_per_month

**Iteration Size** 
- Each iteration should be shippable in 1-3 commits
- Prefer small, focused changes over big rewrites
- If a change is >500 LOC or touches >5 files, reconsider scope

**What "Done" Means**
- TypeScript builds with zero errors
- Feature works end-to-end in dev browser
- API and UI are wired together
- Commit message explains why, not just what
- No console errors in browser DevTools

### Performance & Reliability

**API Layer**
- Validate all input with Zod; let schemas define the contract
- File I/O (Icecast config) should handle read/write errors gracefully
- React Query handles retries and caching automatically
- Set sensible timeouts; don't let hanging requests block the UI

**Frontend Performance**
- Code-split pages via React Router (automatic with Vite)
- Use `useMutation` for non-idempotent operations (config writes)
- Use `useQuery` for reads with automatic caching and refetch strategies
- No N+1 queries; batch requests when possible

**Icecast Container**
- Start with `./start-icecast.sh` — runs the official Icecast image with your config mounted
- Check logs with `docker logs radio-icecast` for errors
- Volume mount ensures XML config persists and API can read/write it from localhost
- Run `docker stop radio-icecast` to shut it down

### Database Migrations

The API uses Drizzle ORM with libsql. Migrations live in `apps/api/drizzle/` and run automatically on server start via `migrate()`.

**Always use `drizzle-kit generate` to create migrations** — never write migration files by hand:

```bash
cd apps/api
pnpm drizzle-kit generate   # diffs schema.ts against last snapshot, creates new .sql + journal entry
```

This matters because the Drizzle libsql migrator uses the `when` timestamp in `_journal.json` to decide which migrations to run. It skips any migration whose `when` is ≤ the `created_at` of the last applied migration in `__drizzle_migrations`. Manually-written files with old or wrong timestamps are **silently skipped forever**. `drizzle-kit generate` always stamps the file with the current time, so order is always correct.

**SQLite cannot `DROP COLUMN` reliably** (libsql does not support it). If you need to remove a column:
1. Use `drizzle-kit generate` — it will emit a full table-recreation migration (CREATE new → copy data → DROP old → RENAME).
2. Do not hand-write `ALTER TABLE ... DROP COLUMN` in a migration; it will fail silently or error at runtime.

**Adding a nullable FK column to an *existing* table silently drops `onDelete`.** `drizzle-kit generate` emits a plain `ALTER TABLE ... ADD COLUMN ... REFERENCES x(id)` for this case — SQLite's ADD COLUMN form has no way to carry an `ON DELETE` clause, so whatever you declared in `schema.ts` (`onDelete: 'set null'`, `'cascade'`, etc.) is silently **not** applied to the live table, even though drizzle-kit's own snapshot believes it was. `drizzle-kit generate` run again later sees "no changes" — it has no way to detect the drift, since it diffs against its own snapshot, not the live DB. Found in production 2026-07-04 (`play_history.clock_segment_id` and three other columns) after this exact gap caused a 500 when deleting a `clock_segments` row that had play history logged against it — the FK defaulted to NO ACTION, blocking the delete instead of clearing the reference.
- After adding a column like this, inspect the emitted `.sql` file — if it's a bare `ALTER TABLE ... ADD COLUMN ... REFERENCES`, the `onDelete` didn't make it in.
- Fix: `drizzle-kit generate --custom`, then hand-write a full table-recreation migration (CREATE `__new_x` with the FK clause spelled out including `ON DELETE` → copy data → DROP → RENAME → recreate indexes) — same shape as the DROP COLUMN case above.

**Known schema drift (intentional, harmless):**  
`shows.type` and `shows.active` exist in the DB but are absent from `schema.ts`. They were removed from the application in May 2026 but could not be dropped via migration (libsql limitation). Drizzle ignores columns it doesn't know about — all reads/writes use explicit column lists, so these columns are inert. They have DB-level defaults (`type='automated'`, `active=1`) and do not affect any application logic.

**If a migration must be applied manually** (e.g. to fix a timestamp ordering problem):
```bash
# 1. Apply the SQL directly
sqlite3 data/radio.db "ALTER TABLE foo ADD COLUMN bar integer;"

# 2. Compute the hash of the .sql file
node -e "const {createHash}=require('crypto'),{readFileSync}=require('fs'); \
  console.log(createHash('sha256').update(readFileSync('apps/api/drizzle/NNNN_tag.sql','utf8')).digest('hex'))"

# 3. Record it so the migrator won't try to re-run it
sqlite3 data/radio.db "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('<hash>', <when_ms>);"
```
`<when_ms>` must be greater than the `created_at` of the last row in `__drizzle_migrations` (check with `SELECT MAX(created_at) FROM __drizzle_migrations;`). Also update the `when` field in `_journal.json` to match.

### Documentation & Knowledge

- **CLAUDE.md** (this file) is the developer guide; update it as patterns emerge
- **README.md** documents project overview, setup, and common commands
- **Commit messages** are the changelog; write them for future maintainers
- **Code comments** only explain non-obvious WHY, not obvious WHAT
- Add comments around business logic, Icecast XML quirks, and workarounds
