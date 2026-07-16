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

// ─── Segment timeline layout (grammar v3, 2026-07-17 — operator spec) ────────
//
// Pure layout math for the Segment Timeline, kept independent of JSX so the
// geometry can be reasoned about (and sanity-checked) on its own.
//
// THE BAR IS A LENGTH DIAGRAM, NOT A WALL-CLOCK DIAGRAM. It shows how
// planning and drift correction composed this plan's span; WHEN anything
// happens (start times, measured drift) lives exclusively in the header
// numbers and the playhead/wall-clock arrow. One axis per instrument —
// the previous grammar mixed both frames and its regions kept reading as
// missing audio when they were schedule-shift bookkeeping.
//
//   Front of the bar = what drift correction did to this plan's length:
//     - extension (correction < 0, target > nominal): a "start early"
//       region of |correction| seconds — REAL content, hashed on the
//       leading block(s). The scheduled length is everything after it.
//     - shortening (correction > 0, target < nominal): a front GAP region —
//       the part of the scheduled length this plan deliberately does not
//       provide — with a marker line where content begins.
//   End of the bar = what assembly did against the REQUESTED length
//   (the target — planner vocabulary, exact):
//     - gap: assembled short of target — hatched region that genuinely
//       never plays under this plan;
//     - overshoot: assembled past target — hashed on the boundary block(s)
//       extending past the frame.
//
//   By construction the requested end and the scheduled end coincide at one
//   position (front region + scheduled = target end), so a single dashed
//   line marks both.
//
// This deliberately REINSTATES the applied correction as a bar region — an
// earlier round rejected that ("a sizing decision doesn't correspond to when
// real audio started"), which was valid for a wall-clock-anchored bar; with
// the wall-clock claim removed from the bar entirely, the objection no
// longer applies (operator decision 2026-07-17, see Decision 100).
//
// The hash texture still attaches to individual blocks, never a blanket
// region spanning several (D72: only one track crosses a boundary).

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
  // Front "start early" span: the drift-correction EXTENSION (target above
  // nominal). Real content — the hash lives on the leading block(s).
  extensionPct: number;
  extensionSeconds: number;
  // Front gap: the drift-correction SHORTENING (target below nominal) — the
  // part of the scheduled length this plan deliberately does not provide.
  // Empty hatched region with a marker line where content begins.
  shorteningPct: number;
  shorteningSeconds: number;
  // Where content begins on the bar (0 unless shortened).
  contentStartPct: number;
  // The requested length's end — which by construction is ALSO the scheduled
  // length's end (front region + scheduled = target end). One dashed line,
  // both meanings.
  targetEndPct: number;
  targetSeconds: number;
  contentBlocks: TimelineContentBlock[];
  contentEndPct: number;
  // Trailing planner gap (assembled short of requested): hatched region that
  // genuinely never plays under this plan. 0 when none.
  gapPct: number;
  gapLeftPct: number;
  trailingKind: 'gap' | 'overshoot' | null;
  trailingSeconds: number;
  totalContentSeconds: number;
  // Position a plan-consumed-seconds value onto the bar (content space).
  planPositionToPct: (planConsumedSeconds: number) => number;
}

export function computeTimelineLayout(
  nominalDurationSeconds: number,
  // nominal − target (the supervisor's applied correction): negative =
  // extended plan, positive = shortened plan.
  appliedCorrectionSeconds: number,
  items: TimelineContentInput[],
): TimelineLayout {
  const extensionSeconds = appliedCorrectionSeconds < 0 ? -appliedCorrectionSeconds : 0;
  const shorteningSeconds = appliedCorrectionSeconds > 0 ? appliedCorrectionSeconds : 0;
  const targetSeconds = nominalDurationSeconds - appliedCorrectionSeconds;

  const totalContentSeconds = items.reduce((sum, it) => sum + it.durationSeconds, 0);
  const contentStartSeconds = shorteningSeconds;
  const contentEndSeconds = contentStartSeconds + totalContentSeconds;

  // Requested end == scheduled end, one position: front region + scheduled
  // length. (Extended: extension + nominal = target. Shortened: nominal,
  // with content occupying target inside it.)
  const targetEndSeconds = nominalDurationSeconds + extensionSeconds;

  // Assembly deviation vs the REQUESTED length — planner vocabulary, exact.
  const trailingSeconds = contentEndSeconds - targetEndSeconds;
  const trailingKind: 'gap' | 'overshoot' | null =
    trailingSeconds === 0 ? null : trailingSeconds > 0 ? 'overshoot' : 'gap';

  const containerTotalSeconds = Math.max(contentEndSeconds, targetEndSeconds, 1);
  const pct = (seconds: number): number => (seconds / containerTotalSeconds) * 100;

  const extensionPct = pct(extensionSeconds);
  const shorteningPct = pct(shorteningSeconds);
  const contentStartPct = pct(contentStartSeconds);
  const targetEndPct = pct(targetEndSeconds);
  const contentEndPct = pct(contentEndSeconds);

  let cursor = contentStartPct;
  const contentBlocks: TimelineContentBlock[] = items.map((item) => {
    const widthPct = pct(item.durationSeconds);
    const blockStart = cursor;
    const blockEnd = cursor + widthPct;
    // Leading hash: the extension's worth of content at the front.
    const leadOverlapPct = Math.max(0, Math.min(blockEnd, extensionPct) - blockStart);
    // Trailing hash: content past the requested end.
    const trailOverlapPct = Math.max(0, blockEnd - Math.max(blockStart, targetEndPct));
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

  const gapPct = trailingKind === 'gap' ? Math.max(0, targetEndPct - contentEndPct) : 0;

  const planPositionToPct = (planConsumedSeconds: number): number =>
    pct(contentStartSeconds + Math.min(Math.max(0, planConsumedSeconds), totalContentSeconds));

  return {
    extensionPct,
    extensionSeconds,
    shorteningPct,
    shorteningSeconds,
    contentStartPct,
    targetEndPct,
    targetSeconds,
    contentBlocks,
    contentEndPct,
    gapPct,
    gapLeftPct: contentEndPct,
    trailingKind,
    trailingSeconds,
    totalContentSeconds,
    planPositionToPct,
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
