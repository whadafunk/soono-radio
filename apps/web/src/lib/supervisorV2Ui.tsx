import { Circle, Mic2, Music2, Megaphone, Radio, FileText, Volume2, Layers } from 'lucide-react';

export function fmtMmSs(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function fmtDriftSign(seconds: number): string {
  if (Math.abs(seconds) < 0.05) return '0.0s';
  const sign = seconds > 0 ? '+' : '−';
  return `${sign}${Math.abs(seconds).toFixed(1)}s`;
}

export function fmtRelativeTime(unixMs: number | null): string {
  if (unixMs === null) return 'never';
  const ago = Math.floor((Date.now() - unixMs) / 1000);
  if (ago < 60) return `${ago}s ago`;
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
  return `${Math.floor(ago / 3600)}h ago`;
}

export const CONTENT_TYPE_META: Record<
  string,
  { label: string; Icon: React.ElementType; color: string; barColor: string }
> = {
  music:       { label: 'Music',      Icon: Music2,    color: 'text-brand-400',  barColor: 'bg-brand-500'  },
  jingle:      { label: 'Jingle',     Icon: Volume2,   color: 'text-cyan-400',    barColor: 'bg-cyan-500'    },
  branding:    { label: 'Branding',   Icon: Radio,     color: 'text-violet-400',  barColor: 'bg-violet-500'  },
  station_id:  { label: 'Station ID', Icon: Radio,     color: 'text-violet-400',  barColor: 'bg-violet-500'  },
  campaign:    { label: 'Campaign',   Icon: Megaphone, color: 'text-amber-400',   barColor: 'bg-amber-500'   },
  promo:       { label: 'Promo',      Icon: Megaphone, color: 'text-orange-400',  barColor: 'bg-orange-500'  },
  rundown:     { label: 'Rundown',    Icon: FileText,  color: 'text-teal-400',    barColor: 'bg-teal-500'    },
  voice_track: { label: 'Voice',      Icon: Mic2,      color: 'text-pink-400',    barColor: 'bg-pink-500'    },
  filler:      { label: 'Filler',     Icon: Layers,    color: 'text-zinc-400',    barColor: 'bg-zinc-500'    },
};

export function ContentTypeCell({ type }: { type: string }) {
  const meta = CONTENT_TYPE_META[type] ?? {
    label: type,
    Icon: Circle,
    color: 'text-zinc-400',
    barColor: 'bg-zinc-500',
  };
  const { label, Icon, color } = meta;
  return (
    <span className={`inline-flex items-center gap-1 ${color}`}>
      <Icon className="w-3.5 h-3.5 flex-shrink-0" />
      <span className="text-xs">{label}</span>
    </span>
  );
}

// Maps clockResolver.ts's 4 resolution tiers to the operator-facing 3-tier
// framing: Calendar (normal) -> Template (fallback 1, merges template_clock's
// per-hour override and template's day/time window) -> Default Clock
// (fallback 2, station_settings.default_clock_id).
export function scheduleSourceMeta(sourceType: string): { label: string; cls: string } {
  switch (sourceType) {
    case 'calendar':
      return { label: 'Calendar', cls: 'text-green-400' };
    case 'template_clock':
    case 'template':
      return { label: 'Template', cls: 'text-amber-400' };
    case 'default':
      return { label: 'Default Clock', cls: 'text-red-400' };
    default:
      return { label: sourceType, cls: 'text-zinc-400' };
  }
}

// ─── Segment timeline layout ──────────────────────────────────────────────────
//
// Pure layout math for the Segment Timeline, kept independent of JSX so the
// geometry can be reasoned about (and sanity-checked) on its own.
//
// Model: one continuous real-content bar, laid out at a single literal
// seconds-per-pixel scale, with the segment's nominal/configured length as a
// reference line falling somewhere *inside* it rather than a separate region:
//   - Content blocks are positioned by their own real durations, starting at
//     the segment's actual start (position 0), not the nominal/scheduled
//     start — those coincide only when boundary drift is zero.
//   - boundary_drift_seconds < 0 means real content genuinely began before
//     the nominal start (the previous segment came up short and this one's
//     content started early to cover it). That stretch is real audio.
//   - Real content extending past the nominal end is overshoot.
// Either way, the hash texture is applied directly to whichever individual
// block(s) overlap the boundary — never as one blanket region spanning to
// the bar's edge. The assembler only ever lets ONE track cross a boundary
// (a single greedy placement decision, D72) — an overshoot spanning several
// blocks would mean several unrelated tracks got hashed as if they were one
// continuous anomaly, which misrepresents what actually happened. Found
// 2026-07-15: an early version overlaid one rectangle from the nominal line
// to 100%, which — combined with a stale/inconsistent planned_overshoot_
// seconds value — hashed eight unrelated blocks at once.
//
// Overshoot/gap classification is derived purely from real data (sum of
// actual item durations vs. nominal length), not from planned_overshoot_
// seconds — that field is a one-time snapshot frozen at plan activation and
// can diverge from what's actually been assembled since (see plan_internal_
// drift_seconds for that comparison instead). Deriving from real items keeps
// the bar always internally consistent with what it's actually drawing.
//
// intentional_offset_seconds (the deliberate pre-assembly target-sizing
// correction) is deliberately NOT represented on this bar — it's a planning
// decision, not a fact about real audio, and doesn't have a stable location
// to point to. It's surfaced as a header stat instead (see SupervisorPage).

export interface TimelineContentInput {
  durationSeconds: number;
  barColor: string;
  isTerminal: boolean;
  isPlaying: boolean;
  label: string;
  // Extra detail carried through for hover tooltips only — unused by the
  // layout math itself.
  contentTypeLabel: string;
  statusLabel: string;
}

export interface TimelineContentBlock extends TimelineContentInput {
  leftPct: number;
  widthPct: number;
  // How much of THIS block's own width (0-100) falls before the nominal
  // start or past the nominal end — hash the corresponding edge of this
  // block only, never a separate region spanning multiple blocks.
  leadHashPctOfBlock: number;
  trailHashPctOfBlock: number;
}

export interface TimelineLayout {
  // Width of the leading "real content, started early" span — 0 unless
  // boundary drift is negative. Purely a reference value now; the hash
  // itself lives on whichever content block(s) it overlaps.
  leadingPct: number;
  leadingSeconds: number;
  // Late start (boundary drift > 0): schedule time that passed before this
  // segment's content actually began. Rendered as an empty dark region at
  // the front of the scheduled window with a marker line where content
  // starts — the distance from bar start to that line is exactly how much
  // the segment was shortened by.
  lateStartPct: number;
  lateStartSeconds: number;
  // Where real content begins on the bar (0 unless late start).
  contentStartPct: number;
  // Reference positions marking the segment's nominal/configured window on
  // this bar's real-seconds scale. nominalStartPct equals leadingPct in the
  // early-start case and 0 in the late-start case.
  nominalStartPct: number;
  nominalEndPct: number;
  contentBlocks: TimelineContentBlock[];
  // Where real content ends — may fall before or after nominalEndPct.
  contentEndPct: number;
  // The separately-rendered Gap region (real content short of nominal) —
  // 0 width when there's no shortfall. This one genuinely has no content to
  // attach to, so it stays its own region rather than a per-block overlay.
  gapPct: number;
  gapLeftPct: number;
  trailingKind: 'gap' | 'overshoot' | null;
  trailingSeconds: number;
  totalContentSeconds: number;
  // Position a plan-consumed-seconds value (measured from the real start of
  // content) onto the bar.
  planPositionToPct: (planConsumedSeconds: number) => number;
  // Position a wall-clock-elapsed-since-scheduled-start value onto the bar.
  // Negative elapsed (wall clock hasn't reached the scheduled start yet —
  // the early-start window) is valid and lands before nominalStartPct.
  wallClockToPct: (calendarElapsedSeconds: number) => number;
}

export function computeTimelineLayout(
  nominalDurationSeconds: number,
  boundaryDriftSeconds: number,
  items: TimelineContentInput[],
): TimelineLayout {
  // Two anchor points on one seconds scale, whichever is earlier at 0:
  //   early start (drift < 0): content at 0, scheduled start after it.
  //   late start (drift > 0): scheduled start at 0, content after it.
  const leadingSeconds = boundaryDriftSeconds < 0 ? -boundaryDriftSeconds : 0;
  const lateStartSeconds = boundaryDriftSeconds > 0 ? boundaryDriftSeconds : 0;
  const contentStartSeconds = lateStartSeconds;
  const scheduledStartSeconds = leadingSeconds;

  const totalContentSeconds = items.reduce((sum, it) => sum + it.durationSeconds, 0);

  const nominalEndSeconds = scheduledStartSeconds + nominalDurationSeconds;
  // Derived from real, always-consistent data — never from planned_
  // overshoot_seconds (see module header comment for why).
  const trailingSeconds = contentStartSeconds + totalContentSeconds - nominalEndSeconds;
  const trailingKind: 'gap' | 'overshoot' | null =
    trailingSeconds === 0 ? null : trailingSeconds > 0 ? 'overshoot' : 'gap';

  // At least one of these two is always the true extent of the bar — real
  // content when overshooting, the nominal reference when it falls short
  // (so there's still room to draw the Gap region and the reference line).
  const containerTotalSeconds = Math.max(contentStartSeconds + totalContentSeconds, nominalEndSeconds, 1);

  const pct = (seconds: number): number => (seconds / containerTotalSeconds) * 100;

  const leadingPct = pct(leadingSeconds);
  const lateStartPct = pct(lateStartSeconds);
  const contentStartPct = pct(contentStartSeconds);
  const nominalStartPct = pct(scheduledStartSeconds);
  const nominalEndPct = pct(nominalEndSeconds);
  const contentEndPct = pct(contentStartSeconds + totalContentSeconds);

  let cursor = contentStartPct;
  const contentBlocks: TimelineContentBlock[] = items.map((item) => {
    const widthPct = pct(item.durationSeconds);
    const blockStart = cursor;
    const blockEnd = cursor + widthPct;
    const leadOverlapPct = Math.max(0, Math.min(blockEnd, nominalStartPct) - blockStart);
    const trailOverlapPct = Math.max(0, blockEnd - Math.max(blockStart, nominalEndPct));
    const block: TimelineContentBlock = {
      ...item,
      leftPct: blockStart,
      widthPct,
      leadHashPctOfBlock: widthPct > 0 ? (leadOverlapPct / widthPct) * 100 : 0,
      trailHashPctOfBlock: widthPct > 0 ? (trailOverlapPct / widthPct) * 100 : 0,
    };
    cursor = blockEnd;
    return block;
  });

  const gapPct = trailingKind === 'gap' ? Math.max(0, nominalEndPct - contentEndPct) : 0;

  const planPositionToPct = (planConsumedSeconds: number): number =>
    pct(contentStartSeconds + Math.min(Math.max(0, planConsumedSeconds), totalContentSeconds));

  const wallClockToPct = (calendarElapsedSeconds: number): number =>
    pct(Math.max(0, scheduledStartSeconds + calendarElapsedSeconds));

  return {
    leadingPct,
    leadingSeconds,
    lateStartPct,
    lateStartSeconds,
    contentStartPct,
    nominalStartPct,
    nominalEndPct,
    contentBlocks,
    contentEndPct,
    gapPct,
    gapLeftPct: contentEndPct,
    trailingKind,
    trailingSeconds,
    totalContentSeconds,
    planPositionToPct,
    wallClockToPct,
  };
}

// ─── Drift severity (operator-defined intervals, 2026-07-16) ─────────────────
// green: |drift| ≤ 120s · yellow: 121–600s · red: > 600s
export type DriftSeverity = 'green' | 'yellow' | 'red';

export function driftSeverity(driftSeconds: number): DriftSeverity {
  const abs = Math.abs(driftSeconds);
  return abs <= 120 ? 'green' : abs <= 600 ? 'yellow' : 'red';
}

export const DRIFT_SEVERITY_TEXT: Record<DriftSeverity, string> = {
  green: 'text-green-400',
  yellow: 'text-amber-400',
  red: 'text-red-400',
};

export function heartbeatStatus(lastHeartbeatAt: number | null): { label: string; cls: string; dotCls: string } {
  const heartbeatAgo = lastHeartbeatAt ? Math.floor((Date.now() - lastHeartbeatAt) / 1000) : null;
  if (heartbeatAgo === null) return { label: 'offline', cls: 'text-red-400', dotCls: 'bg-red-500' };
  if (heartbeatAgo < 60) return { label: 'ok', cls: 'text-green-400', dotCls: 'bg-green-500' };
  if (heartbeatAgo < 300) return { label: 'stale', cls: 'text-amber-400', dotCls: 'bg-amber-500' };
  return { label: 'offline', cls: 'text-red-400', dotCls: 'bg-red-500' };
}
