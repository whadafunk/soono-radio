import { useState, useEffect, useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Loader, Search, Star, Play, Pause, X, Save, AlertCircle,
  Settings2, ChevronDown, ChevronUp, ChevronsUpDown, Filter, Check,
  Trash2, Activity, RefreshCcw, Tag, Fingerprint, AlertTriangle,
} from 'lucide-react';
import { MEDIA_CATEGORIES, MediaCategory, Media, MediaPatch, TranscodeOptions } from '@radio/shared';
import {
  fetchLibrary,
  fetchLibraryItem,
  updateLibraryItem,
  libraryAudioUrl,
  LibraryListResponse,
  deleteLibraryItem,
  reMeasureLibraryItem,
  reTranscodeLibraryItem,
  bulkDeleteLibrary,
  bulkSetCategory,
  bulkSetFavorite,
  bulkReMeasure,
} from '../../api';

type ColumnId =
  | 'title'
  | 'artist'
  | 'album'
  | 'category'
  | 'duration_seconds'
  | 'bitrate_kbps'
  | 'loudness_lufs'
  | 'play_count'
  | 'year'
  | 'created_at'
  | 'last_played_at';

interface ColumnDef {
  id: ColumnId;
  label: string;
  sortable: boolean;
  align: 'left' | 'right';
  defaultVisible: boolean;
}

const COLUMNS: ColumnDef[] = [
  { id: 'title',            label: 'Title',         sortable: true,  align: 'left',  defaultVisible: true },
  { id: 'artist',           label: 'Artist',        sortable: true,  align: 'left',  defaultVisible: true },
  { id: 'album',            label: 'Album',         sortable: true,  align: 'left',  defaultVisible: false },
  { id: 'category',         label: 'Category',      sortable: false, align: 'left',  defaultVisible: true },
  { id: 'duration_seconds', label: 'Duration',      sortable: true,  align: 'right', defaultVisible: true },
  { id: 'bitrate_kbps',     label: 'Bitrate',       sortable: true,  align: 'right', defaultVisible: true },
  { id: 'loudness_lufs',    label: 'LUFS',          sortable: false, align: 'right', defaultVisible: false },
  { id: 'play_count',       label: 'Plays',         sortable: true,  align: 'right', defaultVisible: true },
  { id: 'year',             label: 'Year',          sortable: false, align: 'right', defaultVisible: false },
  { id: 'created_at',       label: 'Added',         sortable: true,  align: 'right', defaultVisible: false },
  { id: 'last_played_at',   label: 'Last Played',   sortable: true,  align: 'right', defaultVisible: false },
];

const VISIBLE_COLS_KEY = 'library-visible-columns-v1';

function loadVisibleCols(): Set<ColumnId> {
  try {
    const raw = localStorage.getItem(VISIBLE_COLS_KEY);
    if (raw) {
      const arr: string[] = JSON.parse(raw);
      const valid = arr.filter((id): id is ColumnId =>
        COLUMNS.some((c) => c.id === id),
      );
      if (valid.length > 0) return new Set(valid);
    }
  } catch {
    /* fall through */
  }
  return new Set(COLUMNS.filter((c) => c.defaultVisible).map((c) => c.id));
}

