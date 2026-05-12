# Frontend

## Stack
- React 18 + TypeScript + Vite
- Tailwind CSS (utility-first)
- React Router v6 (client-side routing, code-split pages)
- TanStack Query v5 (server state, caching, mutations)
- React Hook Form + Zod (forms + validation)
- Zustand (local UI state, minimal usage)
- Radix UI primitives (accessible components)

---

## Routing Structure

```
/                     Dashboard
/library              LibraryBrowse
/library/upload       LibraryUpload
/customers            CustomersList
/schedule             SchedulePage
/shows                ShowsPage
/shows/:id            ShowDetailPage
/clocks               ClocksPage
/rotations            RotationsPage
/playlists            (coming soon placeholder)
/settings/icecast     IcecastSettings
/settings/liquidsoap  LiquidSoapSettings
/settings/supervisor  SupervisorSettings
/settings/certs       CertificatesSettings
/settings/users       UsersSettings
```

---

## Pages

### Dashboard (`pages/Dashboard.tsx`)
Real-time station overview.
- Icecast stats: listeners, bitrate, uptime (polls every 3s)
- Now Playing card: current track title, artist, source (auto/live), progress bar
- Recent Plays table: last 8 tracks with timestamp and source
- Mount points list with "Kick Source" button (SSL stale-source bug workaround)
- Quick actions: Restart Icecast, Restart LiquidSoap

### LibraryBrowse (`pages/library/LibraryBrowse.tsx`)
Audio file management.
- Filter bar: category, search (title/artist), date range
- Sortable columns: title, artist, duration, bitrate, play_count, created_at
- Click row → inline metadata editor (title, artist, cue_in/out, favorite, category)
- Bulk actions: change category, favorite, delete (checkbox select)
- Ingest job progress cards (polling until completed/failed)

### LibraryUpload (`pages/library/LibraryUpload.tsx`)
Audio ingest entry point.
- Select category first (required)
- Drag-and-drop or click to select files (multipart upload)
- Per-file progress: queued → analyzing → transcoding → complete/error
- On completion, navigates to library browse

### CustomersList (`pages/customers/CustomersList.tsx`)
Advertiser and campaign management.
- Tabbed: Customers | Campaigns
- Customer list with inline edit
- Campaign list with delivery stats
- Campaign media section (add/remove spots and sweeps)
- Campaign pacing indicator (on track / behind)

### SchedulePage (`pages/schedule/SchedulePage.tsx`)
Weekly schedule editor.
- 7-column calendar (Mon–Sun), 24 rows per day
- Drag to create blocks: drag a time range → modal to pick show or clock
- Color-coded blocks by show color
- Template entries (recurring) rendered differently from calendar overrides (one-off)
- Click block → edit modal (change time, show, clock, or delete)
- Toggle: show template view / show this week's calendar

### ShowsPage (`pages/shows/ShowsPage.tsx`)
- List shows with type badge (live/automated/prerecorded) and color swatch
- "New Show" button → creation modal (name, type, color, host, producer, duration_minutes, notes)
- Click show → navigate to ShowDetailPage

### ShowDetailPage (`pages/shows/[id].tsx`)
Detailed show configuration.
- Edit all show metadata inline
- Associate show playlists per rotation tier (hot/medium/cold)
- For each tier: select playlist, select rotation algorithm, set fallback tier
- Link intro and outro media (searchable media picker)

### ClocksPage (`pages/clocks/ClocksPage.tsx`)
Clock template editor.
- List clocks with segment count
- "New Clock" → creation modal
- Open clock → full segment editor:
  - Drag to reorder segments
  - Add/remove segments
  - Per-segment config panel: type, duration, source, delay policy, recovery tactics, clips, bed
- Changes saved via `PUT /clocks/:id/segments` (full replacement, atomic)

### RotationsPage (`pages/rotations/RotationsPage.tsx`)
- List rotations by type
- Create/edit rotation with type-specific param form
- Param forms adapt to selected type (different fields per algorithm)

### Settings Pages
All under `/settings/`:

**IcecastSettings** — Full form for Icecast XML config sections: server, authentication, limits, mount points, logging. Save triggers restart.

**LiquidSoapSettings** — Output (bitrate, codec, mount), Harbor (port, password, TLS cert), Crossfade (duration, curve), Master bus, Ducking config.

**SupervisorSettings** — Tick intervals, queue threshold, separation_minutes, mid_hour_handoff. Save + Restart button.

**CertificatesSettings** — Upload PEM files, list certs with expiry, delete.

**UsersSettings** — CRUD for operator user accounts.

---

## State Management

### TanStack Query (server state)
All API data flows through React Query. Pattern:

```typescript
// Fetch
const { data: shows } = useQuery({
  queryKey: ['shows'],
  queryFn: () => api.get('/shows'),
})

// Mutate + invalidate
const { mutate: createShow } = useMutation({
  mutationFn: (body) => api.post('/shows', body),
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shows'] }),
})
```

Refetch intervals:
- Dashboard stats (Icecast, now-playing): 3s
- Recent plays: 5s
- Library ingest jobs: 2s (while jobs are pending, stop when all done)
- All other data: on-demand (staleTime = 30s default)

### Zustand (local UI state)
Used for:
- Modal open/close state
- Draft form values not yet submitted
- Sidebar collapsed state

### React Hook Form + Zod
All forms use the same Zod schemas as the API. Validation errors surface inline on fields.

```typescript
const schema = z.object({ name: z.string().min(1), ... })
const form = useForm({ resolver: zodResolver(schema) })
```

---

## API Client

Thin wrapper around `fetch` in `apps/web/src/lib/api.ts`:
- Base URL from `VITE_API_URL` env var (default `http://localhost:3000`)
- Throws on non-2xx responses (React Query catches and exposes as `error`)
- Handles JSON serialization/deserialization

---

## Component Conventions

- **Page components** own data fetching (useQuery) and mutation handlers
- **Form components** receive onSubmit callback, manage their own local state
- **Modal components** are controlled (open/onClose props from parent)
- **Table components** receive data as props; sorting is local state
- No prop drilling beyond 2 levels — use React Query cache or Zustand for shared state
