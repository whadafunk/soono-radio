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

### Inline field validation

When a field has a constraint (unique name, required value, format), validate inline — never rely on server errors or alert dialogs. Three things happen together when a constraint is violated:

1. **Red border** on the input
2. **Error message** below the input (`text-xs text-red-400`)
3. **Submit button disabled**

```tsx
const hasConflict = items.some(
  (item) => item.id !== currentId && item.name.trim().toLowerCase() === value.trim().toLowerCase()
);

<input
  value={value}
  onChange={(e) => setValue(e.target.value)}
  className={`${INPUT} ${hasConflict ? 'border-red-500 focus:border-red-500' : ''}`}
/>
{hasConflict && (
  <p className="mt-1.5 text-xs text-red-400">A rotation with this name already exists.</p>
)}

<button disabled={!value.trim() || hasConflict || isPending} className={BTN_PRIMARY}>
  Save
</button>
```

- Only show the error when the field has a value — don't flag an empty field as a conflict.
- For uniqueness checks, compare case-insensitively and exclude the current item's own id.
- Apply the same pattern in both creation modals and inline editors.

---

### Save status feedback

After any mutation, show transient feedback using `<SaveStatus>` placed in the header row between the page title and the action buttons. It renders nothing when `status` is null.

**Three types — choose by the nature of the action, not success/failure:**

| Type | Color | Use for |
|------|-------|---------|
| `success` | Green | Save, create, any constructive action |
| `error` | Red | Failed mutations AND successful destructive actions (delete) |
| `warning` | Amber | State changes that aren't destructive but aren't neutral either (set as default, enable/disable) |

```tsx
import { SaveStatus } from '../../components/SaveStatus';

// Three-part header: title | status (flex-1) | buttons
<div className="flex items-center gap-4 flex-shrink-0">
  <h1 className="text-xl font-semibold text-white flex-shrink-0">Page Title</h1>
  <div className="flex-1"><SaveStatus status={saveStatus} /></div>
  <div className="flex items-center gap-2 flex-shrink-0">{/* buttons */}</div>
</div>

// State + helper
const [saveStatus, setSaveStatus] = useState<{ type: 'success' | 'error' | 'warning'; message: string } | null>(null);
const showSaveStatus = (type: 'success' | 'error' | 'warning', message: string) => {
  setSaveStatus({ type, message });
  setTimeout(() => setSaveStatus(null), 3000);
};

// Examples
onSuccess: () => showSaveStatus('success', 'Rotation saved'),
onSuccess: () => showSaveStatus('error', 'Rotation deleted'),      // destructive, even though it succeeded
onSuccess: () => showSaveStatus('warning', '"X" set as default'),  // state change
onError:   (e) => showSaveStatus('error', (e as Error).message),
```

Auto-dismisses after 3s. Source: `apps/web/src/components/SaveStatus.tsx`.

---

### Destructive action confirmation

Never use `window.confirm()`. Instead use a two-click pattern: first click arms the button for 4 seconds, second click executes.

```tsx
const [confirmingDelete, setConfirmingDelete] = useState(false);
const deleteConfirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

// Reset if selection changes
useEffect(() => {
  if (confirmingDelete) {
    setConfirmingDelete(false);
    if (deleteConfirmTimer.current) clearTimeout(deleteConfirmTimer.current);
  }
}, [checkedIds]);

const handleDeleteClick = () => {
  if (confirmingDelete) {
    if (deleteConfirmTimer.current) clearTimeout(deleteConfirmTimer.current);
    setConfirmingDelete(false);
    deleteMutation.mutate([...checkedIds]);
  } else {
    setConfirmingDelete(true);
    deleteConfirmTimer.current = setTimeout(() => setConfirmingDelete(false), 4000);
  }
};

// Button
<button
  onClick={handleDeleteClick}
  disabled={checkedIds.size === 0}
  className={`${BTN_DESTRUCTIVE_SM} ${confirmingDelete ? 'ring-2 ring-red-400 ring-offset-1 ring-offset-zinc-900 animate-pulse' : ''}`}
>
  <Trash2 className="w-3.5 h-3.5" />
  {confirmingDelete ? 'Click again to delete' : `Delete${checkedIds.size > 0 ? ` (${checkedIds.size})` : ''}`}
</button>
```

When armed: button label changes to **"Click again to delete"** and a red ring + pulse animation draws attention. Resets automatically after 4s or immediately if the selection changes.

---

### Table column headers

Column headers use `px-4 py-2 text-xs font-semibold uppercase tracking-wider`. Separate columns with `border-r border-zinc-700`. The checkbox column (when present) gets a fixed `w-10` or `w-12`.

```tsx
<thead className="bg-zinc-800/60">
  <tr className="border-b border-zinc-700">
    <th className="px-4 py-2 w-12 border-r border-zinc-700">{/* checkbox */}</th>
    <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider border-r border-zinc-700 text-zinc-400">
      Column Name
    </th>
  </tr>
</thead>
```

---

### Sortable table columns

Active sort column header text stays `text-white`; inactive columns use `text-zinc-400 hover:text-zinc-200`. Never revert the active column to dim on hover — the persistent highlight tells the user which column is currently sorted. Use `ChevronDown`/`ChevronUp` icons (`w-4 h-4`) — active in `text-indigo-400`, inactive in `text-zinc-400`.

