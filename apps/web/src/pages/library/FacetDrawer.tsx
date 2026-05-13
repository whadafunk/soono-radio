import { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, X, SlidersHorizontal } from 'lucide-react';
import type { FacetsResponse } from '@radio/shared';

export interface FacetFilters {
  genres: string[];
  artists: string[];
  decades: number[];
  durBuckets: string[];
  energyBuckets: string[];
  identified: 'all' | 'yes' | 'no';
  bpm_min: string;
  bpm_max: string;
  moods: string[];
  keys: string[];
}

export const EMPTY_FACET_FILTERS: FacetFilters = {
  genres: [],
  artists: [],
  decades: [],
  durBuckets: [],
  energyBuckets: [],
  identified: 'all',
  bpm_min: '',
  bpm_max: '',
  moods: [],
  keys: [],
};

export function countActiveFacets(f: FacetFilters): number {
  return (
    f.genres.length +
    f.artists.length +
    f.decades.length +
    f.durBuckets.length +
    f.energyBuckets.length +
    (f.identified !== 'all' ? 1 : 0) +
    (f.bpm_min ? 1 : 0) +
    (f.bpm_max ? 1 : 0) +
    f.moods.length +
    f.keys.length
  );
}

const MOOD_LABELS: Record<string, string> = {
  happy:      'Happy',
  sad:        'Sad',
  aggressive: 'Aggressive',
  relaxed:    'Relaxed',
  party:      'Party',
  acoustic:   'Acoustic',
  electronic: 'Electronic',
};

const MOOD_COLORS: Record<string, string> = {
  happy:      'bg-yellow-500/20 text-yellow-300 border-yellow-700/50',
  sad:        'bg-blue-500/20 text-blue-300 border-blue-700/50',
  aggressive: 'bg-red-500/20 text-red-300 border-red-700/50',
  relaxed:    'bg-teal-500/20 text-teal-300 border-teal-700/50',
  party:      'bg-pink-500/20 text-pink-300 border-pink-700/50',
  acoustic:   'bg-amber-500/20 text-amber-300 border-amber-700/50',
  electronic: 'bg-violet-500/20 text-violet-300 border-violet-700/50',
};

function toggle<T>(arr: T[], item: T): T[] {
  return arr.includes(item) ? arr.filter((x) => x !== item) : [...arr, item];
}

function Section({
  title,
  activeCount,
  children,
  defaultOpen = true,
}: {
  title: string;
  activeCount?: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-zinc-800 last:border-b-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400 hover:text-zinc-200 transition-colors"
      >
        <span className="flex items-center gap-1.5">
          {title}
          {activeCount != null && activeCount > 0 && (
            <span className="bg-indigo-600 text-white rounded-full px-1.5 py-0.5 text-[10px] leading-none font-bold">
              {activeCount}
            </span>
          )}
        </span>
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>
      {open && <div className="pb-2">{children}</div>}
    </div>
  );
}

