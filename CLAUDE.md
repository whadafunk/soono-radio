# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Start for Development

```bash
# Install dependencies (one time)
pnpm install

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

That's it! The frontend and backend both auto-reload on file changes.

**First task?** Use `/plan` for non-trivial changes. Refer to "Development Workflow & SDLC" below.

## Project Overview

**Radio Automation and Streaming Server**: A complex application that provides radio station operators with an all-in-one platform to manage broadcasts. The system combines backend streaming infrastructure with a modern web-based control panel.

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

## Implementation Notes

- Begin with container-based development (Docker Compose)
- Focus on core features before adding packaging complexity
- The frontend should provide intuitive control over LiquidSoap settings
- Design the API layer to support future extensibility

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

### Code Quality Standards

**Type Safety**
- TypeScript `strict: true` enforced; no `any` types except justified edge cases
- Shared schemas via `packages/shared` are the source of truth for data shapes
- Frontend and backend must validate with the same Zod schemas

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

### Documentation & Knowledge

- **CLAUDE.md** (this file) is the developer guide; update it as patterns emerge
- **README.md** documents project overview, setup, and common commands
- **Commit messages** are the changelog; write them for future maintainers
- **Code comments** only explain non-obvious WHY, not obvious WHAT
- Add comments around business logic, Icecast XML quirks, and workarounds
