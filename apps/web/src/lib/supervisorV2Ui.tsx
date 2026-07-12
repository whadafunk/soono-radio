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
// geometry can be reasoned about (and sanity-checked) on its own. Model,
// left to right: [offset region][scheduled-boundary reference][content
// blocks][trailing region: gap or overshoot]. Offset and trailing regions use
// hybrid sizing — a floor so a small anomaly stays readable, a cap so a large
// one doesn't dominate the bar, linear in between; the exact seconds are
// always available for a tooltip/label regardless of the clamped width.
// Content is scaled against actual planned length (sum of item durations),
// not the nominal segment duration, per design discussion.

const OFFSET_OVERSHOOT_FLOOR_PCT = 6;
const OFFSET_OVERSHOOT_CAP_PCT = 20;

function hybridRegionPct(seconds: number, nominalDurationSeconds: number): number {
  if (seconds === 0 || nominalDurationSeconds <= 0) return 0;
  const raw = (Math.abs(seconds) / nominalDurationSeconds) * 100;
  return Math.min(OFFSET_OVERSHOOT_CAP_PCT, Math.max(OFFSET_OVERSHOOT_FLOOR_PCT, raw));
}

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
}

export interface TimelineLayout {
  // 0 when there's no intentional offset.
  offsetPct: number;
  offsetSide: 'lead' | 'bite' | null;
  offsetSeconds: number;
  // Where the "scheduled boundary" reference line sits — always the same
  // position as offsetPct (the boundary between the offset region and
  // content), kept as its own name for clarity at call sites.
  scheduledBoundaryPct: number;
  contentBlocks: TimelineContentBlock[];
  contentPct: number;
  // 0 when there's no gap/overshoot.
  trailingPct: number;
  trailingKind: 'gap' | 'overshoot' | null;
  trailingSeconds: number;
  totalContentSeconds: number;
  // Position a plan-consumed-seconds value (measured from the start of
  // content, i.e. right at the scheduled-boundary line) onto the bar.
  planPositionToPct: (planConsumedSeconds: number) => number;
  // Position a wall-clock-elapsed-since-nominal-start value onto the bar.
  wallClockToPct: (calendarElapsedSeconds: number) => number;
}

export function computeTimelineLayout(
  nominalDurationSeconds: number,
  intentionalOffsetSeconds: number,
  items: TimelineContentInput[],
  plannedOvershootSeconds: number,
): TimelineLayout {
  const offsetSeconds = intentionalOffsetSeconds;
  const offsetSide: 'lead' | 'bite' | null =
    offsetSeconds === 0 ? null : offsetSeconds < 0 ? 'lead' : 'bite';
  const offsetPct = hybridRegionPct(offsetSeconds, nominalDurationSeconds);

  const trailingSeconds = plannedOvershootSeconds;
  const trailingKind: 'gap' | 'overshoot' | null =
    trailingSeconds === 0 ? null : trailingSeconds > 0 ? 'overshoot' : 'gap';
  const trailingPct = hybridRegionPct(trailingSeconds, nominalDurationSeconds);

  const contentPct = Math.max(0, 100 - offsetPct - trailingPct);
  const totalContentSeconds = items.reduce((sum, it) => sum + it.durationSeconds, 0);

  let cursor = 0;
  const contentBlocks: TimelineContentBlock[] = items.map((item) => {
    const widthPct =
      totalContentSeconds > 0 ? (item.durationSeconds / totalContentSeconds) * contentPct : 0;
    const block: TimelineContentBlock = { ...item, leftPct: offsetPct + cursor, widthPct };
    cursor += widthPct;
    return block;
  });

  const planPositionToPct = (planConsumedSeconds: number): number => {
    if (totalContentSeconds <= 0) return offsetPct;
    if (planConsumedSeconds <= totalContentSeconds) {
      return offsetPct + (planConsumedSeconds / totalContentSeconds) * contentPct;
    }
    // Past all known content — ease into the trailing overshoot region (if
    // any); a gap has no further seconds to represent, so just sit at its end.
    const intoTrailing = planConsumedSeconds - totalContentSeconds;
    const trailingSpanSeconds = trailingKind === 'overshoot' ? Math.abs(trailingSeconds) : 0;
    const frac = trailingSpanSeconds > 0 ? Math.min(1, intoTrailing / trailingSpanSeconds) : 1;
    return offsetPct + contentPct + frac * trailingPct;
  };

  const wallClockToPct = (calendarElapsedSeconds: number): number => {
    if (nominalDurationSeconds <= 0) return offsetPct;
    const frac = Math.min(1, Math.max(0, calendarElapsedSeconds / nominalDurationSeconds));
    return offsetPct + frac * (100 - offsetPct);
  };

  return {
    offsetPct,
    offsetSide,
    offsetSeconds,
    scheduledBoundaryPct: offsetPct,
    contentBlocks,
    contentPct,
    trailingPct,
    trailingKind,
    trailingSeconds,
    totalContentSeconds,
    planPositionToPct,
    wallClockToPct,
  };
}

export function heartbeatStatus(lastHeartbeatAt: number | null): { label: string; cls: string; dotCls: string } {
  const heartbeatAgo = lastHeartbeatAt ? Math.floor((Date.now() - lastHeartbeatAt) / 1000) : null;
  if (heartbeatAgo === null) return { label: 'offline', cls: 'text-red-400', dotCls: 'bg-red-500' };
  if (heartbeatAgo < 60) return { label: 'ok', cls: 'text-green-400', dotCls: 'bg-green-500' };
  if (heartbeatAgo < 300) return { label: 'stale', cls: 'text-amber-400', dotCls: 'bg-amber-500' };
  return { label: 'offline', cls: 'text-red-400', dotCls: 'bg-red-500' };
}
