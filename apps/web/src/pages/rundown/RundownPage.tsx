import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeft, ChevronRight, Search, X, Check, AlertTriangle, Clock,
  Mic, FileText, Radio, CircleOff,
} from 'lucide-react';
import {
  fetchRundown, upsertRundownAssignment, deleteRundownAssignment,
  upsertRundownDurationOverride, deleteRundownDurationOverride,
  fetchLibrary,
  type RundownSlot, type RundownAssignmentUpsert,
} from '../../api';
import type { Media } from '@radio/shared';

// ── Date helpers ──────────────────────────────────────────────────────────────

function pad2(n: number) { return n < 10 ? `0${n}` : `${n}`; }

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function parseDateLocal(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function displayDate(s: string): string {
  const d = parseDateLocal(s);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${pad2(s)}`;
}

function fmtTime12(t: string): string {
  const [h, m] = t.split(':').map(Number);
  const ampm = h < 12 ? 'AM' : 'PM';
  const hour = h % 12 || 12;
  return `${hour}:${pad2(m)} ${ampm}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type SlotKey = string; // "date|time_start|clock_id|segment_index"

function slotKey(s: RundownSlot): SlotKey {
  return `${s.date}|${s.time_start}|${s.clock_id}|${s.segment_index}`;
}

interface ClockInstance {
  date: string;
  time_start: string;
  clock_id: number;
  clock_name: string;
  slots: RundownSlot[];
}

function groupIntoInstances(slots: RundownSlot[]): ClockInstance[] {
  const map = new Map<string, ClockInstance>();
  for (const slot of slots) {
    const k = `${slot.date}|${slot.time_start}|${slot.clock_id}`;
    if (!map.has(k)) {
      map.set(k, { date: slot.date, time_start: slot.time_start, clock_id: slot.clock_id, clock_name: slot.clock_name, slots: [] });
    }
    map.get(k)!.slots.push(slot);
  }
  return [...map.values()];
}

// ── Segment type icon ─────────────────────────────────────────────────────────

function SegTypeIcon({ type }: { type: string }) {
  if (type === 'news') return <FileText className="w-3.5 h-3.5 flex-shrink-0" />;
  if (type === 'bulletin') return <Radio className="w-3.5 h-3.5 flex-shrink-0" />;
  if (type === 'voice_track') return <Mic className="w-3.5 h-3.5 flex-shrink-0" />;
  return null;
}

// ── Readiness dot ─────────────────────────────────────────────────────────────

function ReadinessDot({ slots }: { slots: RundownSlot[] }) {
  const total = slots.length;
  const assigned = slots.filter((s) => s.is_assigned).length;
  if (total === 0) return null;
  if (assigned === total) return <span className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />;
  if (assigned === 0) return <span className="w-2 h-2 rounded-full bg-zinc-600 flex-shrink-0" />;
  return <span className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />;
}

// ── Mini timeline ─────────────────────────────────────────────────────────────

const RUNDOWN_TYPES = new Set(['news', 'bulletin', 'voice_track']);

function MiniTimeline({ slot }: { slot: RundownSlot }) {
  const segments = slot.clock_segments;
  const total = segments.reduce((sum, s) => {
    const isRundown = RUNDOWN_TYPES.has(s.type);
    // If this segment is the current one, use effective_duration for it
    if (s.id === slot.segment_id) return sum + slot.effective_duration_seconds;
    return sum + s.duration_seconds;
  }, 0);
  if (total === 0) return null;

  return (
    <div className="flex h-1.5 rounded-full overflow-hidden w-full gap-px">
      {segments.map((seg, i) => {
        const dur = seg.id === slot.segment_id ? slot.effective_duration_seconds : seg.duration_seconds;
        const pct = (dur / total) * 100;
        let bg = 'bg-zinc-700';
        if (seg.type === 'music') bg = 'bg-indigo-500/60';
        else if (seg.type === 'stop_set') bg = 'bg-orange-500/60';
        else if (seg.type === 'live') bg = 'bg-emerald-500/60';
        else if (RUNDOWN_TYPES.has(seg.type)) {
          if (seg.id === slot.segment_id) {
            bg = slot.is_assigned ? 'bg-sky-400' : 'bg-amber-400';
          } else {
            bg = 'bg-sky-500/50';
          }
        }
        return (
          <div
            key={i}
            className={`${bg} flex-shrink-0`}
            style={{ width: `${pct}%` }}
            title={`${seg.name} (${seg.type}) ${formatDuration(dur)}`}
          />
        );
      })}
    </div>
  );
}

// ── Duration override input ───────────────────────────────────────────────────

function DurationField({ slot, onOverride, onClearOverride }: {
  slot: RundownSlot;
  onOverride: (secs: number) => void;
  onClearOverride: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');

  const effectiveSecs = slot.effective_duration_seconds;
  const hasOverride = slot.duration_override_seconds != null;

  if (!editing) {
    return (
      <button
        onClick={() => { setVal(String(effectiveSecs)); setEditing(true); }}
        className={`text-xs tabular-nums ${hasOverride ? 'text-amber-400' : 'text-zinc-400'} hover:text-white`}
        title={hasOverride ? `Template: ${formatDuration(slot.template_duration_seconds)}` : 'Click to override duration'}
      >
        {formatDuration(effectiveSecs)}
        {hasOverride && ' *'}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <input
        autoFocus
        type="number"
        min={1}
        className="w-16 text-xs bg-zinc-800 border border-zinc-600 rounded px-1.5 py-0.5 text-white tabular-nums"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const n = parseInt(val, 10);
            if (n > 0) { onOverride(n); setEditing(false); }
          }
          if (e.key === 'Escape') setEditing(false);
        }}
      />
      <button onClick={() => { const n = parseInt(val, 10); if (n > 0) { onOverride(n); setEditing(false); } }} className="text-emerald-400 hover:text-emerald-300">
        <Check className="w-3 h-3" />
      </button>
      {hasOverride && (
        <button onClick={() => { onClearOverride(); setEditing(false); }} className="text-zinc-500 hover:text-red-400" title="Remove override">
          <X className="w-3 h-3" />
        </button>
      )}
      <button onClick={() => setEditing(false)} className="text-zinc-500 hover:text-zinc-300">
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

// ── Slot row ──────────────────────────────────────────────────────────────────

function SlotRow({ slot, onAssign, onClearAssignment, onOverride, onClearOverride }: {
  slot: RundownSlot;
  onAssign: (slot: RundownSlot) => void;
  onClearAssignment: (slot: RundownSlot) => void;
  onOverride: (slot: RundownSlot, secs: number) => void;
  onClearOverride: (slot: RundownSlot) => void;
}) {
  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-zinc-800/50 group">
      {/* Readiness dot */}
      {slot.is_assigned
        ? <span className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
        : <span className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />}

      {/* Segment info */}
      <div className="flex items-center gap-1.5 w-24 flex-shrink-0">
        <SegTypeIcon type={slot.segment_type} />
        <span className="text-xs text-zinc-400 truncate">{slot.segment_name}</span>
      </div>

      {/* Assignment */}
      <div className="flex-1 min-w-0">
        {slot.is_assigned ? (
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-sm text-white truncate leading-tight">{slot.assignment?.media_title ?? slot.assignment?.media_original_filename}</p>
              {slot.assignment?.media_artist && (
                <p className="text-xs text-zinc-400 truncate">{slot.assignment.media_artist}</p>
              )}
            </div>
            <button
              onClick={() => onClearAssignment(slot)}
              className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 transition-opacity flex-shrink-0"
              title="Remove assignment"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <button
            onClick={() => onAssign(slot)}
            className="text-xs text-zinc-500 hover:text-indigo-400 transition-colors"
          >
            + Assign content
          </button>
        )}
      </div>

      {/* Duration */}
      <div className="flex-shrink-0 w-16 text-right">
        <DurationField
          slot={slot}
          onOverride={(secs) => onOverride(slot, secs)}
          onClearOverride={() => onClearOverride(slot)}
        />
      </div>

      {/* Mini timeline */}
      <div className="w-24 flex-shrink-0">
        <MiniTimeline slot={slot} />
      </div>
    </div>
  );
}

// ── Clock instance card ───────────────────────────────────────────────────────

function ClockCard({ instance, onAssign, onClearAssignment, onOverride, onClearOverride }: {
  instance: ClockInstance;
  onAssign: (slot: RundownSlot) => void;
  onClearAssignment: (slot: RundownSlot) => void;
  onOverride: (slot: RundownSlot, secs: number) => void;
  onClearOverride: (slot: RundownSlot) => void;
}) {
  const [open, setOpen] = useState(true);
  const total = instance.slots.length;
  const assigned = instance.slots.filter((s) => s.is_assigned).length;

  return (
    <div className="border border-zinc-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 bg-zinc-900 hover:bg-zinc-800/60 transition-colors text-left"
      >
        <ReadinessDot slots={instance.slots} />
        <span className="font-medium text-sm text-white flex-1">{instance.clock_name}</span>
        <span className="text-xs text-zinc-500">{fmtTime12(instance.time_start)}</span>
        <span className={`text-xs tabular-nums ml-2 ${assigned === total ? 'text-emerald-400' : assigned === 0 ? 'text-zinc-500' : 'text-amber-400'}`}>
          {assigned}/{total}
        </span>
        <ChevronLeft className={`w-4 h-4 text-zinc-500 transition-transform ${open ? 'rotate-90' : '-rotate-90'}`} />
      </button>
      {open && (
        <div className="bg-zinc-950 divide-y divide-zinc-800/50">
          {instance.slots.map((slot) => (
            <SlotRow
              key={slotKey(slot)}
              slot={slot}
              onAssign={onAssign}
              onClearAssignment={onClearAssignment}
              onOverride={onOverride}
              onClearOverride={onClearOverride}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Media picker modal ────────────────────────────────────────────────────────

function MediaPickerModal({ slot, onSelect, onClose }: {
  slot: RundownSlot;
  onSelect: (media: Media) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const { data } = useQuery({
    queryKey: ['rundown-media-search', q],
    queryFn: () => fetchLibrary({ q: q || undefined, limit: 30, sort: 'title', order: 'asc' }),
    staleTime: 10_000,
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl w-full max-w-lg flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-zinc-800">
          <SegTypeIcon type={slot.segment_type} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white">{slot.segment_name}</p>
            <p className="text-xs text-zinc-400">{slot.clock_name} · {fmtTime12(slot.time_start)} · {slot.date}</p>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-2 bg-zinc-800 rounded-lg px-3 py-2">
            <Search className="w-4 h-4 text-zinc-400 flex-shrink-0" />
            <input
              ref={inputRef}
              autoFocus
              type="text"
              placeholder="Search media…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="flex-1 bg-transparent text-sm text-white placeholder-zinc-500 outline-none"
            />
            {q && (
              <button onClick={() => setQ('')} className="text-zinc-500 hover:text-zinc-300">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto py-1">
          {!data?.items.length && (
            <p className="text-sm text-zinc-500 text-center py-8">No results</p>
          )}
          {data?.items.map((item) => (
            <button
              key={item.id}
              onClick={() => onSelect(item)}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-zinc-800 transition-colors text-left"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white truncate">{item.title ?? item.original_filename}</p>
                {item.artist && <p className="text-xs text-zinc-400 truncate">{item.artist}</p>}
              </div>
              {item.duration_seconds != null && (
                <span className="text-xs text-zinc-500 tabular-nums flex-shrink-0">
                  {formatDuration(item.duration_seconds)}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Day column ────────────────────────────────────────────────────────────────

function DayColumn({ date, slots, isToday, onAssign, onClearAssignment, onOverride, onClearOverride }: {
  date: string;
  slots: RundownSlot[];
  isToday: boolean;
  onAssign: (slot: RundownSlot) => void;
  onClearAssignment: (slot: RundownSlot) => void;
  onOverride: (slot: RundownSlot, secs: number) => void;
  onClearOverride: (slot: RundownSlot) => void;
}) {
  const instances = groupIntoInstances(slots);
  const totalSlots = slots.length;
  const assignedSlots = slots.filter((s) => s.is_assigned).length;

  return (
    <div className="flex-1 min-w-0 flex flex-col gap-3">
      {/* Day header */}
      <div className={`text-center pb-2 border-b ${isToday ? 'border-indigo-500' : 'border-zinc-800'}`}>
        <p className={`text-sm font-semibold ${isToday ? 'text-indigo-400' : 'text-zinc-300'}`}>{displayDate(date)}</p>
        {totalSlots > 0 && (
          <p className={`text-xs mt-0.5 ${assignedSlots === totalSlots ? 'text-emerald-400' : assignedSlots === 0 ? 'text-zinc-500' : 'text-amber-400'}`}>
            {assignedSlots}/{totalSlots} assigned
          </p>
        )}
        {totalSlots === 0 && <p className="text-xs mt-0.5 text-zinc-600">No content slots</p>}
      </div>

      {instances.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-8 text-zinc-600">
          <CircleOff className="w-6 h-6" />
          <span className="text-xs">No rundown slots</span>
        </div>
      )}

      <div className="space-y-2">
        {instances.map((inst) => (
          <ClockCard
            key={`${inst.time_start}|${inst.clock_id}`}
            instance={inst}
            onAssign={onAssign}
            onClearAssignment={onClearAssignment}
            onOverride={onOverride}
            onClearOverride={onClearOverride}
          />
        ))}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const DAYS_VISIBLE = 3;

export function RundownPage() {
  const today = formatDate(new Date());
  const [windowStart, setWindowStart] = useState(today);
  const [pickerSlot, setPickerSlot] = useState<RundownSlot | null>(null);

  const queryClient = useQueryClient();

  const dateFrom = windowStart;
  const dateTo = formatDate(addDays(parseDateLocal(windowStart), DAYS_VISIBLE - 1));

  const { data: slots = [], isLoading, isError } = useQuery({
    queryKey: ['rundown', dateFrom, dateTo],
    queryFn: () => fetchRundown(dateFrom, dateTo),
    staleTime: 30_000,
  });

  const invalidateRundown = () => queryClient.invalidateQueries({ queryKey: ['rundown'] });

  const assignMutation = useMutation({
    mutationFn: (data: RundownAssignmentUpsert) => upsertRundownAssignment(data),
    onSuccess: invalidateRundown,
  });

  const clearAssignmentMutation = useMutation({
    mutationFn: (id: number) => deleteRundownAssignment(id),
    onSuccess: invalidateRundown,
  });

  const overrideMutation = useMutation({
    mutationFn: (data: { slot: RundownSlot; secs: number }) =>
      upsertRundownDurationOverride({
        date: data.slot.date,
        time_start: data.slot.time_start,
        clock_id: data.slot.clock_id,
        segment_index: data.slot.segment_index,
        duration_seconds: data.secs,
      }),
    onSuccess: invalidateRundown,
  });

  const clearOverrideMutation = useMutation({
    mutationFn: (id: number) => deleteRundownDurationOverride(id),
    onSuccess: invalidateRundown,
  });

  const handleAssign = (slot: RundownSlot) => setPickerSlot(slot);

  const handleSelectMedia = (media: Media) => {
    if (!pickerSlot) return;
    assignMutation.mutate({
      date: pickerSlot.date,
      time_start: pickerSlot.time_start,
      clock_id: pickerSlot.clock_id,
      segment_index: pickerSlot.segment_index,
      media_id: media.id,
    });
    setPickerSlot(null);
  };

  const handleClearAssignment = (slot: RundownSlot) => {
    if (slot.assignment?.id) {
      clearAssignmentMutation.mutate(slot.assignment.id);
    }
  };

  const handleOverride = (slot: RundownSlot, secs: number) => {
    overrideMutation.mutate({ slot, secs });
  };

  const handleClearOverride = (slot: RundownSlot) => {
    if (slot.duration_override_id) {
      clearOverrideMutation.mutate(slot.duration_override_id);
    }
  };

  // Build date columns
  const dates: string[] = [];
  for (let i = 0; i < DAYS_VISIBLE; i++) {
    dates.push(formatDate(addDays(parseDateLocal(windowStart), i)));
  }

  // Group slots by date
  const slotsByDate = new Map<string, RundownSlot[]>();
  for (const slot of slots) {
    if (!slotsByDate.has(slot.date)) slotsByDate.set(slot.date, []);
    slotsByDate.get(slot.date)!.push(slot);
  }

  return (
    <div className="space-y-5">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">Rundown</h1>
          <p className="text-sm text-zinc-400 mt-0.5">Assign content to news, bulletin, and voice track segments</p>
        </div>

        {/* Date navigation */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setWindowStart(formatDate(addDays(parseDateLocal(windowStart), -DAYS_VISIBLE)))}
            className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => setWindowStart(today)}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            Today
          </button>
          <button
            onClick={() => setWindowStart(formatDate(addDays(parseDateLocal(windowStart), DAYS_VISIBLE)))}
            className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-zinc-400 py-8 justify-center">
          <Clock className="w-4 h-4 animate-pulse" />
          <span className="text-sm">Loading rundown…</span>
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2 text-red-400 py-8 justify-center">
          <AlertTriangle className="w-4 h-4" />
          <span className="text-sm">Failed to load rundown</span>
        </div>
      )}

      {!isLoading && !isError && (
        <div className="flex gap-4 items-start">
          {dates.map((date) => (
            <DayColumn
              key={date}
              date={date}
              slots={slotsByDate.get(date) ?? []}
              isToday={date === today}
              onAssign={handleAssign}
              onClearAssignment={handleClearAssignment}
              onOverride={handleOverride}
              onClearOverride={handleClearOverride}
            />
          ))}
        </div>
      )}

      {pickerSlot && (
        <MediaPickerModal
          slot={pickerSlot}
          onSelect={handleSelectMedia}
          onClose={() => setPickerSlot(null)}
        />
      )}
    </div>
  );
}