```tsx
<th
  onClick={() => handleSort('title')}
  className={`px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider border-r border-zinc-700 cursor-pointer select-none transition-colors ${
    sortCol === 'title' ? 'text-white' : 'text-zinc-400 hover:text-zinc-200'
  }`}
>
  <span className="flex items-center gap-1">
    Title
    <ChevronUp className={`w-4 h-4 flex-shrink-0 ${sortCol === 'title' ? 'text-indigo-400' : 'text-zinc-400'}`} />
  </span>
</th>
```

---

### Modal header

Modal headers use `px-6 py-4 border-b border-zinc-700 flex items-center justify-between`. The title is `text-lg font-semibold text-white`. Icon buttons in the top-right corner use `p-1.5 rounded transition-colors`.

- **Close (X)**: always present. `text-zinc-400 hover:text-white hover:bg-zinc-700`
- **Delete (Trash2)**: present when the modal edits an existing record. `text-zinc-500 hover:text-red-400 hover:bg-red-900/20`. Place it to the left of the X.

```tsx
<div className="px-6 py-4 border-b border-zinc-700 flex items-center justify-between">
  <h2 className="text-lg font-semibold text-white flex-1 truncate">{title}</h2>
  {/* Delete — only in edit modals */}
  <button
    onClick={onDelete}
    title="Delete"
    className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors"
  >
    <Trash2 className="w-4 h-4" />
  </button>
  {/* Always present */}
  <button
    onClick={onClose}
    className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-700 rounded transition-colors"
  >
    <X className="w-4 h-4" />
  </button>
</div>
```

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

**Two tab contexts, same visual rules:**

**Horizontal tab bar** (detail pages — tabs above a single form card):
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

**Vertical filter tab strip** (split-panel pages — tabs at the top of the left panel card):
```tsx
<div className="flex border-b border-zinc-800">
  {(['all', ...KINDS] as const).map((k) => (
    <button
      key={k}
      onClick={() => setFilter(k)}
      className={`flex items-center justify-center gap-1.5 px-4 py-3.5 text-xs font-medium transition-colors ${
        filter === k ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
      }`}
    >
      {Icon && <Icon className="w-3 h-3" />}
      {k === 'all' ? `All (${items.length})` : `${LABELS[k]} (${items.filter(i => i.kind === k).length})`}
    </button>
  ))}
</div>
```

- **Do not use `flex-1`** — tabs size to their content with `px-4` padding. Equal-width tabs look fine when labels are similar length, but cramp longer labels and waste space on short ones.
- **Include item counts** in parentheses in every tab label — helps the user know what each filter will show before clicking.
- **Do not use the underline (`border-b-2`) pattern.** The left panel list items use a left border (`border-l-2`) for their selected state. When both use `border-indigo-500`, the tab's bottom line and the first item's left line meet at a 90° angle and read as a single connected shape. Background fill (`bg-zinc-800`) is scoped to the tab itself and avoids this confusion.

**"All" tab — collapsible sections by type:** When an "All" tab shows items of multiple types, group them into collapsible sections rather than a flat list. Each section has a header row (chevron + type icon + label + count) that toggles collapse. Default: all expanded.

```tsx
const [collapsedKinds, setCollapsedKinds] = useState<Set<Kind>>(new Set());
const toggleKindCollapsed = (k: Kind) =>
  setCollapsedKinds((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

// Section header
<button onClick={() => toggleKindCollapsed(k)}
  className="w-full flex items-center gap-2 px-3 py-2 border-b border-zinc-800/60 bg-zinc-800/40 hover:bg-zinc-800/70 transition-colors">
  <ChevronRight className={`w-3 h-3 text-zinc-300 transition-transform ${collapsed ? '' : 'rotate-90'}`} />
  <KindIcon className="w-3 h-3 text-zinc-300" />
  <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">{LABELS[k]} ({group.length})</span>
</button>
{!collapsed && group.map(renderItem)}
```

- **Count placement:** put the count in parentheses directly after the label — `Music (3)` — not as a separate right-aligned element. A floating right-side number reads as a separate column and creates visual noise; inline keeps the label and its quantity together as one unit.

**Tab height and content alignment:** In split-panel layouts the left panel's tab strip sits flush at the top of its card. The right card's top padding must be set so its first label's text center is at approximately the same vertical position as the tab text center. With `py-3.5` tabs (text center ≈ 20px from card top), use `px-5 pb-5 pt-3` on the right card (label center ≈ 18px). Never use a uniform `p-5` on the right card when the left panel has a tab strip — it pushes the first label ~10px below the tabs.

---

### Contextual help

`HelpTooltip` belongs **only inside forms and detail pages**, on fields that carry domain-specific meaning a new user wouldn't know. Self-explanatory fields (Name, Notes, dates) do not get tooltips. View titles, section headers, and table column headers never get tooltips.

```tsx
import { HelpTooltip } from '../../components/HelpTooltip';

// ✓ Domain-specific field — tooltip warranted
<label className={LABEL}>
  Contracted playlist
  <HelpTooltip text="The set of songs covered by this contract. Picker draws from this playlist when the campaign is behind its daily target." />
</label>

// ✗ Self-explanatory — no tooltip
<label className={LABEL}>Name</label>
```

Place the `HelpTooltip` inline after the label text, inside the `<label>` element.

**Option names** that refer to a specific selectable value should be visually distinguished in tooltip text using JSX:
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
