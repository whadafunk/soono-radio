import { useState, useMemo, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader, Search, Star, Play, Pause, X, Save, AlertCircle } from 'lucide-react';
import { MEDIA_CATEGORIES, MediaCategory, Media, MediaPatch } from '@radio/shared';
import {
  fetchLibrary,
  fetchLibraryItem,
  updateLibraryItem,
  libraryAudioUrl,
  LibraryListResponse,
} from '../../api';

const SORTS: Array<{ value: string; label: string }> = [
  { value: 'created_at', label: 'Recently Added' },
  { value: 'title', label: 'Title' },
  { value: 'artist', label: 'Artist' },
  { value: 'duration_seconds', label: 'Duration' },
  { value: 'bitrate_kbps', label: 'Bitrate' },
  { value: 'play_count', label: 'Play Count' },
  { value: 'last_played_at', label: 'Last Played' },
];

export function LibraryBrowse() {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [category, setCategory] = useState<'' | MediaCategory>('');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [sort, setSort] = useState('created_at');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const limit = 50;

  // Debounce search input.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    setOffset(0);
  }, [debouncedQ, category, favoriteOnly, sort, order]);

  const { data, isLoading, error } = useQuery<LibraryListResponse>({
    queryKey: ['library', { q: debouncedQ, category, favoriteOnly, sort, order, limit, offset }],
    queryFn: () =>
      fetchLibrary({
        q: debouncedQ || undefined,
        category: category || undefined,
        favorite: favoriteOnly ? true : undefined,
        sort,
        order,
        limit,
        offset,
      }),
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="space-y-4 max-w-7xl">
      <div>
        <h1 className="text-3xl font-bold text-white">Library</h1>
        <p className="text-zinc-400 mt-1">{total} {total === 1 ? 'track' : 'tracks'}</p>
      </div>

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

        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as '' | MediaCategory)}
          className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
        >
          <option value="">All categories</option>
          {MEDIA_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        <button
          onClick={() => setOrder((o) => (o === 'asc' ? 'desc' : 'asc'))}
          className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white hover:bg-zinc-700 transition-colors"
          title="Toggle sort direction"
        >
          {order === 'asc' ? '↑' : '↓'}
        </button>

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
          playingId={playingId}
          onTogglePlay={(id) => setPlayingId((cur) => (cur === id ? null : id))}
          onSelect={(id) => setSelectedId(id)}
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
        <DetailDrawer id={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

function LibraryTable({
  items,
  playingId,
  onTogglePlay,
  onSelect,
}: {
  items: Media[];
  playingId: number | null;
  onTogglePlay: (id: number) => void;
  onSelect: (id: number) => void;
}) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-zinc-950/50 border-b border-zinc-800">
          <tr>
            <th className="w-10"></th>
            <th className="text-left text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Title</th>
            <th className="text-left text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Artist</th>
            <th className="text-left text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Category</th>
            <th className="text-right text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Duration</th>
            <th className="text-right text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Bitrate</th>
            <th className="text-right text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">LUFS</th>
            <th className="text-right text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Plays</th>
            <th className="w-10"></th>
          </tr>
        </thead>
        <tbody>
          {items.map((m) => (
            <tr
              key={m.id}
              onClick={() => onSelect(m.id)}
              className="border-t border-zinc-800/60 hover:bg-zinc-800/40 cursor-pointer"
            >
              <td className="px-2 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => onTogglePlay(m.id)}
                  className="p-1 text-zinc-400 hover:text-white transition-colors"
                  title={playingId === m.id ? 'Stop preview' : 'Play preview'}
                >
                  {playingId === m.id ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                </button>
              </td>
              <td className="px-3 py-2 text-zinc-100 truncate max-w-xs">
                {m.title || <span className="text-zinc-500 italic">{m.original_filename}</span>}
                {playingId === m.id && (
                  <div className="mt-1" onClick={(e) => e.stopPropagation()}>
                    <audio
                      src={libraryAudioUrl(m.id)}
                      controls
                      autoPlay
                      className="w-full max-w-md h-8"
                      onEnded={() => onTogglePlay(m.id)}
                    />
                  </div>
                )}
              </td>
              <td className="px-3 py-2 text-zinc-300 truncate max-w-xs">{m.artist ?? '—'}</td>
              <td className="px-3 py-2 text-zinc-400">{m.category}</td>
              <td className="px-3 py-2 text-zinc-400 text-right font-mono text-xs">
                {formatDuration(m.duration_seconds)}
              </td>
              <td className="px-3 py-2 text-zinc-400 text-right font-mono text-xs">
                {m.bitrate_kbps}{m.was_transcoded ? '*' : ''}
              </td>
              <td className="px-3 py-2 text-zinc-400 text-right font-mono text-xs">
                {m.loudness_lufs !== null ? m.loudness_lufs.toFixed(1) : '—'}
              </td>
              <td className="px-3 py-2 text-zinc-400 text-right">{m.play_count}</td>
              <td className="px-2 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                {m.favorite ? (
                  <Star className="w-4 h-4 text-amber-400 fill-amber-400 inline" />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-zinc-500 px-3 py-2 border-t border-zinc-800/60">
        Bitrate marked with * was transcoded at ingest. Plays count is updated by the playout engine, not by previews.
      </p>
    </div>
  );
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

function DetailDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['library-item', id],
    queryFn: () => fetchLibraryItem(id),
  });

  const [draft, setDraft] = useState<MediaPatch>({});
  const [error, setError] = useState<string | null>(null);

  // When the loaded item arrives, prime the draft with its editable fields.
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

  const mutation = useMutation({
    mutationFn: () => updateLibraryItem(id, draft),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library'] });
      queryClient.invalidateQueries({ queryKey: ['library-item', id] });
      onClose();
    },
    onError: (err) => setError((err as Error).message),
  });

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
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !data}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {mutation.isPending ? <Loader className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white font-medium rounded-lg transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
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
