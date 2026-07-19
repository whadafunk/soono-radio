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
| [supervisor-v2-design.md](./supervisor-v2-design.md) | **The living decision log for the current supervisor** (supervisor2) — Decisions 1–106+, including the D96 advertising engine. Start here for scheduler/campaign behavior. |
| [supervisor-rebuild.md](./supervisor-rebuild.md) | HISTORICAL (superseded by V2) — retrospective of the 2026-05-17 V1 rebuild; provenance for the Phase D shadow-tables deferral. |
| [campaign-delivery.md](./campaign-delivery.md) | HISTORICAL (superseded by D96 in the V2 design doc) — V1-era campaign delivery design. |
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