function CheckItem({
  label,
  count,
  checked,
  onChange,
}: {
  label: string;
  count?: number;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <button
      onClick={onChange}
      className="w-full flex items-center gap-2 px-3 py-1 text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60 rounded transition-colors"
    >
      <span
        className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
          checked ? 'bg-indigo-600 border-indigo-600' : 'border-zinc-600'
        }`}
      >
        {checked && <span className="block w-1.5 h-1.5 bg-white rounded-sm" />}
      </span>
      <span className="flex-1 text-left truncate">{label}</span>
      {count != null && (
        <span className="text-xs text-zinc-500 tabular-nums flex-shrink-0">{count}</span>
      )}
    </button>
  );
}

export function FacetDrawer({
  facets,
  filters,
  onChange,
  onReset,
}: {
  facets: FacetsResponse | undefined;
  filters: FacetFilters;
  onChange: (next: FacetFilters) => void;
  onReset: () => void;
}) {
  const [artistSearch, setArtistSearch] = useState('');
  const [showAllArtists, setShowAllArtists] = useState(false);

  const activeCount = countActiveFacets(filters);

  const filteredArtists = useMemo(() => {
    const all = facets?.artists ?? [];
    if (!artistSearch.trim()) return all;
    const needle = artistSearch.toLowerCase();
    return all.filter((a) => a.value.toLowerCase().includes(needle));
  }, [facets?.artists, artistSearch]);

  const visibleArtists = showAllArtists ? filteredArtists : filteredArtists.slice(0, 8);

  return (
    <div className="w-56 shrink-0 bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-zinc-800">
        <div className="flex items-center gap-1.5">
          <SlidersHorizontal className="w-3.5 h-3.5 text-zinc-400" />
          <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">Filters</span>
        </div>
        {activeCount > 0 && (
          <button
            onClick={onReset}
            className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <X className="w-3 h-3" />
            Clear all
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Genre */}
        {(facets?.genres.length ?? 0) > 0 && (
          <Section title="Genre" activeCount={filters.genres.length}>
            {facets!.genres.map((g) => (
              <CheckItem
                key={g.value}
                label={g.value}
                count={g.count}
                checked={filters.genres.includes(g.value)}
                onChange={() => onChange({ ...filters, genres: toggle(filters.genres, g.value) })}
              />
            ))}
          </Section>
        )}

        {/* Artist */}
        {(facets?.artists.length ?? 0) > 0 && (
          <Section title="Artist" activeCount={filters.artists.length}>
            <div className="px-3 pb-1">
              <input
                value={artistSearch}
                onChange={(e) => setArtistSearch(e.target.value)}
                placeholder="Search artists…"
                className="w-full px-2 py-1 text-xs bg-zinc-800 border border-zinc-700 rounded text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500"
              />
            </div>
            {visibleArtists.map((a) => (
              <CheckItem
                key={a.value}
                label={a.value}
                count={a.count}
                checked={filters.artists.includes(a.value)}
                onChange={() => onChange({ ...filters, artists: toggle(filters.artists, a.value) })}
              />
            ))}
            {filteredArtists.length > 8 && (
              <button
                onClick={() => setShowAllArtists((v) => !v)}
                className="w-full px-3 py-1 text-xs text-zinc-500 hover:text-zinc-300 text-left transition-colors"
              >
                {showAllArtists
                  ? 'Show fewer'
                  : `+${filteredArtists.length - 8} more`}
              </button>
            )}
          </Section>
        )}

        {/* Year / Decade */}
        {(facets?.decades.length ?? 0) > 0 && (
          <Section title="Year" activeCount={filters.decades.length}>
            {facets!.decades.map((d) => (
              <CheckItem
                key={d.value}
                label={d.label}
                count={d.count}
                checked={filters.decades.includes(d.value)}
                onChange={() => onChange({ ...filters, decades: toggle(filters.decades, d.value) })}
              />
            ))}
          </Section>
        )}

        {/* Duration */}
        {(facets?.duration_buckets.length ?? 0) > 0 && (
          <Section title="Duration" activeCount={filters.durBuckets.length}>
            {facets!.duration_buckets.map((b) => (
              <CheckItem
                key={b.value}
                label={b.label}
                count={b.count}
                checked={filters.durBuckets.includes(b.value)}
                onChange={() => onChange({ ...filters, durBuckets: toggle(filters.durBuckets, b.value) })}
              />
            ))}
          </Section>
        )}

        {/* Status (identified) */}
        <Section
          title="Status"
          activeCount={filters.identified !== 'all' ? 1 : 0}
          defaultOpen={false}
        >
          <div className="px-3 space-y-1">
            {(['all', 'yes', 'no'] as const).map((v) => (
              <label key={v} className="flex items-center gap-2 cursor-pointer py-0.5">
                <input
                  type="radio"
                  checked={filters.identified === v}
                  onChange={() => onChange({ ...filters, identified: v })}
                  className="w-3.5 h-3.5 text-indigo-600 border-zinc-600 bg-zinc-800 focus:ring-indigo-500"
                />
                <span className="text-sm text-zinc-300">
                  {v === 'all' ? 'All tracks' : v === 'yes' ? 'Identified' : 'Unidentified'}
                </span>
                {v === 'yes' && facets && (
                  <span className="text-xs text-zinc-500 ml-auto">{facets.identified.yes}</span>
                )}
                {v === 'no' && facets && (
                  <span className="text-xs text-zinc-500 ml-auto">{facets.identified.no}</span>
                )}
              </label>
            ))}
          </div>
        </Section>

        {/* BPM */}
        {facets?.bpm_range.min != null && (
          <Section
            title="BPM"
            activeCount={(filters.bpm_min ? 1 : 0) + (filters.bpm_max ? 1 : 0)}
            defaultOpen={false}
          >
            <div className="px-3 space-y-1.5">
              {facets.bpm_range.min != null && facets.bpm_range.max != null && (
                <p className="text-[11px] text-zinc-500">
                  Range: {Math.round(facets.bpm_range.min)}–{Math.round(facets.bpm_range.max)} BPM
                </p>
              )}
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={filters.bpm_min}
                  onChange={(e) => onChange({ ...filters, bpm_min: e.target.value })}
                  placeholder="Min"
                  className="w-full px-2 py-1 text-xs bg-zinc-800 border border-zinc-700 rounded text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500"
                />
                <span className="text-zinc-600 text-xs">–</span>
                <input
                  type="number"
                  value={filters.bpm_max}
                  onChange={(e) => onChange({ ...filters, bpm_max: e.target.value })}
                  placeholder="Max"
                  className="w-full px-2 py-1 text-xs bg-zinc-800 border border-zinc-700 rounded text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>
          </Section>
        )}

        {/* Musical Key */}
        {(facets?.keys.length ?? 0) > 0 && (
          <Section title="Key" activeCount={filters.keys.length} defaultOpen={false}>
            {facets!.keys.map((k) => (
              <CheckItem
                key={k.value}
                label={k.value}
                count={k.count}
                checked={filters.keys.includes(k.value)}
                onChange={() => onChange({ ...filters, keys: toggle(filters.keys, k.value) })}
              />
            ))}
          </Section>
        )}

        {/* Energy — always show; placeholder when no analysis data */}
        <Section title="Energy" activeCount={filters.energyBuckets.length} defaultOpen={false}>
          {facets && facets.energy_buckets.some((b) => b.count > 0) ? (
            facets.energy_buckets.map((b) => (
              <CheckItem
                key={b.value}
                label={b.label}
                count={b.count}
                checked={filters.energyBuckets.includes(b.value)}
                onChange={() => onChange({ ...filters, energyBuckets: toggle(filters.energyBuckets, b.value) })}
              />
            ))
          ) : (
            <p className="px-3 pb-2 text-[11px] text-zinc-600 italic">Run audio analysis to use this filter</p>
          )}
        </Section>

        {/* Mood — always show; placeholder when no analysis data */}
        <Section title="Mood" activeCount={filters.moods.length} defaultOpen={false}>
          {facets && facets.moods.some((m) => m.count > 0) ? (
            <div className="px-3 flex flex-wrap gap-1.5 pb-1">
              {facets.moods.map((m) => {
                const active = filters.moods.includes(m.value);
                const colorClass = MOOD_COLORS[m.value] ?? 'bg-zinc-700/20 text-zinc-300 border-zinc-600/50';
                return (
                  <button
                    key={m.value}
                    onClick={() => onChange({ ...filters, moods: toggle(filters.moods, m.value) })}
                    className={`flex items-center gap-1 px-2 py-0.5 text-xs border rounded-full transition-colors ${
                      active
                        ? colorClass
                        : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:border-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    {MOOD_LABELS[m.value] ?? m.value}
                    <span className={active ? 'opacity-70' : 'text-zinc-600'}>{m.count}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="px-3 pb-2 text-[11px] text-zinc-600 italic">Run audio analysis to use this filter</p>
          )}
        </Section>
      </div>
    </div>
  );
}
