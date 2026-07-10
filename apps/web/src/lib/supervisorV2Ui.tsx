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

export function heartbeatStatus(lastHeartbeatAt: number | null): { label: string; cls: string; dotCls: string } {
  const heartbeatAgo = lastHeartbeatAt ? Math.floor((Date.now() - lastHeartbeatAt) / 1000) : null;
  if (heartbeatAgo === null) return { label: 'offline', cls: 'text-red-400', dotCls: 'bg-red-500' };
  if (heartbeatAgo < 60) return { label: 'ok', cls: 'text-green-400', dotCls: 'bg-green-500' };
  if (heartbeatAgo < 300) return { label: 'stale', cls: 'text-amber-400', dotCls: 'bg-amber-500' };
  return { label: 'offline', cls: 'text-red-400', dotCls: 'bg-red-500' };
}