export function LibraryBrowse() {
  const queryClient = useQueryClient();

  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [categorySet, setCategorySet] = useState<Set<MediaCategory>>(new Set());
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [sort, setSort] = useState<ColumnId>('created_at');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [visibleCols, setVisibleCols] = useState<Set<ColumnId>>(() => loadVisibleCols());
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const limit = 50;

  useEffect(() => {
    localStorage.setItem(VISIBLE_COLS_KEY, JSON.stringify(Array.from(visibleCols)));
  }, [visibleCols]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    setOffset(0);
  }, [debouncedQ, categorySet, favoriteOnly, sort, order]);

  const categoryParam = useMemo(
    () => (categorySet.size === 0 ? undefined : Array.from(categorySet).join(',')),
    [categorySet],
  );

  const { data, isLoading, error } = useQuery<LibraryListResponse>({
    queryKey: ['library', { q: debouncedQ, categoryParam, favoriteOnly, sort, order, limit, offset }],
    queryFn: () =>
      fetchLibrary({
        q: debouncedQ || undefined,
        category: categoryParam,
        favorite: favoriteOnly ? true : undefined,
        sort,
        order,
        limit,
        offset,
      }),
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const visibleColumns = COLUMNS.filter((c) => visibleCols.has(c.id));

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  };

  const invalidateAndClear = () => {
    queryClient.invalidateQueries({ queryKey: ['library'] });
    setSelection(new Set());
  };

  const handleSortClick = (id: ColumnId) => {
    if (!COLUMNS.find((c) => c.id === id)?.sortable) return;
    if (sort === id) {
      setOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(id);
      setOrder(id === 'title' || id === 'artist' || id === 'album' ? 'asc' : 'desc');
    }
  };

  const toggleSelect = (id: number) => {
    setSelection((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (items.every((m) => selection.has(m.id))) {
      // All visible currently selected → unselect them.
      setSelection((cur) => {
        const next = new Set(cur);
        for (const m of items) next.delete(m.id);
        return next;
      });
    } else {
      setSelection((cur) => {
        const next = new Set(cur);
        for (const m of items) next.add(m.id);
        return next;
      });
    }
  };

  return (
    <div className="space-y-4 max-w-7xl">
      <div>
        <h1 className="text-3xl font-bold text-white">Library</h1>
        <p className="text-zinc-400 mt-1">{total} {total === 1 ? 'track' : 'tracks'}</p>
      </div>

      {toast && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-lg ${
            toast.type === 'success'
              ? 'bg-green-900/20 border border-green-800 text-green-300'
              : 'bg-red-900/20 border border-red-800 text-red-300'
          }`}
        >
          {toast.type === 'success' ? <Check className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
          <p className="text-sm">{toast.message}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search title, artist, album, filename..."
            className="w-full pl-10 pr-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
          />
        </div>

        <CategoryMultiSelect value={categorySet} onChange={setCategorySet} />

        <button
          onClick={() => setFavoriteOnly((v) => !v)}
          className={`flex items-center gap-1 px-3 py-2 border rounded-lg transition-colors ${
            favoriteOnly
              ? 'bg-amber-600/20 border-amber-600 text-amber-300'
              : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700'
          }`}
        >
          <Star className={`w-4 h-4 ${favoriteOnly ? 'fill-amber-400' : ''}`} />
          Favorites
        </button>
      </div>

      {selection.size > 0 && (
        <BulkActionBar
          selection={selection}
          onClear={() => setSelection(new Set())}
          showToast={showToast}
          onSuccess={invalidateAndClear}
        />
      )}

      {error && (
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-3 text-red-300 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5" />
          <p className="text-sm">{(error as Error).message}</p>
        </div>
      )}

      {isLoading && items.length === 0 ? (
        <div className="flex items-center justify-center py-16">
          <Loader className="w-6 h-6 animate-spin text-indigo-500" />
        </div>
      ) : items.length === 0 ? (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center text-zinc-400">
          <p>No tracks match these filters.</p>
        </div>
      ) : (
        <LibraryTable
          items={items}
          visibleColumns={visibleColumns}
          sort={sort}
          order={order}
          onSortClick={handleSortClick}
          playingId={playingId}
          onTogglePlay={(id) => setPlayingId((cur) => (cur === id ? null : id))}
          onSelect={(id) => setSelectedId(id)}
          visibleCols={visibleCols}
          setVisibleCols={setVisibleCols}
          selection={selection}
          toggleSelect={toggleSelect}
          toggleSelectAll={toggleSelectAll}
        />
      )}

      <Pagination
        total={total}
        limit={limit}
        offset={offset}
        onPrev={() => setOffset((o) => Math.max(0, o - limit))}
        onNext={() => setOffset((o) => o + limit)}
      />

      {selectedId !== null && (
        <DetailDrawer
          id={selectedId}
          onClose={() => setSelectedId(null)}
          showToast={showToast}
        />
      )}
    </div>
  );
}

function BulkActionBar({
  selection,
  onClear,
  showToast,
  onSuccess,
}: {
  selection: Set<number>;
  onClear: () => void;
  showToast: (type: 'success' | 'error', message: string) => void;
  onSuccess: () => void;
}) {
  const ids = useMemo(() => Array.from(selection), [selection]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showCategory, setShowCategory] = useState(false);

  const wrap = async (label: string, fn: () => Promise<unknown>, summary: (r: any) => string) => {
    try {
      setBusy(label);
      const result = await fn();
      showToast('success', summary(result));
      onSuccess();
    } catch (err) {
      showToast('error', (err as Error).message);
    } finally {
      setBusy(null);
      setConfirmDelete(false);
      setShowCategory(false);
    }
  };

  return (
    <div className="bg-indigo-600/10 border border-indigo-700/50 rounded-lg px-4 py-3 flex flex-wrap items-center gap-2">
      <span className="text-sm text-indigo-200 font-medium">
        {ids.length} selected
      </span>
      <span className="text-zinc-600 mx-1">|</span>

      <button
        onClick={() =>
          confirmDelete
            ? wrap(
                'delete',
                () => bulkDeleteLibrary(ids),
                (r: any) =>
                  `Deleted ${r.succeeded.length}; failed ${r.failed.length}`,
              )
            : setConfirmDelete(true)
        }
        disabled={!!busy}
        className={`flex items-center gap-1 px-3 py-1.5 text-xs font-medium border rounded transition-colors ${
          confirmDelete
            ? 'bg-red-600/30 border-red-600 text-red-200 hover:bg-red-600/40'
            : 'bg-zinc-900 border-zinc-700 text-zinc-200 hover:bg-zinc-800'
        }`}
      >
        {busy === 'delete' ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
        {confirmDelete ? 'Click again to confirm' : 'Delete'}
      </button>

      <div className="relative">
        <button
          onClick={() => setShowCategory((v) => !v)}
          disabled={!!busy}
          className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-zinc-900 border border-zinc-700 text-zinc-200 hover:bg-zinc-800 rounded transition-colors"
        >
          {busy === 'category' ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Tag className="w-3.5 h-3.5" />}
          Set Category
        </button>
        {showCategory && (
          <div className="absolute z-30 mt-1 w-44 bg-zinc-900 border border-zinc-800 rounded-lg shadow-lg p-1">
            {MEDIA_CATEGORIES.map((c) => (
              <button
                key={c}
                onClick={() =>
                  wrap(
                    'category',
                    () => bulkSetCategory(ids, c),
                    () => `Set ${ids.length} to ${c}`,
                  )
                }
                className="w-full text-left px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 rounded capitalize"
              >
                {c}
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={() =>
          wrap(
            'fav-on',
            () => bulkSetFavorite(ids, true),
            () => `Marked ${ids.length} as favorite`,
          )
        }
        disabled={!!busy}
        className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-zinc-900 border border-zinc-700 text-zinc-200 hover:bg-zinc-800 rounded transition-colors"
      >
        {busy === 'fav-on' ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Star className="w-3.5 h-3.5" />}
        Favorite
      </button>
      <button
        onClick={() =>
          wrap(
            'fav-off',
            () => bulkSetFavorite(ids, false),
            () => `Unmarked ${ids.length}`,
          )
        }
        disabled={!!busy}
        className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-zinc-900 border border-zinc-700 text-zinc-200 hover:bg-zinc-800 rounded transition-colors"
      >
        Unfavorite
      </button>

      <button
        onClick={() =>
          wrap(
            'remeasure',
            () => bulkReMeasure(ids),
            (r: any) =>
              `Re-measured ${r.succeeded.length}; failed ${r.failed.length}`,
          )
        }
        disabled={!!busy}
        className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-zinc-900 border border-zinc-700 text-zinc-200 hover:bg-zinc-800 rounded transition-colors"
      >
        {busy === 'remeasure' ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
        Re-measure Loudness
      </button>

      <button
        disabled
        title="Coming soon — use the per-track action in the detail drawer for now"
        className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-zinc-900 border border-zinc-800 text-zinc-600 rounded cursor-not-allowed"
      >
        <RefreshCcw className="w-3.5 h-3.5" />
        Re-transcode
      </button>
      <button
        disabled
        title="AcoustID lookup arrives in Phase 6"
        className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-zinc-900 border border-zinc-800 text-zinc-600 rounded cursor-not-allowed"
      >
        <Fingerprint className="w-3.5 h-3.5" />
        Lookup ID
      </button>

      <div className="ml-auto">
        <button
          onClick={onClear}
          disabled={!!busy}
          className="text-xs text-zinc-400 hover:text-white px-2 py-1"
        >
          Clear selection
        </button>
      </div>
    </div>
  );
}

function CategoryMultiSelect({
  value,
  onChange,
}: {
  value: Set<MediaCategory>;
  onChange: (next: Set<MediaCategory>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const toggle = (c: MediaCategory) => {
    const next = new Set(value);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    onChange(next);
  };

  const label =
    value.size === 0
      ? 'All categories'
      : value.size === 1
        ? Array.from(value)[0]
        : `${value.size} categories`;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-2 px-3 py-2 border rounded-lg transition-colors ${
          value.size > 0
            ? 'bg-indigo-600/20 border-indigo-600 text-indigo-200'
            : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700'
        }`}
      >
        <Filter className="w-4 h-4" />
        <span className="capitalize">{label}</span>
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-56 bg-zinc-900 border border-zinc-800 rounded-lg shadow-lg p-1">
          <button
            onClick={() => onChange(new Set())}
            className="w-full text-left px-3 py-1.5 text-xs text-zinc-400 hover:text-white hover:bg-zinc-800 rounded"
          >
            Clear all
          </button>
          <div className="border-t border-zinc-800 my-1" />
          {MEDIA_CATEGORIES.map((c) => {
            const checked = value.has(c);
            return (
              <button
                key={c}
                onClick={() => toggle(c)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 rounded transition-colors"
              >
                <span
                  className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                    checked ? 'bg-indigo-600 border-indigo-600' : 'border-zinc-600'
                  }`}
                >
                  {checked && <Check className="w-3 h-3 text-white" />}
                </span>
                <span className="capitalize">{c}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ColumnPicker({
  visibleCols,
  setVisibleCols,
}: {
  visibleCols: Set<ColumnId>;
  setVisibleCols: (next: Set<ColumnId>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const toggle = (id: ColumnId) => {
    const next = new Set(visibleCols);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    if (!next.has('title')) next.add('title');
    setVisibleCols(next);
  };

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        className="p-1 text-zinc-400 hover:text-white transition-colors"
        title="Show/hide columns"
      >
        <Settings2 className="w-4 h-4" />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-56 bg-zinc-900 border border-zinc-800 rounded-lg shadow-lg p-1">
          <p className="px-3 py-1.5 text-xs text-zinc-500 uppercase tracking-wider">Columns</p>
          {COLUMNS.map((c) => {
            const checked = visibleCols.has(c.id);
            const isLocked = c.id === 'title';
            return (
              <button
                key={c.id}
                onClick={() => !isLocked && toggle(c.id)}
                disabled={isLocked}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 rounded transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <span
                  className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                    checked ? 'bg-indigo-600 border-indigo-600' : 'border-zinc-600'
                  }`}
                >
                  {checked && <Check className="w-3 h-3 text-white" />}
                </span>
                <span>{c.label}</span>
                {isLocked && <span className="text-[10px] text-zinc-500 ml-auto">always</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LibraryTable({
  items,
  visibleColumns,
  sort,
  order,
  onSortClick,
  playingId,
  onTogglePlay,
  onSelect,
  visibleCols,
  setVisibleCols,
  selection,
  toggleSelect,
  toggleSelectAll,
}: {
  items: Media[];
  visibleColumns: ColumnDef[];
  sort: ColumnId;
  order: 'asc' | 'desc';
  onSortClick: (id: ColumnId) => void;
  playingId: number | null;
  onTogglePlay: (id: number) => void;
  onSelect: (id: number) => void;
  visibleCols: Set<ColumnId>;
  setVisibleCols: (next: Set<ColumnId>) => void;
  selection: Set<number>;
  toggleSelect: (id: number) => void;
  toggleSelectAll: () => void;
}) {
  const allSelected = items.length > 0 && items.every((m) => selection.has(m.id));
  const someSelected = items.some((m) => selection.has(m.id)) && !allSelected;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-zinc-950/50 border-b border-zinc-800">
          <tr>
            <th className="w-10 px-2 py-2 text-center">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected;
                }}
                onChange={toggleSelectAll}
                className="w-4 h-4 rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-indigo-500"
              />
            </th>
            <th className="w-10"></th>
            {visibleColumns.map((c) => (
              <SortHeader
                key={c.id}
                column={c}
                active={sort === c.id}
                order={order}
                onClick={() => onSortClick(c.id)}
              />
            ))}
            <th className="w-10"></th>
            <th className="w-10 text-right pr-2">
              <ColumnPicker visibleCols={visibleCols} setVisibleCols={setVisibleCols} />
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((m) => (
            <tr
              key={m.id}
              onClick={() => onSelect(m.id)}
              className={`border-t border-zinc-800/60 hover:bg-zinc-800/40 cursor-pointer ${
                selection.has(m.id) ? 'bg-indigo-600/5' : ''
              }`}
            >
              <td className="px-2 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selection.has(m.id)}
                  onChange={() => toggleSelect(m.id)}
                  className="w-4 h-4 rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-indigo-500"
                />
              </td>
              <td className="px-2 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => onTogglePlay(m.id)}
                  className="p-1 text-zinc-400 hover:text-white transition-colors"
                  title={playingId === m.id ? 'Stop preview' : 'Play preview'}
                >
                  {playingId === m.id ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                </button>
              </td>
              {visibleColumns.map((c) => (
                <Cell key={c.id} column={c} media={m} playingId={playingId} onTogglePlay={onTogglePlay} />
              ))}
              <td className="px-2 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                {m.favorite ? (
                  <Star className="w-4 h-4 text-amber-400 fill-amber-400 inline" />
                ) : null}
              </td>
              <td className="w-10"></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-zinc-500 px-3 py-2 border-t border-zinc-800/60">
        Click a column header to sort; click again to flip direction. Use the cog at right to choose visible columns. Bitrate marked with * was transcoded at ingest.
      </p>
    </div>
  );
}

function SortHeader({
  column,
  active,
  order,
  onClick,
}: {
  column: ColumnDef;
  active: boolean;
  order: 'asc' | 'desc';
  onClick: () => void;
}) {
  const align = column.align === 'right' ? 'text-right' : 'text-left';
  const justify = column.align === 'right' ? 'justify-end' : 'justify-start';
  return (
    <th
      onClick={column.sortable ? onClick : undefined}
      className={`text-xs font-medium uppercase tracking-wider px-3 py-2 ${align} ${
        column.sortable ? 'cursor-pointer hover:text-white text-zinc-400 select-none' : 'text-zinc-400'
      }`}
    >
      <span className={`inline-flex items-center gap-1 ${justify}`}>
        {column.label}
        {column.sortable && (
          active ? (
            order === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronsUpDown className="w-3 h-3 opacity-30" />
          )
        )}
      </span>
    </th>
  );
}

function Cell({
  column,
  media,
  playingId,
  onTogglePlay,
}: {
  column: ColumnDef;
  media: Media;
  playingId: number | null;
  onTogglePlay: (id: number) => void;
}) {
  const align = column.align === 'right' ? 'text-right' : 'text-left';
  const baseClass = `px-3 py-2 ${align}`;

  switch (column.id) {
    case 'title':
      return (
        <td className={`${baseClass} text-zinc-100 truncate max-w-xs`}>
          {media.title || (
            <span className="text-zinc-500 italic">{media.original_filename}</span>
          )}
          {playingId === media.id && (
            <div className="mt-1" onClick={(e) => e.stopPropagation()}>
              <audio
                src={libraryAudioUrl(media.id)}
                controls
                autoPlay
                className="w-full max-w-md h-8"
                onEnded={() => onTogglePlay(media.id)}
              />
            </div>
          )}
        </td>
      );
    case 'artist':
      return <td className={`${baseClass} text-zinc-300 truncate max-w-xs`}>{media.artist ?? '—'}</td>;
    case 'album':
      return <td className={`${baseClass} text-zinc-300 truncate max-w-xs`}>{media.album ?? '—'}</td>;
    case 'category':
      return <td className={`${baseClass} text-zinc-400 capitalize`}>{media.category}</td>;
    case 'duration_seconds':
      return <td className={`${baseClass} text-zinc-400 font-mono text-xs`}>{formatDuration(media.duration_seconds)}</td>;
    case 'bitrate_kbps':
      return (
        <td className={`${baseClass} text-zinc-400 font-mono text-xs`}>
          {media.bitrate_kbps}{media.was_transcoded ? '*' : ''}
        </td>
      );
    case 'loudness_lufs':
      return (
        <td className={`${baseClass} text-zinc-400 font-mono text-xs`}>
          {media.loudness_lufs !== null ? media.loudness_lufs.toFixed(1) : '—'}
        </td>
      );
    case 'play_count':
      return <td className={`${baseClass} text-zinc-400`}>{media.play_count}</td>;
    case 'year':
      return <td className={`${baseClass} text-zinc-400 font-mono text-xs`}>{media.year ?? '—'}</td>;
    case 'created_at':
      return <td className={`${baseClass} text-zinc-400 font-mono text-xs`}>{formatDate(media.created_at)}</td>;
    case 'last_played_at':
      return <td className={`${baseClass} text-zinc-400 font-mono text-xs`}>{media.last_played_at ? formatDate(media.last_played_at) : '—'}</td>;
  }
}

function Pagination({
  total,
  limit,
  offset,
  onPrev,
  onNext,
}: {
  total: number;
  limit: number;
  offset: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  if (total <= limit) return null;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div className="flex items-center justify-between text-sm text-zinc-400 pt-2">
      <span>{from}–{to} of {total}</span>
      <div className="flex gap-2">
        <button
          onClick={onPrev}
          disabled={offset === 0}
          className="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-white hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Prev
        </button>
        <button
          onClick={onNext}
          disabled={to >= total}
          className="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-white hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Next
        </button>
      </div>
    </div>
  );
}

function DetailDrawer({
  id,
  onClose,
  showToast,
}: {
  id: number;
  onClose: () => void;
  showToast: (type: 'success' | 'error', message: string) => void;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['library-item', id],
    queryFn: () => fetchLibraryItem(id),
  });

  const [draft, setDraft] = useState<MediaPatch>({});
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showRetranscode, setShowRetranscode] = useState(false);

  useEffect(() => {
    if (!data) return;
    setDraft({
      title: data.title,
      artist: data.artist,
      album: data.album,
      genre: data.genre,
      year: data.year,
      notes: data.notes,
      category: data.category,
      favorite: data.favorite,
    });
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: () => updateLibraryItem(id, draft),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library'] });
      queryClient.invalidateQueries({ queryKey: ['library-item', id] });
      onClose();
    },
    onError: (err) => setError((err as Error).message),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteLibraryItem(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library'] });
      showToast('success', 'Track deleted');
      onClose();
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  const remeasureMutation = useMutation({
    mutationFn: () => reMeasureLibraryItem(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library'] });
      queryClient.invalidateQueries({ queryKey: ['library-item', id] });
      showToast('success', 'Loudness re-measured');
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  const retranscodeMutation = useMutation({
    mutationFn: (options: TranscodeOptions) => reTranscodeLibraryItem(id, options),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library'] });
      queryClient.invalidateQueries({ queryKey: ['library-item', id] });
      showToast('success', 'Track re-transcoded');
      setShowRetranscode(false);
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  const busy =
    saveMutation.isPending ||
    deleteMutation.isPending ||
    remeasureMutation.isPending ||
    retranscodeMutation.isPending;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="w-full max-w-xl h-full bg-zinc-900 border-l border-zinc-800 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-zinc-800">
          <h2 className="text-lg font-semibold text-white">Track Detail</h2>
          <button onClick={onClose} className="p-1 text-zinc-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {isLoading || !data ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader className="w-6 h-6 animate-spin text-indigo-500" />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            <audio src={libraryAudioUrl(id)} controls className="w-full" />

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => remeasureMutation.mutate()}
                disabled={busy}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 rounded transition-colors disabled:opacity-50"
              >
                {remeasureMutation.isPending ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
                Re-measure Loudness
              </button>
              <button
                onClick={() => setShowRetranscode(true)}
                disabled={busy}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 rounded transition-colors disabled:opacity-50"
              >
                <RefreshCcw className="w-3.5 h-3.5" />
                Re-transcode...
              </button>
              <button
                disabled
                title="AcoustID lookup arrives in Phase 6"
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-zinc-900 border border-zinc-800 text-zinc-600 rounded cursor-not-allowed"
              >
                <Fingerprint className="w-3.5 h-3.5" />
                Lookup Track ID
              </button>
              <button
                onClick={() => (confirmDelete ? deleteMutation.mutate() : setConfirmDelete(true))}
                disabled={busy}
                className={`flex items-center gap-1 px-3 py-1.5 text-xs font-medium border rounded transition-colors disabled:opacity-50 ${
                  confirmDelete
                    ? 'bg-red-600/30 border-red-600 text-red-200 hover:bg-red-600/40'
                    : 'bg-zinc-800 hover:bg-red-900/30 border-zinc-700 hover:border-red-800 text-zinc-200 hover:text-red-300'
                }`}
              >
                {deleteMutation.isPending ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                {confirmDelete ? 'Click again to delete' : 'Delete track'}
              </button>
            </div>

            <Field label="Title">
              <input
                value={draft.title ?? ''}
                onChange={(e) => setDraft({ ...draft, title: e.target.value || null })}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
              />
            </Field>
            <Field label="Artist">
              <input
                value={draft.artist ?? ''}
                onChange={(e) => setDraft({ ...draft, artist: e.target.value || null })}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Album">
                <input
                  value={draft.album ?? ''}
                  onChange={(e) => setDraft({ ...draft, album: e.target.value || null })}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
                />
              </Field>
              <Field label="Genre">
                <input
                  value={draft.genre ?? ''}
                  onChange={(e) => setDraft({ ...draft, genre: e.target.value || null })}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Year">
                <input
                  type="number"
                  value={draft.year ?? ''}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      year: e.target.value === '' ? null : parseInt(e.target.value, 10),
                    })
                  }
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
                />
              </Field>
              <Field label="Category">
                <select
                  value={draft.category ?? data.category}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value as MediaCategory })}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
                >
                  {MEDIA_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Notes">
              <textarea
                value={draft.notes ?? ''}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value || null })}
                rows={3}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
              />
            </Field>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.favorite ?? false}
                onChange={(e) => setDraft({ ...draft, favorite: e.target.checked })}
                className="w-4 h-4 rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-indigo-500"
              />
              <span className="text-sm text-zinc-200">Favorite</span>
            </label>

            <div className="border-t border-zinc-800 pt-4 mt-4 space-y-1 text-xs text-zinc-500">
              <p><span className="text-zinc-400">File:</span> <span className="font-mono">{data.original_filename}</span></p>
              <p><span className="text-zinc-400">Duration:</span> {formatDuration(data.duration_seconds)}</p>
              <p>
                <span className="text-zinc-400">Audio:</span>{' '}
                {data.bitrate_kbps} kbps · {data.samplerate_hz} Hz · {data.channels === 1 ? 'mono' : data.channels === 2 ? 'stereo' : `${data.channels}ch`}
                {data.was_transcoded && ' (transcoded at ingest)'}
              </p>
              <p>
                <span className="text-zinc-400">Loudness:</span>{' '}
                {data.loudness_lufs !== null
                  ? `${data.loudness_lufs.toFixed(2)} LUFS / peak ${data.loudness_peak?.toFixed(2)} dBFS / gain ${data.loudness_gain_db?.toFixed(2)} dB at playout`
                  : '—'}
              </p>
              {data.loudness_warning && (
                <p className="text-amber-400 mt-1">⚠ {data.loudness_warning}</p>
              )}
              <p><span className="text-zinc-400">SHA-256:</span> <span className="font-mono break-all">{data.sha256}</span></p>
            </div>

            {error && (
              <div className="bg-red-900/20 border border-red-800 rounded-lg p-3 text-red-300 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 mt-0.5" />
                <p className="text-sm">{error}</p>
              </div>
            )}
          </div>
        )}

        <div className="border-t border-zinc-800 p-5 flex gap-3">
          <button
            onClick={() => saveMutation.mutate()}
            disabled={busy || !data}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {saveMutation.isPending ? <Loader className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save
          </button>
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
        </div>

        {showRetranscode && (
          <RetranscodeDialog
            onClose={() => setShowRetranscode(false)}
            onApply={(opts) => retranscodeMutation.mutate(opts)}
            busy={retranscodeMutation.isPending}
          />
        )}
      </div>
    </div>
  );
}

function RetranscodeDialog({
  onClose,
  onApply,
  busy,
}: {
  onClose: () => void;
  onApply: (opts: TranscodeOptions) => void;
  busy: boolean;
}) {
  const [mode, setMode] = useState<TranscodeOptions['mode']>('cbr');
  const [channels, setChannels] = useState<TranscodeOptions['channels']>('preserve');
  const [trimSilence, setTrimSilence] = useState(false);

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-zinc-800">
          <h3 className="text-base font-semibold text-white">Re-transcode</h3>
          <button onClick={onClose} className="p-1 text-zinc-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="bg-amber-900/20 border border-amber-800/60 rounded-lg p-3 text-amber-300 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <p className="text-xs">
              Re-encoding lossy → lossy degrades quality slightly. Use this only when you actually need to change channel layout, switch CBR/VBR, or strip silence.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-2">Encode mode</label>
            <div className="flex gap-2">
              <RadioPill checked={mode === 'cbr'} onClick={() => setMode('cbr')} label="CBR 256 kbps" hint="Constant bitrate, broadcast-friendly" />
              <RadioPill checked={mode === 'vbr'} onClick={() => setMode('vbr')} label="VBR (V2)" hint="≈190 kbps avg, better quality/byte" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-2">Channels</label>
            <div className="flex gap-2 flex-wrap">
              <RadioPill checked={channels === 'preserve'} onClick={() => setChannels('preserve')} label="Preserve" hint="Keep input layout" />
              <RadioPill checked={channels === 'stereo'} onClick={() => setChannels('stereo')} label="Force stereo" />
              <RadioPill checked={channels === 'mono'} onClick={() => setChannels('mono')} label="Force mono" hint="Halves file size for voice/jingles" />
            </div>
          </div>

          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={trimSilence}
              onChange={(e) => setTrimSilence(e.target.checked)}
              className="w-4 h-4 mt-0.5 rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-indigo-500"
            />
            <span className="text-sm text-zinc-200">
              Trim leading and trailing silence
              <span className="block text-[11px] text-zinc-500 mt-0.5">Strip anything below −50 dBFS at the head and tail. Cleaner crossfades.</span>
            </span>
          </label>
        </div>

        <div className="flex gap-3 p-5 border-t border-zinc-800">
          <button
            onClick={() => onApply({ mode, channels, trim_silence: trimSilence })}
            disabled={busy}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {busy ? <Loader className="w-4 h-4 animate-spin" /> : <RefreshCcw className="w-4 h-4" />}
            Re-transcode
          </button>
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function RadioPill({
  checked,
  onClick,
  label,
  hint,
}: {
  checked: boolean;
  onClick: () => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-left px-3 py-2 rounded-lg border transition-colors ${
        checked
          ? 'bg-indigo-600/20 border-indigo-600 text-indigo-200'
          : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700'
      }`}
    >
      <div className="text-xs font-medium">{label}</div>
      {hint && <div className="text-[10px] text-zinc-500 mt-0.5">{hint}</div>}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-zinc-400 mb-1">{label}</label>
      {children}
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
