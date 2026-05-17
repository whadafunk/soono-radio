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

---

## UI Design Standards

### Shared constants — `apps/web/src/ui.ts`

Single source of truth for recurring Tailwind patterns. Import from here; never inline the same class string twice.

| Export | When to use |
|--------|-------------|
| `BTN_PRIMARY` | Primary action in modals and standalone forms |
| `BTN_PRIMARY_SM` | Primary action in page headers and toolbars |
| `BTN_SECONDARY` / `BTN_SECONDARY_SM` | Cancel, Discard, neutral actions |
| `BTN_DESTRUCTIVE` / `BTN_DESTRUCTIVE_SM` | Delete and other irreversible actions |
| `BTN_GHOST` | Icon-only or minimal buttons (rarely used — prefer inline classes for one-off cases) |
| `INPUT` | All text/number/textarea inputs |
| `SELECT` | All `<select>` dropdowns |
| `LABEL` | Form field labels (use with `Field` component or directly) |
| `CARD` | Container panels with border |
| `MODAL_OVERLAY` / `MODAL_BOX` | Modal backdrop and content box |

Only add a constant when the pattern appears in 3+ places. Layout concerns (width, margin) stay at the call site.

---

### Header action buttons

Page headers that have save/delete/bulk actions follow a fixed pattern:

- All action buttons are **always visible** — never conditionally rendered. Buttons that require a selection are `disabled` when the condition is not met, with a native `title` tooltip explaining why.
- Use `*_SM` size variants (`BTN_PRIMARY_SM`, `BTN_SECONDARY_SM`, `BTN_DESTRUCTIVE_SM`) in headers and toolbars. Full-size variants are for modals only.
- Separate logically distinct groups with a thin vertical divider: `<div className="w-px h-5 bg-zinc-700 mx-1" />`. Typical grouping: destructive actions | neutral + primary actions.
- Destructive confirmation uses `window.confirm()` inline — no separate confirmation UI unless the action is truly irreversible and high-stakes.

```tsx
<div className="flex items-center gap-2">
  <button disabled={selectedIds.size === 0} title="Select items to delete" className={BTN_DESTRUCTIVE_SM}>
    <Trash2 className="w-3.5 h-3.5" /> Delete
  </button>
  <div className="w-px h-5 bg-zinc-700 mx-1" />
  <button className={BTN_PRIMARY_SM}>
    <Plus className="w-3.5 h-3.5" /> New Item
  </button>
</div>
```

---

### Bulk actions vs. single-item actions

**Bulk actions** appear in the list page header (always visible, disabled when no items selected). Only include operations that genuinely apply to multiple items at once — e.g. Delete.

**Single-item actions** (Edit, Open, View Detail) are not bulk actions. Clicking a row navigates to the detail page. Do not add an Edit button to the list header.

---

### Detail page layout

```
[← back]  [Color dot]  [Page Title]  ·  [Context label]  [Status badge]    [Delete] | [Discard] [Save]
┌─────────────────────────────────────────────────┐   ┌──────────────────┐
│  [Tab: Configuration]  [Tab: Media Content]     │   │  Panel: This Week│
│─────────────────────────────────────────────────│   ├──────────────────┤
│  … form fields …                                │   │  Panel: Campaigns│
└─────────────────────────────────────────────────┘   └──────────────────┘
```

- **Back chevron**: `text-zinc-400 hover:text-white transition-colors`, icon `w-5 h-5`. No padding box, no hover background.
- **Context label**: `<span className="text-zinc-600 select-none">·</span> <span className="text-sm text-zinc-500">Page Type</span>` — reinforces where the user is without competing with the title.
- **Header buttons and form card share the same right edge** — wrap them in a common flex column so they align naturally.
- **Right column** (`w-64 flex-shrink-0`): read-only info panels (schedule, related entities, future stats). Never put editable fields here.

---

### Tabs

Use tabs when a detail form has 6+ fields that fall into two distinct categories. Standard split:

| Tab | Contents |
|-----|----------|
| **Configuration** | Identity fields (name, color, notes), scheduling settings (duration, clock, policies) |
| **Media Content** | Audio assets (intro/outro clips, jingle playlist, bed playlist, music playlists) |

Tab bar pattern:
```tsx
{(['configuration', 'media-content'] as const).map((tab) => (
  <button
    type="button"
    onClick={() => setActiveTab(tab)}
    className={`mr-6 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
      activeTab === tab ? 'border-indigo-500 text-white' : 'border-transparent text-zinc-400 hover:text-zinc-200'
    }`}
  >
    {tab === 'configuration' ? 'Configuration' : 'Media Content'}
  </button>
))}
```

---

### Contextual help

**Every form field gets a `HelpTooltip`** next to its label. This is a design standard — not optional.

```tsx
import { HelpTooltip } from '../../components/HelpTooltip';

<Field label={<span className="flex items-center gap-1">Field Name <HelpTooltip text="Explanation." /></span>}>
  ...
</Field>
```

For section headings (`h2`), add the tooltip inline:
```tsx
<h2 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-zinc-400">
  Section Title <HelpTooltip text="Explanation." />
</h2>
```

**Option names** that refer to a specific selectable value should be visually distinguished in the tooltip text using JSX:
```tsx
<HelpTooltip text={<>Choose <span className="font-semibold text-white">Repeat last clock</span> to tile the previous hour, or <span className="font-semibold text-white">Fall through</span> to continue without structure.</>} />
```

`HelpTooltip.text` accepts `React.ReactNode`, so JSX fragments are fine.

---

### Accordion lists

When a list item has secondary/advanced controls (e.g. rotation tier, fallback config), hide them behind a per-item expand/collapse toggle rather than rendering everything inline. This keeps the list scannable at a glance.

Pattern: collapsed row shows name + primary control + remove button. Expanded shows secondary controls in a bordered sub-panel. Use `ChevronRight` with `rotate-90` on open.

```tsx
const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
const toggleExpanded = (id: number) =>
  setExpandedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
```
