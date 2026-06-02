# Soono — Documentation Index

## What is this?

A full-stack radio automation and streaming server. Radio operators use it to manage broadcast scheduling, playlists, jingles, ads, and live/automated shows. Audio is streamed via Icecast, driven by LiquidSoap, and controlled through a React web UI backed by a Fastify API.

## Quick Start

```bash
pnpm install
./start-icecast.sh          # Terminal 1: Icecast container
pnpm dev                    # Terminal 2: API (port 3000) + Web (port 5173)
pnpm type-check             # Verify TypeScript
```

## Docs

| Document | What it covers |
|----------|---------------|
| [architecture.md](./architecture.md) | System overview, data flow, component map |
| [scheduling.md](./scheduling.md) | **The complex part** — clocks, segments, supervisor, delay policy, drift recovery |
| [supervisor-rebuild.md](./supervisor-rebuild.md) | Retrospective + design rationale for the 2026-05-17 supervisor rebuild. Includes the Phase D shadow-tables deferral with conditions for revisiting. |
| [data-model.md](./data-model.md) | All database entities, fields, relationships |
| [api-reference.md](./api-reference.md) | Every API endpoint with params and responses |
| [frontend.md](./frontend.md) | Pages, routing, state management |
| [campaigns.md](./campaigns.md) | Customers, campaigns, ad pacing logic |
| [ingest.md](./ingest.md) | Audio upload → analyze → transcode → library pipeline |
| [roadmap.md](./roadmap.md) | What's built, what's next, design intent |
| [operations.md](./operations.md) | Running, configuring, debugging |

## Key files to know

```
apps/api/src/
  routes/          All API route handlers
  services/
    supervisor/    Scheduler + Picker + MetadataWatcher (the real-time engine)
    ingest/        Upload → transcode pipeline
  db/
    schema.ts      Drizzle ORM schema (source of truth for data shapes)

apps/web/src/
  pages/           One file per page/feature
  components/      Shared UI components

packages/shared/src/
  schemas/         Zod schemas shared between API and UI
```
