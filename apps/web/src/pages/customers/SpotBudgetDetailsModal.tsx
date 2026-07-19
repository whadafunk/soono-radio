import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type {
  SpotBudgetOverview,
  SpotBudgetDayDetail,
  Budget,
} from '@soono/shared';
import {
  fetchSpotBudgetDetails,
  fetchCampaigns,
  fetchIntervals,
  fetchShows,
} from '../../api';

function fmtMin(mins: number): string {
  return mins.toFixed(1);
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function emptyBudget(): Budget {
  return { minutes: 0, breaks: 0 };
}

export function SpotBudgetDetailsModal({ start, end, overview, onClose }: {
  start: string;
  end: string;
  overview: SpotBudgetOverview;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { data: details } = useQuery({
    queryKey: ['spot-budget-details', start, end],
    queryFn: () => fetchSpotBudgetDetails(start, end, 'estimated'),
    staleTime: 5 * 60 * 1000,
  });

  // These share query keys with queries elsewhere on the page — cache hits.
  const { data: campaigns = [] } = useQuery({ queryKey: ['campaigns'], queryFn: () => fetchCampaigns() });
  const { data: intervals = [] } = useQuery({ queryKey: ['intervals'], queryFn: fetchIntervals });
  const { data: shows = [] } = useQuery({ queryKey: ['shows'], queryFn: fetchShows });

  const campaignById = new Map(campaigns.map((c) => [String(c.id), c]));
  const intervalNameById = new Map(intervals.map((iv) => [String(iv.id), iv.name]));
  const showNameById = new Map(shows.map((s) => [String(s.id), s.name]));

  const { inventory, demand, available } = overview;
  const raw = inventory.raw.global;
  const effective = inventory.effective.global;
  const demandTotal = demand.totals.global;
  const availGlobal = available.global;
  const marginMinutes = raw.minutes - effective.minutes;

  const waterfallRows: { label: string; minutes: number; breaks: string; barCls: string }[] = [
    { label: 'Raw inventory', minutes: raw.minutes, breaks: `${raw.breaks} breaks`, barCls: 'bg-zinc-500' },
    { label: `− Promo margin (${Math.round(inventory.promoMargin * 100)}%)`, minutes: marginMinutes, breaks: '', barCls: 'bg-purple-500/60' },
    { label: '= Effective inventory', minutes: effective.minutes, breaks: `${effective.breaks} breaks`, barCls: 'bg-zinc-400' },
    { label: '− Campaign demand', minutes: demandTotal.minutes, breaks: `${demandTotal.breaks} first-slot breaks`, barCls: 'bg-amber-500' },
  ];

  const sortedDemand = [...demand.byCampaign].sort((a, b) => b.minutes - a.minutes);

  const intervalKeys = Array.from(new Set([
    ...Object.keys(inventory.effective.byInterval),
    ...Object.keys(demand.totals.byInterval),
    ...Object.keys(available.byInterval),
  ]));

  const days = details?.days ?? [];
  const maxDayMinutes = Math.max(0, ...days.map((d) => d.minutes));

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-zinc-700 flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-white">Spot Budget Details</h2>
            <p className="text-xs text-zinc-400 mt-0.5 font-mono">{start} → {end}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-700 rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto px-6 py-5 space-y-7">
          {/* ── 1. Budget math ─────────────────────────────────────────────── */}
          <section>
            <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
              How the budget is calculated
            </h3>
            <div className="space-y-2">
              {waterfallRows.map((row) => (
                <div key={row.label} className="flex items-center gap-3">
                  <span className="text-sm text-zinc-300 w-56 flex-shrink-0">{row.label}</span>
                  <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${row.barCls}`}
                      style={{ width: raw.minutes > 0 ? `${Math.min(100, (row.minutes / raw.minutes) * 100)}%` : '0%' }}
                    />
                  </div>
                  <span className="text-sm font-mono text-zinc-300 w-24 text-right">{fmtMin(row.minutes)} min</span>
                  <span className="text-xs text-zinc-400 w-36">{row.breaks}</span>
                </div>
              ))}
              <div className="flex items-center gap-3 pt-2 border-t border-zinc-800">
                <span className="text-sm text-zinc-200 font-medium w-56 flex-shrink-0">= Available</span>
                <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full bg-brand-500"
                    style={{ width: raw.minutes > 0 ? `${Math.min(100, (availGlobal.minutes / raw.minutes) * 100)}%` : '0%' }}
                  />
                </div>
                <span className="text-2xl font-semibold text-white w-24 text-right whitespace-nowrap">{fmtMin(availGlobal.minutes)}</span>
                <span className="text-xs text-zinc-400 w-36">min · {availGlobal.breaks} first-slot free</span>
              </div>
            </div>
            {raw.minutes === 0 && (
              <p className="text-xs text-amber-400 mt-3">
                Schedule doesn't resolve for this window — add calendar or template entries. Inventory only
                counts commercial breaks from calendar and template coverage; time served by the default
                (fallback) clock is not sellable.
              </p>
            )}
          </section>

          {/* ── 2. Per-day strip ───────────────────────────────────────────── */}
          <section>
            <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
              Inventory by day
            </h3>
            {days.length === 0 ? (
              <p className="text-xs text-zinc-400 italic">Loading…</p>
            ) : (
              <>
                <div className="flex items-end gap-px h-16">
                  {days.map((d: SpotBudgetDayDetail) => {
                    const sourceLabel = d.source === 'none' ? 'no schedule coverage' : `${d.source} coverage`;
                    const tooltip = `${WEEKDAYS[d.dow - 1]} ${d.date} — ${fmtMin(d.minutes)} min · ${d.breaks} breaks · ${sourceLabel}`;
                    let bar;
                    if (d.breaks > 0) {
                      const pct = maxDayMinutes > 0 ? Math.max((d.minutes / maxDayMinutes) * 100, 4) : 0;
                      bar = <div className="bg-brand-500 rounded-t-sm w-full" style={{ height: `${pct}%` }} />;
                    } else if (d.source !== 'none') {
                      bar = <div className="h-1 bg-amber-500 w-full" />;
                    } else {
                      bar = <div className="h-1 bg-red-500/70 w-full" />;
                    }
                    return (
                      <div
                        key={d.date}
                        title={tooltip}
                        className={`flex-1 flex flex-col justify-end h-full ${d.source === 'none' ? 'bg-red-500/10' : ''}`}
                      >
                        {bar}
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-between text-[10px] text-zinc-400 font-mono mt-1">
                  <span>{days[0].date.slice(5)}</span>
                  {days.length > 14 && <span>{days[Math.floor(days.length / 2)].date.slice(5)}</span>}
                  <span>{days[days.length - 1].date.slice(5)}</span>
                </div>
                <div className="flex items-center gap-5 mt-3 text-xs text-zinc-400">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-sm bg-brand-500 inline-block" /> has breaks
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-sm bg-amber-500 inline-block" /> covered · no breaks in clock
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-sm bg-red-500/70 inline-block" /> no coverage (falls to default clock — not counted)
                  </span>
                </div>
              </>
            )}
          </section>

          {/* ── 3. Demand by campaign ──────────────────────────────────────── */}
          <section>
            <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
              Demand by campaign
            </h3>
            {sortedDemand.length === 0 ? (
              <p className="text-xs text-zinc-400 italic">No active campaign demand in this window.</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-zinc-400 border-b border-zinc-800">
                    <th className="py-1.5 pr-3 font-medium">Campaign</th>
                    <th className="py-1.5 pr-3 font-medium">Customer</th>
                    <th className="py-1.5 pr-3 font-medium">Scope</th>
                    <th className="py-1.5 pr-3 font-medium text-right">Minutes</th>
                    <th className="py-1.5 font-medium text-right">First-slot breaks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {sortedDemand.map((entry) => {
                    const campaign = campaignById.get(entry.campaignId);
                    let scopeLabel = 'Global';
                    if (typeof entry.scope === 'object') {
                      if ('intervalId' in entry.scope) {
                        scopeLabel = intervalNameById.get(entry.scope.intervalId) ?? `Interval #${entry.scope.intervalId}`;
                      } else {
                        scopeLabel = showNameById.get(entry.scope.showId) ?? `Show #${entry.scope.showId}`;
                      }
                    }
                    return (
                      <tr key={entry.campaignId}>
                        <td className="py-1.5 pr-3 text-zinc-200">{campaign?.name ?? `Campaign #${entry.campaignId}`}</td>
                        <td className="py-1.5 pr-3 text-zinc-400">{campaign?.customer_name ?? '—'}</td>
                        <td className="py-1.5 pr-3 text-zinc-400">{scopeLabel}</td>
                        <td className="py-1.5 pr-3 text-right font-mono text-zinc-300">{fmtMin(entry.minutes)}</td>
                        <td className="py-1.5 text-right font-mono text-zinc-300">{entry.firstSlotBreaks || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          {/* ── 4. Per-interval breakdown ──────────────────────────────────── */}
          {intervalKeys.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                By airing window
              </h3>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-zinc-400 border-b border-zinc-800">
                    <th className="py-1.5 pr-3 font-medium">Interval</th>
                    <th className="py-1.5 pr-3 font-medium text-right">Effective (min / breaks)</th>
                    <th className="py-1.5 pr-3 font-medium text-right">Demand</th>
                    <th className="py-1.5 font-medium text-right">Available</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {intervalKeys.map((key) => {
                    const eff = inventory.effective.byInterval[key] ?? emptyBudget();
                    const dem = demand.totals.byInterval[key] ?? emptyBudget();
                    const avail = available.byInterval[key] ?? emptyBudget();
                    return (
                      <tr key={key}>
                        <td className="py-1.5 pr-3 text-zinc-200">{intervalNameById.get(key) ?? `Interval #${key}`}</td>
                        <td className="py-1.5 pr-3 text-right font-mono text-zinc-300">{fmtMin(eff.minutes)} / {eff.breaks}</td>
                        <td className="py-1.5 pr-3 text-right font-mono text-zinc-300">{fmtMin(dem.minutes)}</td>
                        <td className="py-1.5 text-right font-mono text-zinc-300">{fmtMin(avail.minutes)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
