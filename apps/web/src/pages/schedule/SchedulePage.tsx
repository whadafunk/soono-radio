import { useState, useEffect, useMemo, Fragment, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, X, Trash2, RotateCcw, Clock, Pencil, Mic, AlertTriangle } from 'lucide-react';
import { Show, ShowColor, TemplateEntry, CalendarEntry, Clock as ClockType, BroadcastInterval, BroadcastIntervalPatch, BroadcastIntervalSlot, BroadcastIntervalSlotPatch } from '@radio/shared';
import {
  fetchShows, fetchTemplateEntries,
  createTemplateEntry, updateTemplateEntry, deleteTemplateEntry,
  fetchCalendarEntries, createCalendarEntry, updateCalendarEntry, deleteCalendarEntry,
  fetchClocks,
  fetchIntervals, createInterval, updateInterval, deleteInterval,
  fetchIntervalSlots, createIntervalSlot, updateIntervalSlot, deleteIntervalSlot,
} from '../../api';

// ─── Constants ────────────────────────────────────────────────────────────────

const HOUR_HEIGHT = 64;
const TOTAL_HEIGHT = HOUR_HEIGHT * 24;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const COLOR_HEX: Record<ShowColor, string> = {
  indigo:  '#818cf8',
  violet:  '#a78bfa',
  cyan:    '#22d3ee',
  emerald: '#34d399',
  amber:   '#fbbf24',
  rose:    '#fb7185',
  orange:  '#fb923c',
  teal:    '#2dd4bf',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  d.setHours(0, 0, 0, 0);
  return d;
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m ?? 0);
}

function padHour(h: number): string {
  return `${String(h % 24).padStart(2, '0')}:00`;
}

function minutesToTime(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function checkToday(day: Date): boolean {
  const now = new Date();
  return (
    day.getDate() === now.getDate() &&
    day.getMonth() === now.getMonth() &&
    day.getFullYear() === now.getFullYear()
  );
}

function formatWeekLabel(start: Date, end: Date): string {
  const s = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const e = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${s} – ${e}, ${start.getFullYear()}`;
}

function isTimeOccupied(startMin: number, entries: { time_start: string; time_end: string }[]): boolean {
  return entries.some((e) => {
    const s  = timeToMinutes(e.time_start);
    const en = timeToMinutes(e.time_end);
    return en > s ? startMin >= s && startMin < en : startMin >= s || startMin < en;
  });
}

function clickToStartMin(clientY: number, rectTop: number): number {
  const pixelOffset = clientY - rectTop;
  const rawMin = (pixelOffset / TOTAL_HEIGHT) * 24 * 60;
  return Math.floor(rawMin / 15) * 15;
}

function gapAfter(startMin: number, entries: { time_start: string; time_end: string }[]): number | null {
  let next = Infinity;
  for (const e of entries) {
    const s = timeToMinutes(e.time_start);
    if (s > startMin) next = Math.min(next, s);
  }
  return next === Infinity ? null : next - startMin;
}

// ─── Page state types ─────────────────────────────────────────────────────────

type Mode = 'template' | 'calendar' | 'intervals';

type NewSlotState     = { dayOfWeek: number; timeStart: string; timeEnd: string; maxDurationMinutes: number | null; x: number; y: number };
type EditSlotState    = { entry: TemplateEntry; show: Show | undefined; clock: ClockType | undefined; x: number; y: number };
type CalNewSlotState  = { date: string; timeStart: string; timeEnd: string; templateEntry?: TemplateEntry; maxDurationMinutes: number | null; x: number; y: number };
type CalEditSlotState = { entry: CalendarEntry; show: Show | undefined; clock: ClockType | undefined; x: number; y: number };

type DragOp = 'move' | 'resize-start' | 'resize-end';
// entryKind:
//   'template'             → dragging a template entry (template mode)
//   'calendar'             → dragging an existing calendar entry
//   'template-in-calendar' → dragging a template slot in calendar mode → creates override on drop
type DragEntryKind = 'template' | 'calendar' | 'template-in-calendar';
type DragSibling = { startMin: number; endMin: number };
type DragState = {
  op: DragOp;
  entryKind: DragEntryKind;
  entry: TemplateEntry | CalendarEntry;
  dayOfWeek?: number;         // source day (template)
  date?: string;              // source date (calendar)
  targetDayOfWeek?: number;   // current target day (updated during drag)
  targetDate?: string;        // current target date (updated during drag)
  startMin: number;
  endMin: number;
  origStartMin: number;
  origEndMin: number;
  offsetMin: number;
  columnRect: DOMRect;
  siblings: DragSibling[];    // current target column's other entries
  isCopy: boolean;
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export function SchedulePage() {
  const qc = useQueryClient();
  const [baseDate,     setBaseDate]     = useState(new Date());
  const [mode,         setMode]         = useState<Mode>('template');

  const [newSlot,     setNewSlot]     = useState<NewSlotState     | null>(null);
  const [editSlot,    setEditSlot]    = useState<EditSlotState    | null>(null);
  const [calNewSlot,  setCalNewSlot]  = useState<CalNewSlotState  | null>(null);
  const [calEditSlot, setCalEditSlot] = useState<CalEditSlotState | null>(null);

  const { data: templateEntries = [] } = useQuery({ queryKey: ['template-entries'], queryFn: fetchTemplateEntries });
  const { data: shows = [] }           = useQuery({ queryKey: ['shows'],            queryFn: fetchShows });
  const { data: clocks = [] }          = useQuery({ queryKey: ['clocks'],           queryFn: fetchClocks });

  const activeShows = shows;
  const showMap     = useMemo(() => new Map(shows.map((s) => [s.id, s])), [shows]);
  const clockMap    = useMemo(() => new Map(clocks.map((c) => [c.id, c])), [clocks]);

  const weekStart    = getWeekStart(baseDate);
  const weekStartISO = toISODate(weekStart);
  const weekDays     = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return d;
  });

  const { data: calendarEntries = [] } = useQuery({
    queryKey: ['calendar-entries', weekStartISO],
    queryFn:  () => fetchCalendarEntries(weekStartISO),
    enabled:  mode === 'calendar',
  });

  const calEntryByDate = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>();
    for (const entry of calendarEntries) {
      const list = map.get(entry.date) ?? [];
      map.set(entry.date, [...list, entry]);
    }
    return map;
  }, [calendarEntries]);

  // Template mutations
  const invalidateTemplate = () => qc.invalidateQueries({ queryKey: ['template-entries'] });
  const createMutation = useMutation({ mutationFn: createTemplateEntry, onSuccess: invalidateTemplate });
  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Parameters<typeof updateTemplateEntry>[1] }) =>
      updateTemplateEntry(id, patch),
    onSuccess: invalidateTemplate,
  });
  const deleteMutation = useMutation({ mutationFn: deleteTemplateEntry, onSuccess: invalidateTemplate });

  // Calendar mutations
  const invalidateCal = () => qc.invalidateQueries({ queryKey: ['calendar-entries'] });
  const calCreateMutation = useMutation({ mutationFn: createCalendarEntry, onSuccess: invalidateCal });
  const calUpdateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Parameters<typeof updateCalendarEntry>[1] }) =>
      updateCalendarEntry(id, patch),
    onSuccess: invalidateCal,
  });
  const calDeleteMutation = useMutation({ mutationFn: deleteCalendarEntry, onSuccess: invalidateCal });

  // ── Drag state ──
  const [activeDrag, setActiveDrag] = useState<DragState | null>(null);

  function startDrag(initial: DragState) {
    setActiveDrag(initial);
    document.body.style.cursor = initial.isCopy ? 'copy' : initial.op === 'move' ? 'grabbing' : 'ns-resize';
    document.body.style.userSelect = 'none';

    let current = initial;

    const SNAP_THRESHOLD = 7.5;

    // Compute source day (1-7) — used to map cursor X to target column
    const startDayOfWeek = initial.dayOfWeek
      ?? (initial.date ? weekDays.findIndex((d) => toISODate(d) === initial.date) + 1 : 1);

    const toSibling = (e: { time_start: string; time_end: string }): DragSibling => {
      const s  = timeToMinutes(e.time_start);
      const en = timeToMinutes(e.time_end);
      return { startMin: s, endMin: en > s ? en : 24 * 60 };
    };

    const computeSiblings = (targetDay: number): DragSibling[] => {
      const excludeId = initial.entry.id;
      if (mode === 'template') {
        return templateEntries
          .filter((e) => e.day_of_week === targetDay && e.id !== excludeId)
          .map(toSibling);
      }
      const tDate = toISODate(weekDays[targetDay - 1]);
      const calE  = calEntryByDate.get(tDate) ?? [];
      const overridden = new Set(calE.filter((e) => e.is_override).map((e) => e.time_start));
      const visT = templateEntries.filter((e) => e.day_of_week === targetDay && !overridden.has(e.time_start));
      return [...calE, ...visT].filter((e) => e.id !== excludeId).map(toSibling);
    };

    const snapMin = (raw: number): number => {
      for (const sib of current.siblings) {
        if (Math.abs(raw - sib.startMin) <= SNAP_THRESHOLD) return sib.startMin;
        if (Math.abs(raw - sib.endMin)   <= SNAP_THRESHOLD) return sib.endMin;
      }
      return Math.round(raw / 15) * 15;
    };

    const onMove = (e: MouseEvent) => {
      e.preventDefault();
      const raw     = (e.clientY - current.columnRect.top) / TOTAL_HEIGHT * 24 * 60;
      const clamped = Math.max(0, Math.min(24 * 60 - 1, raw));
      let { startMin, endMin } = current;

      if (current.op === 'move') {
        const rawStart = clamped - current.offsetMin;
        const dur = current.origEndMin - current.origStartMin;
        startMin = Math.max(0, Math.min(24 * 60 - dur, snapMin(rawStart)));
        endMin   = startMin + dur;
      } else if (current.op === 'resize-start') {
        startMin = Math.max(0, Math.min(current.endMin - 15, snapMin(clamped)));
      } else {
        endMin = Math.max(current.startMin + 15, Math.min(24 * 60 - 1, snapMin(clamped)));
      }

      // Cross-day: only for move op
      let targetDayOfWeek = startDayOfWeek;
      if (current.op === 'move') {
        const deltaCol = Math.floor((e.clientX - initial.columnRect.left) / initial.columnRect.width);
        targetDayOfWeek = Math.min(7, Math.max(1, startDayOfWeek + deltaCol));
      }
      const targetDate = mode === 'calendar' ? toISODate(weekDays[targetDayOfWeek - 1]) : undefined;

      // Recompute siblings when target column changes
      const siblings = targetDayOfWeek !== (current.targetDayOfWeek ?? startDayOfWeek)
        ? computeSiblings(targetDayOfWeek)
        : current.siblings;

      current = { ...current, startMin, endMin, targetDayOfWeek, targetDate, siblings };
      setActiveDrag({ ...current });
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      const drag = current;
      setActiveDrag(null);

      const tDay = drag.targetDayOfWeek ?? startDayOfWeek;
      const tDate = drag.targetDate ?? drag.date;
      const dayChanged  = tDay !== startDayOfWeek || tDate !== drag.date;
      const posChanged  = drag.startMin !== drag.origStartMin || drag.endMin !== drag.origEndMin;
      const noChange    = !dayChanged && !posChanged;
      const overlaps    = drag.siblings.some((s) => drag.startMin < s.endMin && drag.endMin > s.startMin);
      if (noChange || overlaps) return;

      const newStart = minutesToTime(drag.startMin);
      const newEnd   = minutesToTime(drag.endMin % 1440);

      if (drag.isCopy) {
        if (drag.entryKind === 'template') {
          const e = drag.entry as TemplateEntry;
          createMutation.mutate({ day_of_week: tDay, time_start: newStart, time_end: newEnd, show_id: e.show_id ?? null, clock_id: e.clock_id ?? null });
        } else {
          const e = drag.entry as TemplateEntry | CalendarEntry;
          calCreateMutation.mutate({ date: tDate!, time_start: newStart, time_end: newEnd, show_id: e.show_id ?? null, clock_id: e.clock_id ?? null, is_override: true });
        }
      } else if (drag.entryKind === 'template') {
        const e = drag.entry as TemplateEntry;
        updateMutation.mutate({ id: e.id, patch: { time_start: newStart, time_end: newEnd, day_of_week: tDay } });
      } else if (drag.entryKind === 'calendar') {
        const e = drag.entry as CalendarEntry;
        calUpdateMutation.mutate({ id: e.id, patch: { time_start: newStart, time_end: newEnd, date: tDate } });
      } else {
        const e = drag.entry as TemplateEntry;
        calCreateMutation.mutate({ date: tDate!, time_start: newStart, time_end: newEnd, show_id: e.show_id ?? null, clock_id: e.clock_id ?? null, is_override: true });
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  const now           = new Date();
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  const currentTop    = (currentMinute / (24 * 60)) * TOTAL_HEIGHT;

  useEffect(() => {
    const main = document.querySelector('main');
    if (main) main.scrollTop = Math.max(0, currentTop - HOUR_HEIGHT * 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismiss = () => {
    setNewSlot(null);
    setEditSlot(null);
    setCalNewSlot(null);
    setCalEditSlot(null);
  };

  const goBack    = () => { const d = new Date(baseDate); d.setDate(d.getDate() - 7); setBaseDate(d); };
  const goForward = () => { const d = new Date(baseDate); d.setDate(d.getDate() + 7); setBaseDate(d); };

  return (
    <div className="flex flex-col gap-4 pb-10" onClick={dismiss}>

      {/* ── Header ── */}
      <div className="flex items-center gap-4 flex-shrink-0">

        {/* Mode toggle */}
        <div className="flex rounded-lg overflow-hidden border border-zinc-700">
          {(['template', 'calendar', 'intervals'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={(e) => { e.stopPropagation(); setMode(m); dismiss(); }}
              className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                mode === m ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-200 bg-zinc-900'
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        {/* Week navigation — calendar mode only */}
        {mode === 'calendar' && (
          <>
            <div className="flex items-center gap-1">
              <button
                onClick={(e) => { e.stopPropagation(); goBack(); }}
                className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-sm font-medium text-zinc-300 w-52 text-center select-none tabular-nums">
                {formatWeekLabel(weekDays[0], weekDays[6])}
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); goForward(); }}
                className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); setBaseDate(new Date()); }}
              className="px-3 py-1 text-xs font-medium text-zinc-400 hover:text-zinc-100 border border-zinc-700 hover:border-zinc-500 rounded-md transition-colors"
            >
              Today
            </button>
          </>
        )}
      </div>

      {/* ── Intervals tab ── */}
      {mode === 'intervals' && <IntervalsTab />}

      {/* ── Grid wrapper ── */}
      {/* No overflow-hidden here — it would break sticky positioning on the header */}
      {mode !== 'intervals' && <div className={`rounded-xl border-4 flex flex-col ${
        mode === 'template' ? 'border-indigo-500/50' : 'border-cyan-500/40'
      }`}>

        {/* Day headers — sticky so they stay visible when scrolling through 24h */}
        <div className={`sticky top-0 z-10 flex-shrink-0 flex border-b rounded-tl-[10px] rounded-tr-[10px] ${
          mode === 'template' ? 'bg-zinc-800 border-zinc-700' : 'bg-zinc-900 border-zinc-800'
        }`}>
          <div className="w-3 flex-shrink-0 bg-zinc-900/70" />
          <div className="w-14 flex-shrink-0 bg-zinc-900/70 border-r border-zinc-700 flex items-center justify-center">
            <Clock className="w-3.5 h-3.5 text-zinc-600" />
          </div>
          {weekDays.map((day, i) => {
            const today  = checkToday(day);
            const isLast = i === 6;
            return (
              <div
                key={i}
                className={`flex-1 py-4 text-center ${
                  !isLast
                    ? mode === 'template'
                      ? 'border-r border-zinc-500/80 [box-shadow:inset_-1px_0_0_rgba(0,0,0,0.55)]'
                      : 'border-r border-zinc-600/60 [box-shadow:inset_-1px_0_0_rgba(0,0,0,0.4)]'
                    : ''
                } ${mode === 'calendar' && today ? 'bg-zinc-800/50' : ''}`}
              >
                {mode === 'template' ? (
                  <div className="text-[15px] font-semibold text-zinc-100">{DAY_NAMES[i]}</div>
                ) : (
                  <div className="flex items-baseline justify-center gap-1.5">
                    <span className="text-[15px] font-semibold text-zinc-400">{DAY_NAMES[i]}</span>
                    <span className={`text-[15px] font-semibold ${today ? 'text-indigo-400' : 'text-zinc-100'}`}>{day.getDate()}</span>
                  </div>
                )}
              </div>
            );
          })}
          <div className="w-3 flex-shrink-0" />
        </div>

        {/* Body */}
        <div className="bg-zinc-950 overflow-hidden">
          <div className="flex pt-2" style={{ height: TOTAL_HEIGHT + 8 }}>
            <div className="w-3 flex-shrink-0 bg-zinc-900/70" />
            {/* Time labels */}
            <div className="w-14 flex-shrink-0 relative border-r border-zinc-700 bg-zinc-900/70">
              {HOURS.map((h) => (
                <div key={h} className="absolute right-0 left-0 flex justify-end pr-2.5" style={{ top: h * HOUR_HEIGHT }}>
                  {h > 0 && (
                    <span className="text-sm text-zinc-400 font-mono -translate-y-[10px] select-none">
                      {String(h).padStart(2, '0')}:00
                    </span>
                  )}
                </div>
              ))}
            </div>

            {/* Day columns */}
            <div className="flex-1 grid grid-cols-7 divide-x divide-zinc-700/50">
              {weekDays.map((day, i) => {
                const dayOfWeek = i + 1;
                const dateISO   = toISODate(day);

                if (mode === 'template') {
                  return (
                    <DayColumn
                      key={i}
                      entries={templateEntries.filter((e) => e.day_of_week === dayOfWeek)}
                      showMap={showMap}
                      clockMap={clockMap}
                      isToday={checkToday(day)}
                      currentTop={currentTop}
                      dayOfWeek={dayOfWeek}
                      activeDrag={activeDrag?.entryKind === 'template' ? activeDrag : null}
                      onDragStart={startDrag}
                      onEmptyClick={(timeStart, timeEnd, maxDurationMinutes, x, y) => {
                        dismiss();
                        setNewSlot({ dayOfWeek, timeStart, timeEnd, maxDurationMinutes, x, y });
                      }}
                      onEntryClick={(entry, x, y) => {
                        dismiss();
                        setEditSlot({
                          entry,
                          show:  entry.show_id  ? showMap.get(entry.show_id)   : undefined,
                          clock: entry.clock_id ? clockMap.get(entry.clock_id) : undefined,
                          x, y,
                        });
                      }}
                    />
                  );
                }

                return (
                  <CalendarDayColumn
                    key={i}
                    date={dateISO}
                    templateEntries={templateEntries.filter((e) => e.day_of_week === dayOfWeek)}
                    calendarEntries={calEntryByDate.get(dateISO) ?? []}
                    showMap={showMap}
                    clockMap={clockMap}
                    isToday={checkToday(day)}
                    currentTop={currentTop}
                    activeDrag={
                      activeDrag?.entryKind === 'calendar' || activeDrag?.entryKind === 'template-in-calendar'
                        ? activeDrag : null
                    }
                    onDragStart={startDrag}
                    onEmptyClick={(date, timeStart, timeEnd, maxDurationMinutes, x, y) => {
                      dismiss();
                      setCalNewSlot({ date, timeStart, timeEnd, maxDurationMinutes, x, y });
                    }}
                    onTemplateClick={(entry, date, x, y) => {
                      dismiss();
                      const s = timeToMinutes(entry.time_start);
                      const en = timeToMinutes(entry.time_end);
                      const entryDuration = en > s ? en - s : 1440 - s + en;
                      setCalNewSlot({ date, timeStart: entry.time_start, timeEnd: entry.time_end, templateEntry: entry, maxDurationMinutes: entryDuration, x, y });
                    }}
                    onCalendarClick={(entry, x, y) => {
                      dismiss();
                      setCalEditSlot({
                        entry,
                        show:  entry.show_id  ? showMap.get(entry.show_id)   : undefined,
                        clock: entry.clock_id ? clockMap.get(entry.clock_id) : undefined,
                        x, y,
                      });
                    }}
                  />
                );
              })}
            </div>
            <div className="w-3 flex-shrink-0" />
          </div>
        </div>
      </div>}

      {/* ── Template mode popovers ── */}
      {newSlot && (
        <NewSlotPopover
          dayOfWeek={newSlot.dayOfWeek}
          timeStart={newSlot.timeStart}
          timeEnd={newSlot.timeEnd}
          maxDurationMinutes={newSlot.maxDurationMinutes}
          shows={activeShows}
          clocks={clocks}
          x={newSlot.x}
          y={newSlot.y}
          onClose={dismiss}
          onSave={(showId, clockId, timeStart, timeEnd) => {
            createMutation.mutate({
              day_of_week: newSlot.dayOfWeek,
              time_start: timeStart,
              time_end: timeEnd,
              show_id: showId,
              clock_id: clockId,
            });
            dismiss();
          }}
        />
      )}
      {editSlot && (
        <EditSlotPopover
          entry={editSlot.entry}
          show={editSlot.show}
          clock={editSlot.clock}
          shows={activeShows}
          clocks={clocks}
          x={editSlot.x}
          y={editSlot.y}
          onClose={dismiss}
          onRemove={() => { deleteMutation.mutate(editSlot.entry.id); dismiss(); }}
          onChange={(showId, clockId) => {
            updateMutation.mutate({ id: editSlot.entry.id, patch: { show_id: showId, clock_id: clockId } });
            dismiss();
          }}
        />
      )}

      {/* ── Calendar mode popovers ── */}
      {calNewSlot && (
        <CalNewSlotPopover
          date={calNewSlot.date}
          timeStart={calNewSlot.timeStart}
          timeEnd={calNewSlot.timeEnd}
          templateEntry={calNewSlot.templateEntry}
          maxDurationMinutes={calNewSlot.maxDurationMinutes}
          shows={activeShows}
          clocks={clocks}
          x={calNewSlot.x}
          y={calNewSlot.y}
          onClose={dismiss}
          onSave={(date, showId, clockId, timeStart, timeEnd, isOverride) => {
            calCreateMutation.mutate({
              date,
              time_start: timeStart,
              time_end: timeEnd,
              show_id: showId,
              clock_id: clockId,
              is_override: isOverride,
            });
            dismiss();
          }}
        />
      )}
      {calEditSlot && (
        <CalEditSlotPopover
          entry={calEditSlot.entry}
          show={calEditSlot.show}
          clock={calEditSlot.clock}
          shows={activeShows}
          clocks={clocks}
          x={calEditSlot.x}
          y={calEditSlot.y}
          onClose={dismiss}
          onRemove={() => { calDeleteMutation.mutate(calEditSlot.entry.id); dismiss(); }}
          onRestore={calEditSlot.entry.is_override
            ? () => { calDeleteMutation.mutate(calEditSlot.entry.id); dismiss(); }
            : undefined}
          onChange={(showId, clockId) => {
            calUpdateMutation.mutate({ id: calEditSlot.entry.id, patch: { show_id: showId, clock_id: clockId } });
            dismiss();
          }}
        />
      )}
    </div>
  );
}

// ─── Template Day Column ──────────────────────────────────────────────────────

function DayColumn({
  entries, showMap, clockMap, isToday, currentTop, dayOfWeek, activeDrag, onDragStart, onEmptyClick, onEntryClick,
}: {
  entries: TemplateEntry[];
  showMap: Map<number, Show>;
  clockMap: Map<number, ClockType>;
  isToday: boolean;
  currentTop: number;
  dayOfWeek: number;
  activeDrag: DragState | null;
  onDragStart: (state: DragState) => void;
  onEmptyClick: (timeStart: string, timeEnd: string, maxDurationMinutes: number | null, x: number, y: number) => void;
  onEntryClick: (entry: TemplateEntry, x: number, y: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  function handleBlockDragStart(entry: TemplateEntry, op: DragOp, mouseY: number, isCopy: boolean) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const startMin  = timeToMinutes(entry.time_start);
    const rawEnd    = timeToMinutes(entry.time_end);
    const endMin    = rawEnd > startMin ? rawEnd : 24 * 60;
    const cursorMin = ((mouseY - rect.top) / TOTAL_HEIGHT) * 24 * 60;
    const offsetMin = op === 'move' ? Math.max(0, cursorMin - startMin) : 0;
    const siblings  = entries
      .filter((e) => e.id !== entry.id)
      .map((e) => {
        const s  = timeToMinutes(e.time_start);
        const en = timeToMinutes(e.time_end);
        return { startMin: s, endMin: en > s ? en : 24 * 60 };
      });
    onDragStart({ op, entryKind: 'template', entry, dayOfWeek, targetDayOfWeek: dayOfWeek, startMin, endMin, origStartMin: startMin, origEndMin: endMin, offsetMin, columnRect: rect, siblings, isCopy });
  }

  const draggingId = activeDrag?.entryKind === 'template' && entries.some((e) => e.id === activeDrag.entry.id)
    ? activeDrag.entry.id
    : null;

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const startMin = clickToStartMin(e.clientY, rect.top);
    if (isTimeOccupied(startMin, entries)) return;
    onEmptyClick(minutesToTime(startMin), minutesToTime((startMin + 60) % 1440), gapAfter(startMin, entries), e.clientX, e.clientY);
  }

  return (
    <div
      ref={containerRef}
      className={`relative cursor-cell ${isToday ? 'bg-indigo-950/10' : ''}`}
      style={{ height: TOTAL_HEIGHT }}
      onClick={handleClick}
    >
      {HOURS.map((h) => (
        <div key={h} className="absolute left-0 right-0 border-t border-zinc-700/60" style={{ top: h * HOUR_HEIGHT }} />
      ))}
      {HOURS.map((h) => (
        <div key={`hh${h}`} className="absolute left-0 right-0 border-t border-zinc-700/30" style={{ top: h * HOUR_HEIGHT + HOUR_HEIGHT / 2 }} />
      ))}
      {HOURS.map((h) => (
        <Fragment key={`q${h}`}>
          <div className="absolute left-0 right-0 border-t border-zinc-700/15" style={{ top: h * HOUR_HEIGHT + HOUR_HEIGHT / 4 }} />
          <div className="absolute left-0 right-0 border-t border-zinc-700/15" style={{ top: h * HOUR_HEIGHT + (HOUR_HEIGHT * 3) / 4 }} />
        </Fragment>
      ))}
      {entries.flatMap((entry) => {
        const show  = entry.show_id  ? showMap.get(entry.show_id)   : undefined;
        const clock = entry.clock_id ? clockMap.get(entry.clock_id) : undefined;
        const isDragging     = entry.id === draggingId && !activeDrag?.isCopy;
        const blockDragStart = (op: DragOp, mouseY: number, isCopy: boolean) => handleBlockDragStart(entry, op, mouseY, isCopy);
        const ovn  = isOvernightEntry(entry.time_start, entry.time_end) && timeToMinutes(entry.time_end) > 0;
        const wrap = ovn ? { ...entry, time_start: '00:00' } : null;
        if (!entry.show_id && entry.clock_id) {
          return [
            <ClockOnlyBlock key={entry.id}          entry={entry} clock={clock} isDragging={isDragging} onDragStart={blockDragStart} onClick={(x, y) => onEntryClick(entry, x, y)} />,
            wrap && <ClockOnlyBlock key={`w${entry.id}`} entry={wrap}  clock={clock} isDragging={isDragging} onDragStart={() => {}} onClick={(x, y) => onEntryClick(entry, x, y)} />,
          ].filter(Boolean) as React.ReactElement[];
        }
        return [
          <EntryBlock key={entry.id}          entry={entry} show={show} isDragging={isDragging} onDragStart={blockDragStart} onClick={(x, y) => onEntryClick(entry, x, y)} />,
          wrap && <EntryBlock key={`w${entry.id}`} entry={wrap}  show={show} isDragging={isDragging} onDragStart={() => {}} onClick={(x, y) => onEntryClick(entry, x, y)} />,
        ].filter(Boolean) as React.ReactElement[];
      })}
      {activeDrag?.targetDayOfWeek === dayOfWeek && <DragGhost activeDrag={activeDrag} />}
      {isToday && (
        <div data-current-time="" className="absolute left-0 right-0 flex items-center z-10 pointer-events-none" style={{ top: currentTop }}>
          <div className="w-2 h-2 rounded-full bg-rose-400 flex-shrink-0 -ml-1" style={{ boxShadow: '0 0 6px rgba(251,113,133,0.6)' }} />
          <div className="flex-1 h-px bg-rose-400/50" />
        </div>
      )}
    </div>
  );
}

// ─── Calendar Day Column ──────────────────────────────────────────────────────

function CalendarDayColumn({
  date, templateEntries, calendarEntries, showMap, clockMap, isToday, currentTop,
  activeDrag, onDragStart, onEmptyClick, onTemplateClick, onCalendarClick,
}: {
  date: string;
  templateEntries: TemplateEntry[];
  calendarEntries: CalendarEntry[];
  showMap: Map<number, Show>;
  clockMap: Map<number, ClockType>;
  isToday: boolean;
  currentTop: number;
  activeDrag: DragState | null;
  onDragStart: (state: DragState) => void;
  onEmptyClick: (date: string, timeStart: string, timeEnd: string, maxDurationMinutes: number | null, x: number, y: number) => void;
  onTemplateClick: (entry: TemplateEntry, date: string, x: number, y: number) => void;
  onCalendarClick: (entry: CalendarEntry, x: number, y: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  const overriddenStarts = useMemo(
    () => new Set(calendarEntries.filter((e) => e.is_override).map((e) => e.time_start)),
    [calendarEntries],
  );

  const visibleTemplateEntries = useMemo(
    () => templateEntries.filter((e) => !overriddenStarts.has(e.time_start)),
    [templateEntries, overriddenStarts],
  );

  function handleBlockDragStart(
    entry: TemplateEntry | CalendarEntry,
    kind: DragEntryKind,
    op: DragOp,
    mouseY: number,
    isCopy: boolean,
  ) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const startMin  = timeToMinutes(entry.time_start);
    const rawEnd    = timeToMinutes(entry.time_end);
    const endMin    = rawEnd > startMin ? rawEnd : 24 * 60;
    const cursorMin = ((mouseY - rect.top) / TOTAL_HEIGHT) * 24 * 60;
    const offsetMin = op === 'move' ? Math.max(0, cursorMin - startMin) : 0;
    const allVisible = [...visibleTemplateEntries, ...calendarEntries];
    const siblings = allVisible
      .filter((e) => e.id !== entry.id)
      .map((e) => {
        const s  = timeToMinutes(e.time_start);
        const en = timeToMinutes(e.time_end);
        return { startMin: s, endMin: en > s ? en : 24 * 60 };
      });
    onDragStart({ op, entryKind: kind, entry, date, targetDate: date, startMin, endMin, origStartMin: startMin, origEndMin: endMin, offsetMin, columnRect: rect, siblings, isCopy });
  }

  const templateDraggingId = activeDrag?.entryKind === 'template-in-calendar' && visibleTemplateEntries.some((e) => e.id === activeDrag.entry.id)
    ? activeDrag.entry.id : null;
  const calDraggingId = activeDrag?.entryKind === 'calendar' && calendarEntries.some((e) => e.id === activeDrag.entry.id)
    ? activeDrag.entry.id : null;

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const startMin = clickToStartMin(e.clientY, rect.top);
    if (isTimeOccupied(startMin, calendarEntries)) return;
    if (isTimeOccupied(startMin, visibleTemplateEntries)) return;
    const allEntries = [...calendarEntries, ...visibleTemplateEntries];
    onEmptyClick(date, minutesToTime(startMin), minutesToTime((startMin + 60) % 1440), gapAfter(startMin, allEntries), e.clientX, e.clientY);
  }

  return (
    <div
      ref={containerRef}
      className={`relative cursor-cell ${isToday ? 'bg-indigo-950/10' : ''}`}
      style={{ height: TOTAL_HEIGHT }}
      onClick={handleClick}
    >
      {HOURS.map((h) => (
        <div key={h} className="absolute left-0 right-0 border-t border-zinc-700/60" style={{ top: h * HOUR_HEIGHT }} />
      ))}
      {HOURS.map((h) => (
        <div key={`hh${h}`} className="absolute left-0 right-0 border-t border-zinc-700/30" style={{ top: h * HOUR_HEIGHT + HOUR_HEIGHT / 2 }} />
      ))}
      {HOURS.map((h) => (
        <Fragment key={`q${h}`}>
          <div className="absolute left-0 right-0 border-t border-zinc-700/15" style={{ top: h * HOUR_HEIGHT + HOUR_HEIGHT / 4 }} />
          <div className="absolute left-0 right-0 border-t border-zinc-700/15" style={{ top: h * HOUR_HEIGHT + (HOUR_HEIGHT * 3) / 4 }} />
        </Fragment>
      ))}

      {/* Template base layer — full color, same as template mode */}
      {visibleTemplateEntries.flatMap((entry) => {
        const show  = entry.show_id  ? showMap.get(entry.show_id)   : undefined;
        const clock = entry.clock_id ? clockMap.get(entry.clock_id) : undefined;
        const isDragging     = entry.id === templateDraggingId && !activeDrag?.isCopy;
        const blockDragStart = (op: DragOp, mouseY: number, isCopy: boolean) => handleBlockDragStart(entry, 'template-in-calendar', op, mouseY, isCopy);
        const ovn  = isOvernightEntry(entry.time_start, entry.time_end) && timeToMinutes(entry.time_end) > 0;
        const wrap = ovn ? { ...entry, time_start: '00:00' } : null;
        if (!entry.show_id && entry.clock_id) {
          return [
            <ClockOnlyBlock key={`t${entry.id}`}    entry={entry} clock={clock} isDragging={isDragging} onDragStart={blockDragStart} onClick={(x, y) => onTemplateClick(entry, date, x, y)} />,
            wrap && <ClockOnlyBlock key={`tw${entry.id}`} entry={wrap}  clock={clock} isDragging={isDragging} onDragStart={() => {}} onClick={(x, y) => onTemplateClick(entry, date, x, y)} />,
          ].filter(Boolean) as React.ReactElement[];
        }
        return [
          <EntryBlock key={`t${entry.id}`}    entry={entry} show={show} isDragging={isDragging} onDragStart={blockDragStart} onClick={(x, y) => onTemplateClick(entry, date, x, y)} />,
          wrap && <EntryBlock key={`tw${entry.id}`} entry={wrap}  show={show} isDragging={isDragging} onDragStart={() => {}} onClick={(x, y) => onTemplateClick(entry, date, x, y)} />,
        ].filter(Boolean) as React.ReactElement[];
      })}

      {/* Calendar entries */}
      {calendarEntries.flatMap((entry) => {
        const show  = entry.show_id  ? showMap.get(entry.show_id)   : undefined;
        const clock = entry.clock_id ? clockMap.get(entry.clock_id) : undefined;
        const isDragging     = entry.id === calDraggingId && !activeDrag?.isCopy;
        const blockDragStart = (op: DragOp, mouseY: number, isCopy: boolean) => handleBlockDragStart(entry, 'calendar', op, mouseY, isCopy);
        const ovn  = isOvernightEntry(entry.time_start, entry.time_end) && timeToMinutes(entry.time_end) > 0;
        const wrap = ovn ? { ...entry, time_start: '00:00' } : null;
        if (!entry.show_id && entry.clock_id) {
          return [
            <CalendarClockOnlyBlock key={`c${entry.id}`}    entry={entry} clock={clock} isDragging={isDragging} onDragStart={blockDragStart} onClick={(x, y) => onCalendarClick(entry, x, y)} />,
            wrap && <CalendarClockOnlyBlock key={`cw${entry.id}`} entry={wrap}  clock={clock} isDragging={isDragging} onDragStart={() => {}} onClick={(x, y) => onCalendarClick(entry, x, y)} />,
          ].filter(Boolean) as React.ReactElement[];
        }
        return [
          <CalendarEntryBlock key={`c${entry.id}`}    entry={entry} show={show} isDragging={isDragging} onDragStart={blockDragStart} onClick={(x, y) => onCalendarClick(entry, x, y)} />,
          wrap && <CalendarEntryBlock key={`cw${entry.id}`} entry={wrap}  show={show} isDragging={isDragging} onDragStart={() => {}} onClick={(x, y) => onCalendarClick(entry, x, y)} />,
        ].filter(Boolean) as React.ReactElement[];
      })}

      {activeDrag?.targetDate === date && <DragGhost activeDrag={activeDrag} />}
      {isToday && (
        <div data-current-time="" className="absolute left-0 right-0 flex items-center z-10 pointer-events-none" style={{ top: currentTop }}>
          <div className="w-2 h-2 rounded-full bg-rose-400 flex-shrink-0 -ml-1" style={{ boxShadow: '0 0 6px rgba(251,113,133,0.6)' }} />
          <div className="flex-1 h-px bg-rose-400/50" />
        </div>
      )}
    </div>
  );
}

// ─── Shared geometry helper ───────────────────────────────────────────────────

function entryGeometry(timeStart: string, timeEnd: string) {
  const startMin = timeToMinutes(timeStart);
  const endMin   = timeToMinutes(timeEnd);
  const top      = (startMin / 60) * HOUR_HEIGHT;
  // Overnight primary block: only draw from start to midnight — the wrap block (00:00→end) handles the rest
  const durMin   = endMin > startMin ? endMin - startMin : 24 * 60 - startMin;
  const height   = Math.max((durMin / 60) * HOUR_HEIGHT - 2, 3);
  return { top, height };
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function addMinutes(timeStr: string, minutes: number): string {
  const total = (timeToMinutes(timeStr) + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function isOvernightEntry(timeStart: string, timeEnd: string): boolean {
  return timeToMinutes(timeEnd) <= timeToMinutes(timeStart);
}

// ─── Drag Ghost ───────────────────────────────────────────────────────────────

function DragGhost({ activeDrag }: { activeDrag: DragState }) {
  const { startMin, endMin, siblings, isCopy } = activeDrag;
  const top    = (startMin / 60) * HOUR_HEIGHT + 1;
  const durMin = Math.max(endMin - startMin, 1);
  const height = Math.max((durMin / 60) * HOUR_HEIGHT - 2, 3);
  const overlaps = siblings.some((s) => startMin < s.endMin && endMin > s.startMin);

  const borderColor = overlaps ? 'rgba(248,113,113,0.8)' : isCopy ? 'rgba(74,222,128,0.6)' : 'rgba(255,255,255,0.4)';
  const bgColor     = overlaps ? 'rgba(248,113,113,0.1)' : isCopy ? 'rgba(74,222,128,0.08)' : 'rgba(255,255,255,0.05)';

  return (
    <div
      className="absolute right-1 rounded-r-[3px] pointer-events-none z-20"
      style={{ top, height, left: '3px', border: `2px dashed ${borderColor}`, backgroundColor: bgColor }}
    />
  );
}

// ─── Entry Block (show slot) ──────────────────────────────────────────────────

function EntryBlock({ entry, show, onClick, onDragStart, isDragging }: {
  entry: TemplateEntry;
  show: Show | undefined;
  onClick: (x: number, y: number) => void;
  onDragStart: (op: DragOp, mouseY: number, isCopy: boolean) => void;
  isDragging: boolean;
}) {
  const { top, height } = entryGeometry(entry.time_start, entry.time_end);
  const isOrphaned = !show && !!entry.show_id;
  const hex = show ? COLOR_HEX[show.color] : isOrphaned ? '#f59e0b' : '#71717a';

  function handleMouseDown(e: React.MouseEvent, op: DragOp) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const isCopy = e.ctrlKey || e.metaKey;
    let didDrag = false;
    const onMove = (ev: MouseEvent) => {
      if (!didDrag && (Math.abs(ev.clientX - startX) > 4 || Math.abs(ev.clientY - startY) > 4)) {
        didDrag = true;
        onDragStart(op, startY, isCopy);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
    };
    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (!didDrag) onClick(ev.clientX, ev.clientY);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  return (
    <div
      className="absolute right-1 rounded-r-[3px] overflow-hidden transition-all hover:brightness-110"
      style={{ top: top + 1, height, left: '3px', backgroundColor: `${hex}12`, borderLeft: `3px solid ${hex}`, opacity: isDragging ? 0.3 : undefined, cursor: isDragging ? 'grabbing' : 'grab' }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => handleMouseDown(e, 'move')}
      title={isOrphaned ? 'The show assigned to this slot was deleted' : undefined}
    >
      <div className="absolute top-0 left-0 right-0 h-2 z-10 cursor-ns-resize" onMouseDown={(e) => { e.stopPropagation(); handleMouseDown(e, 'resize-start'); }} />
      <div className="absolute bottom-0 left-0 right-0 h-2 z-10 cursor-ns-resize" onMouseDown={(e) => { e.stopPropagation(); handleMouseDown(e, 'resize-end'); }} />
      {height >= 22 && (
        <div className="px-2 pt-1.5 h-full flex flex-col overflow-hidden">
          <div className="flex items-center gap-1.5 min-w-0">
            {isOrphaned
              ? <AlertTriangle className="w-5 h-5 flex-shrink-0 text-amber-400" />
              : <Mic className="w-5 h-5 flex-shrink-0" style={{ color: hex }} />
            }
            <span className={`text-[13px] font-semibold leading-tight truncate ${isOrphaned ? 'text-amber-400' : 'text-zinc-300'}`}>
              {show?.name ?? (isOrphaned ? (entry.orphaned_show_name ?? 'Orphaned') : 'No show')}
            </span>
          </div>
          {height >= 60 && show?.host && (
            <span className="text-xs text-zinc-400 leading-tight truncate mt-0.5 pl-[26px]">{show.host}</span>
          )}
          {height >= 44 && (
            <span className="text-xs font-mono leading-none mt-auto pb-1.5 block pl-[26px]" style={{ color: `${hex}99` }}>
              {entry.time_start}–{entry.time_end}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Clock-Only Block (template mode) ────────────────────────────────────────

function ClockOnlyBlock({ entry, clock, onClick, onDragStart, isDragging }: {
  entry: TemplateEntry;
  clock: ClockType | undefined;
  onClick: (x: number, y: number) => void;
  onDragStart: (op: DragOp, mouseY: number, isCopy: boolean) => void;
  isDragging: boolean;
}) {
  const { top, height } = entryGeometry(entry.time_start, entry.time_end);
  const isOrphaned = !clock && !!entry.clock_id;
  const borderColor = isOrphaned ? '#f59e0b' : '#ffffff';
  const bgColor = isOrphaned ? '#f59e0b0a' : '#ffffff0a';

  function handleMouseDown(e: React.MouseEvent, op: DragOp) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const isCopy = e.ctrlKey || e.metaKey;
    let didDrag = false;
    const onMove = (ev: MouseEvent) => {
      if (!didDrag && (Math.abs(ev.clientX - startX) > 4 || Math.abs(ev.clientY - startY) > 4)) {
        didDrag = true;
        onDragStart(op, startY, isCopy);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
    };
    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (!didDrag) onClick(ev.clientX, ev.clientY);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  return (
    <div
      className="absolute right-1 rounded-r-[3px] overflow-hidden transition-all hover:brightness-110"
      style={{ top: top + 1, height, left: '3px', backgroundColor: bgColor, borderLeft: `3px solid ${borderColor}`, opacity: isDragging ? 0.3 : undefined, cursor: isDragging ? 'grabbing' : 'grab' }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => handleMouseDown(e, 'move')}
      title={isOrphaned ? 'The clock assigned to this slot was deleted' : undefined}
    >
      <div className="absolute top-0 left-0 right-0 h-2 z-10 cursor-ns-resize" onMouseDown={(e) => { e.stopPropagation(); handleMouseDown(e, 'resize-start'); }} />
      <div className="absolute bottom-0 left-0 right-0 h-2 z-10 cursor-ns-resize" onMouseDown={(e) => { e.stopPropagation(); handleMouseDown(e, 'resize-end'); }} />
      {height >= 22 && (
        <div className="px-2 pt-1.5 h-full flex flex-col overflow-hidden pb-[7px]">
          <div className="flex items-center gap-1.5 min-w-0">
            {isOrphaned
              ? <AlertTriangle className="w-5 h-5 flex-shrink-0 text-amber-400" />
              : <Clock className="w-5 h-5 text-white flex-shrink-0" />
            }
            <span className={`text-[13px] font-semibold leading-tight truncate ${isOrphaned ? 'text-amber-400' : clock ? 'text-zinc-300' : 'text-zinc-500 italic'}`}>
              {clock?.name ?? (isOrphaned ? (entry.orphaned_clock_name ?? 'Orphaned') : 'No clock')}
            </span>
          </div>
          {height >= 44 && (
            <span className="text-[11px] font-mono leading-none mt-auto pl-[26px]" style={{ color: `${borderColor}60` }}>
              {entry.time_start}–{entry.time_end}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Calendar Entry Block (show slot) ────────────────────────────────────────

function CalendarEntryBlock({ entry, show, onClick, onDragStart, isDragging }: {
  entry: CalendarEntry;
  show: Show | undefined;
  onClick: (x: number, y: number) => void;
  onDragStart: (op: DragOp, mouseY: number, isCopy: boolean) => void;
  isDragging: boolean;
}) {
  const { top, height } = entryGeometry(entry.time_start, entry.time_end);
  const isOrphaned = !show && !!entry.show_id;
  const hex = show ? COLOR_HEX[show.color] : isOrphaned ? '#f59e0b' : '#71717a';

  function handleMouseDown(e: React.MouseEvent, op: DragOp) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const isCopy = e.ctrlKey || e.metaKey;
    let didDrag = false;
    const onMove = (ev: MouseEvent) => {
      if (!didDrag && (Math.abs(ev.clientX - startX) > 4 || Math.abs(ev.clientY - startY) > 4)) {
        didDrag = true;
        onDragStart(op, startY, isCopy);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
    };
    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (!didDrag) onClick(ev.clientX, ev.clientY);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  return (
    <div
      className="absolute right-1 rounded-r-[3px] overflow-hidden transition-all hover:brightness-110 z-[1]"
      style={{ top: top + 1, height, left: '3px', backgroundColor: `${hex}12`, borderLeft: `3px solid ${hex}`, opacity: isDragging ? 0.3 : undefined, cursor: isDragging ? 'grabbing' : 'grab' }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => handleMouseDown(e, 'move')}
      title={isOrphaned ? 'The show assigned to this slot was deleted' : undefined}
    >
      <div className="absolute top-0 left-0 right-0 h-2 z-10 cursor-ns-resize" onMouseDown={(e) => { e.stopPropagation(); handleMouseDown(e, 'resize-start'); }} />
      <div className="absolute bottom-0 left-0 right-0 h-2 z-10 cursor-ns-resize" onMouseDown={(e) => { e.stopPropagation(); handleMouseDown(e, 'resize-end'); }} />
      {height >= 22 && (
        <div className="px-2 pt-1.5 h-full flex flex-col overflow-hidden relative">
          {entry.is_override && (
            <div className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-amber-400" />
          )}
          <div className="flex items-center gap-1.5 min-w-0 pr-3">
            {isOrphaned
              ? <AlertTriangle className="w-5 h-5 flex-shrink-0 text-amber-400" />
              : <Mic className="w-5 h-5 flex-shrink-0" style={{ color: hex }} />
            }
            <span className={`text-[13px] font-semibold leading-tight truncate ${isOrphaned ? 'text-amber-400' : 'text-zinc-300'}`}>
              {show?.name ?? (isOrphaned ? (entry.orphaned_show_name ?? 'Orphaned') : 'No show')}
            </span>
          </div>
          {height >= 60 && show?.host && (
            <span className="text-xs text-zinc-400 leading-tight truncate mt-0.5 pl-[26px]">{show.host}</span>
          )}
          {height >= 44 && (
            <span className="text-xs font-mono leading-none mt-auto pb-1.5 block pl-[26px]" style={{ color: `${hex}99` }}>
              {entry.time_start}–{entry.time_end}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Calendar Clock-Only Block ────────────────────────────────────────────────

function CalendarClockOnlyBlock({ entry, clock, onClick, onDragStart, isDragging }: {
  entry: CalendarEntry;
  clock: ClockType | undefined;
  onClick: (x: number, y: number) => void;
  onDragStart: (op: DragOp, mouseY: number, isCopy: boolean) => void;
  isDragging: boolean;
}) {
  const { top, height } = entryGeometry(entry.time_start, entry.time_end);
  const isOrphaned = !clock && !!entry.clock_id;
  const borderColor = isOrphaned ? '#f59e0b' : '#ffffff';
  const bgColor = isOrphaned ? '#f59e0b0a' : '#ffffff0a';

  function handleMouseDown(e: React.MouseEvent, op: DragOp) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const isCopy = e.ctrlKey || e.metaKey;
    let didDrag = false;
    const onMove = (ev: MouseEvent) => {
      if (!didDrag && (Math.abs(ev.clientX - startX) > 4 || Math.abs(ev.clientY - startY) > 4)) {
        didDrag = true;
        onDragStart(op, startY, isCopy);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
    };
    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (!didDrag) onClick(ev.clientX, ev.clientY);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  return (
    <div
      className="absolute right-1 rounded-r-[3px] overflow-hidden transition-all hover:brightness-110 z-[1]"
      style={{ top: top + 1, height, left: '3px', backgroundColor: bgColor, borderLeft: `3px solid ${borderColor}`, opacity: isDragging ? 0.3 : undefined, cursor: isDragging ? 'grabbing' : 'grab' }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => handleMouseDown(e, 'move')}
      title={isOrphaned ? 'The clock assigned to this slot was deleted' : undefined}
    >
      <div className="absolute top-0 left-0 right-0 h-2 z-10 cursor-ns-resize" onMouseDown={(e) => { e.stopPropagation(); handleMouseDown(e, 'resize-start'); }} />
      <div className="absolute bottom-0 left-0 right-0 h-2 z-10 cursor-ns-resize" onMouseDown={(e) => { e.stopPropagation(); handleMouseDown(e, 'resize-end'); }} />
      {height >= 22 && (
        <div className="px-2 pt-1.5 h-full flex flex-col overflow-hidden relative pb-[7px]">
          {entry.is_override && (
            <div className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-amber-400" />
          )}
          <div className="flex items-center gap-1.5 min-w-0 pr-3">
            {isOrphaned
              ? <AlertTriangle className="w-5 h-5 flex-shrink-0 text-amber-400" />
              : <Clock className="w-5 h-5 text-white flex-shrink-0" />
            }
            <span className={`text-[13px] font-semibold leading-tight truncate ${isOrphaned ? 'text-amber-400' : clock ? 'text-zinc-300' : 'text-zinc-500 italic'}`}>
              {clock?.name ?? (isOrphaned ? (entry.orphaned_clock_name ?? 'Orphaned') : 'No clock')}
            </span>
          </div>
          {height >= 44 && (
            <span className="text-[11px] font-mono leading-none mt-auto pl-[26px]" style={{ color: `${borderColor}60` }}>
              {entry.time_start}–{entry.time_end}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Slot picker (pill toggle + list) ────────────────────────────────────────

function SlotPicker({
  shows, clocks, maxDurationMinutes,
  selectedShowId, selectedClockId,
  onSelectShow, onSelectClock,
}: {
  shows: Show[];
  clocks: ClockType[];
  maxDurationMinutes: number | null;
  selectedShowId: number | null;
  selectedClockId: number | null;
  onSelectShow: (id: number | null) => void;
  onSelectClock: (id: number | null) => void;
}) {
  // Default pill to whichever type has a current selection; otherwise shows
  const [tab, setTab] = useState<'shows' | 'clocks'>(selectedClockId ? 'clocks' : 'shows');

  const fitsGap = (durationMin: number) =>
    maxDurationMinutes === null || durationMin <= maxDurationMinutes;

  const visibleShows  = shows.filter((s) => fitsGap(s.duration_minutes));
  const visibleClocks = clocks.filter((c) => c.duration_seconds > 0 && fitsGap(Math.round(c.duration_seconds / 60)));

  return (
    <div>
      {/* Pill toggle */}
      <div className="flex gap-1 px-4 py-2.5 border-b border-zinc-800">
        {(['shows', 'clocks'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-1 text-xs font-medium rounded-md capitalize transition-colors ${
              tab === t ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {maxDurationMinutes !== null && (
        <div className="px-4 py-1.5 border-b border-zinc-800 flex items-center gap-1.5">
          <span className="text-[11px] text-zinc-500">Fits in</span>
          <span className="text-[11px] font-mono text-zinc-400">{maxDurationMinutes}m</span>
          <span className="text-[11px] text-zinc-500">gap</span>
        </div>
      )}

      {/* List */}
      <div className="overflow-y-auto" style={{ maxHeight: 208 }}>
        {tab === 'shows' && visibleShows.map((show) => (
          <button
            key={show.id}
            onClick={() => onSelectShow(show.id === selectedShowId ? null : show.id)}
            className={`w-full flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors ${
              selectedShowId === show.id ? 'bg-zinc-800 text-white' : 'text-zinc-300 hover:bg-zinc-800/50'
            }`}
          >
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: COLOR_HEX[show.color] }} />
            <span className="flex-1 truncate">{show.name}</span>
            <span className="text-[11px] text-zinc-500 flex-shrink-0 tabular-nums">
              {formatDuration(show.duration_minutes)}
            </span>
          </button>
        ))}

        {tab === 'clocks' && visibleClocks.map((clock) => (
          <button
            key={clock.id}
            onClick={() => onSelectClock(clock.id === selectedClockId ? null : clock.id)}
            className={`w-full flex items-center gap-2 px-4 py-2 text-left transition-colors ${
              selectedClockId === clock.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
            }`}
          >
            <Clock className="w-3 h-3 text-zinc-500 flex-shrink-0" />
            <span className={`flex-1 text-sm font-medium truncate ${selectedClockId === clock.id ? 'text-white' : 'text-zinc-300'}`}>
              {clock.name}
            </span>
            <span className="text-[11px] text-zinc-500 flex-shrink-0 tabular-nums">
              {Math.round(clock.duration_seconds / 60)}m
            </span>
          </button>
        ))}

        {tab === 'shows' && visibleShows.length === 0 && (
          <p className="px-4 py-4 text-sm text-zinc-600 italic">
            {maxDurationMinutes !== null ? `No shows ≤ ${maxDurationMinutes}m` : 'No shows defined'}
          </p>
        )}
        {tab === 'clocks' && visibleClocks.length === 0 && (
          <p className="px-4 py-4 text-sm text-zinc-600 italic">
            {maxDurationMinutes !== null ? `No clocks ≤ ${maxDurationMinutes}m` : 'No clocks with segments'}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── New Slot Popover (template mode) ─────────────────────────────────────────

function NewSlotPopover({
  timeStart: initStart, maxDurationMinutes, shows, clocks, x, y, onClose, onSave,
}: {
  dayOfWeek: number;
  timeStart: string;
  timeEnd: string;
  maxDurationMinutes: number | null;
  shows: Show[];
  clocks: ClockType[];
  x: number;
  y: number;
  onClose: () => void;
  onSave: (showId: number | null, clockId: number | null, timeStart: string, timeEnd: string) => void;
}) {
  const [selectedShowId,  setSelectedShowId]  = useState<number | null>(null);
  const [selectedClockId, setSelectedClockId] = useState<number | null>(null);
  const [timeStart, setTimeStart] = useState(initStart);
  const [timeEnd,   setTimeEnd]   = useState(() => addMinutes(initStart, 60));

  const computedEnd = useMemo(() => {
    if (selectedShowId) {
      const show = shows.find((s) => s.id === selectedShowId);
      if (show) return addMinutes(timeStart, show.duration_minutes);
    }
    if (selectedClockId) {
      const clock = clocks.find((c) => c.id === selectedClockId);
      if (clock && clock.duration_seconds > 0) return addMinutes(timeStart, Math.round(clock.duration_seconds / 60));
    }
    return null;
  }, [selectedShowId, selectedClockId, timeStart, shows, clocks]);

  const effectiveEnd = computedEnd ?? timeEnd;

  const left = Math.min(x + 12, window.innerWidth  - 288);
  const top  = Math.min(y,      window.innerHeight - 480);

  return (
    <div
      className="fixed z-50 bg-zinc-900 border border-zinc-700/80 rounded-xl shadow-2xl w-72 overflow-hidden"
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <span className="text-sm font-semibold text-zinc-200">Schedule</span>
        <button onClick={onClose} className="p-0.5 text-zinc-600 hover:text-zinc-300 transition-colors">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Time row */}
      <div className="px-4 py-2.5 flex items-center gap-2 border-b border-zinc-800">
        <div className="flex-1">
          <label className="text-[11px] text-zinc-500 block mb-1">Start</label>
          <input type="time" value={timeStart} onChange={(e) => setTimeStart(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-2 py-1.5 text-sm text-white font-mono focus:outline-none focus:border-indigo-500" />
        </div>
        <div className="flex-1">
          <label className="text-[11px] text-zinc-500 block mb-1">
            End {computedEnd && <span className="text-zinc-600 normal-case font-normal">· auto</span>}
          </label>
          {computedEnd
            ? <div className="h-[34px] flex items-center px-2 text-sm font-mono text-zinc-400 bg-zinc-800/50 border border-zinc-700/50 rounded-md">{computedEnd}</div>
            : <input type="time" value={timeEnd} onChange={(e) => setTimeEnd(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-2 py-1.5 text-sm text-white font-mono focus:outline-none focus:border-indigo-500" />
          }
        </div>
      </div>

      <SlotPicker
        shows={shows}
        clocks={clocks}
        maxDurationMinutes={maxDurationMinutes}
        selectedShowId={selectedShowId}
        selectedClockId={selectedClockId}
        onSelectShow={(id) => { setSelectedShowId(id); setSelectedClockId(null); }}
        onSelectClock={(id) => { setSelectedClockId(id); setSelectedShowId(null); }}
      />

      <div className="px-4 py-3 border-t border-zinc-800">
        <button
          onClick={() => onSave(selectedShowId, selectedClockId, timeStart, effectiveEnd)}
          disabled={!timeStart || !effectiveEnd || (!selectedShowId && !selectedClockId)}
          className="w-full py-1.5 text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors disabled:opacity-40"
        >
          Schedule
        </button>
      </div>
    </div>
  );
}

// ─── Edit Slot Popover (template mode) ───────────────────────────────────────

function EditSlotPopover({
  entry, show, clock, shows, clocks, x, y, onClose, onRemove, onChange,
}: {
  entry: TemplateEntry;
  show: Show | undefined;
  clock: ClockType | undefined;
  shows: Show[];
  clocks: ClockType[];
  x: number;
  y: number;
  onClose: () => void;
  onRemove: () => void;
  onChange: (showId: number | null, clockId: number | null) => void;
}) {
  const [picking, setPicking] = useState(false);
  const navigate = useNavigate();
  const isClockSlot = !entry.show_id && !!entry.clock_id;
  const hex  = show ? COLOR_HEX[show.color] : '#52525b';
  const left = Math.min(x + 12, window.innerWidth  - 272);
  const top  = Math.min(y,      window.innerHeight - 340);

  if (picking) {
    return (
      <div
        className="fixed z-50 bg-zinc-900 border border-zinc-700/80 rounded-xl shadow-2xl w-64 overflow-hidden"
        style={{ left, top }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <span className="text-sm font-semibold text-zinc-200">Change Slot</span>
          <button onClick={() => setPicking(false)} className="p-0.5 text-zinc-600 hover:text-zinc-300 transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <SlotPicker
          shows={shows}
          clocks={clocks}
          maxDurationMinutes={null}
          selectedShowId={entry.show_id ?? null}
          selectedClockId={entry.clock_id ?? null}
          onSelectShow={(id) => { if (id !== null) onChange(id, null); }}
          onSelectClock={(id) => { if (id !== null) onChange(null, id); }}
        />
      </div>
    );
  }

  return (
    <div
      className="fixed z-50 bg-zinc-900 border border-zinc-700/80 rounded-xl shadow-2xl w-64 overflow-hidden"
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="h-[2.5px]" style={{ backgroundColor: isClockSlot ? '#6366f1' : hex }} />
      <div className="p-4">
        <div className="flex items-start gap-2 mb-3">
          <div className="flex-1 min-w-0">
            {isClockSlot
              ? (
                <div className="flex items-center gap-1.5 min-w-0">
                  <Clock className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
                  <div className="text-sm font-semibold text-zinc-100 truncate">{clock?.name ?? 'No clock'}</div>
                </div>
              )
              : <div className="text-sm font-semibold text-zinc-100 truncate">{show?.name ?? (entry.show_id ? 'Orphaned entry' : 'No show')}</div>
            }
            {show?.host && <div className="text-xs text-zinc-400 mt-0.5">{show.host}</div>}
          </div>
          <button onClick={onClose} className="flex-shrink-0 p-0.5 text-zinc-600 hover:text-zinc-300 transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="space-y-1.5 mb-3">
          <InfoRow label="Time" value={`${entry.time_start} – ${entry.time_end}`} mono />
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setPicking(true)}
            className="flex-1 py-1.5 text-xs font-medium text-zinc-300 hover:text-white border border-zinc-700 hover:border-zinc-500 rounded-lg transition-colors"
          >
            Change
          </button>
          {show && (
            <button
              onClick={() => navigate(`/shows/${show.id}`)}
              title="Edit show"
              className="p-1.5 text-zinc-500 hover:text-indigo-400 border border-zinc-700 hover:border-zinc-600 rounded-lg transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
          {isClockSlot && clock && (
            <button
              onClick={() => navigate(`/clocks/${clock.id}`)}
              title="Edit clock"
              className="p-1.5 text-zinc-500 hover:text-indigo-400 border border-zinc-700 hover:border-zinc-600 rounded-lg transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={onRemove}
            className="p-1.5 text-zinc-500 hover:text-red-400 border border-zinc-700 hover:border-zinc-600 rounded-lg transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Cal New Slot Popover (calendar mode) ─────────────────────────────────────

function CalNewSlotPopover({
  date, timeStart: initStart, templateEntry, maxDurationMinutes, shows, clocks, x, y, onClose, onSave,
}: {
  date: string;
  timeStart: string;
  timeEnd: string;
  templateEntry?: TemplateEntry;
  maxDurationMinutes: number | null;
  shows: Show[];
  clocks: ClockType[];
  x: number;
  y: number;
  onClose: () => void;
  onSave: (date: string, showId: number | null, clockId: number | null, timeStart: string, timeEnd: string, isOverride: boolean) => void;
}) {
  const isOverride = !!templateEntry;
  const [selectedShowId,  setSelectedShowId]  = useState<number | null>(templateEntry?.show_id  ?? null);
  const [selectedClockId, setSelectedClockId] = useState<number | null>(templateEntry?.clock_id ?? null);
  const [timeStart, setTimeStart] = useState(initStart);
  const [timeEnd,   setTimeEnd]   = useState(() => addMinutes(initStart, 60));

  const computedEnd = useMemo(() => {
    if (selectedShowId) {
      const show = shows.find((s) => s.id === selectedShowId);
      if (show) return addMinutes(timeStart, show.duration_minutes);
    }
    if (selectedClockId) {
      const clock = clocks.find((c) => c.id === selectedClockId);
      if (clock && clock.duration_seconds > 0) return addMinutes(timeStart, Math.round(clock.duration_seconds / 60));
    }
    return null;
  }, [selectedShowId, selectedClockId, timeStart, shows, clocks]);

  // Pre-fill end for override: use the template entry's own end time
  const templateEnd = templateEntry ? templateEntry.time_end : null;
  const effectiveEnd = computedEnd ?? templateEnd ?? timeEnd;

  const left        = Math.min(x + 12, window.innerWidth  - 288);
  const top         = Math.min(y,      window.innerHeight - 500);
  const dateDisplay = new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  return (
    <div
      className="fixed z-50 bg-zinc-900 border border-zinc-700/80 rounded-xl shadow-2xl w-72 overflow-hidden"
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-zinc-200">{isOverride ? 'Override' : 'Schedule'}</span>
          <span className="text-xs text-zinc-500">{dateDisplay}</span>
        </div>
        <button onClick={onClose} className="p-0.5 text-zinc-600 hover:text-zinc-300 transition-colors">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {isOverride && (
        <div className="px-4 py-2 bg-amber-500/8 border-b border-amber-500/20">
          <p className="text-[11px] text-amber-400/80">Overrides the template slot for this day only.</p>
        </div>
      )}

      <div className="px-4 py-2.5 flex items-center gap-2 border-b border-zinc-800">
        <div className="flex-1">
          <label className="text-[11px] text-zinc-500 block mb-1">Start</label>
          <input type="time" value={timeStart} onChange={(e) => setTimeStart(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-2 py-1.5 text-sm text-white font-mono focus:outline-none focus:border-indigo-500" />
        </div>
        <div className="flex-1">
          <label className="text-[11px] text-zinc-500 block mb-1">
            End {computedEnd && <span className="text-zinc-600 normal-case font-normal">· auto</span>}
          </label>
          {(computedEnd || templateEnd)
            ? <div className="h-[34px] flex items-center px-2 text-sm font-mono text-zinc-400 bg-zinc-800/50 border border-zinc-700/50 rounded-md">{effectiveEnd}</div>
            : <input type="time" value={timeEnd} onChange={(e) => setTimeEnd(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-2 py-1.5 text-sm text-white font-mono focus:outline-none focus:border-indigo-500" />
          }
        </div>
      </div>

      <SlotPicker
        shows={shows}
        clocks={clocks}
        maxDurationMinutes={maxDurationMinutes}
        selectedShowId={selectedShowId}
        selectedClockId={selectedClockId}
        onSelectShow={(id) => { setSelectedShowId(id); setSelectedClockId(null); }}
        onSelectClock={(id) => { setSelectedClockId(id); setSelectedShowId(null); }}
      />

      <div className="px-4 py-3 border-t border-zinc-800">
        <button
          onClick={() => onSave(date, selectedShowId, selectedClockId, timeStart, effectiveEnd, isOverride)}
          disabled={!timeStart || !effectiveEnd || (!selectedShowId && !selectedClockId)}
          className="w-full py-1.5 text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors disabled:opacity-40"
        >
          {isOverride ? 'Override for this day' : 'Schedule'}
        </button>
      </div>
    </div>
  );
}

// ─── Cal Edit Slot Popover (calendar mode) ────────────────────────────────────

function CalEditSlotPopover({
  entry, show, clock, shows, clocks, x, y, onClose, onRemove, onRestore, onChange,
}: {
  entry: CalendarEntry;
  show: Show | undefined;
  clock: ClockType | undefined;
  shows: Show[];
  clocks: ClockType[];
  x: number;
  y: number;
  onClose: () => void;
  onRemove: () => void;
  onRestore?: () => void;
  onChange: (showId: number | null, clockId: number | null) => void;
}) {
  const [picking, setPicking] = useState(false);
  const navigate = useNavigate();
  const isClockSlot = !entry.show_id && !!entry.clock_id;
  const hex  = show ? COLOR_HEX[show.color] : '#52525b';
  const left = Math.min(x + 12, window.innerWidth  - 272);
  const top  = Math.min(y,      window.innerHeight - 380);

  if (picking) {
    return (
      <div
        className="fixed z-50 bg-zinc-900 border border-zinc-700/80 rounded-xl shadow-2xl w-64 overflow-hidden"
        style={{ left, top }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <span className="text-sm font-semibold text-zinc-200">Change Slot</span>
          <button onClick={() => setPicking(false)} className="p-0.5 text-zinc-600 hover:text-zinc-300 transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <SlotPicker
          shows={shows}
          clocks={clocks}
          maxDurationMinutes={null}
          selectedShowId={entry.show_id ?? null}
          selectedClockId={entry.clock_id ?? null}
          onSelectShow={(id) => { if (id !== null) onChange(id, null); }}
          onSelectClock={(id) => { if (id !== null) onChange(null, id); }}
        />
      </div>
    );
  }

  return (
    <div
      className="fixed z-50 bg-zinc-900 border border-zinc-700/80 rounded-xl shadow-2xl w-64 overflow-hidden"
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="h-[2.5px]" style={{ backgroundColor: isClockSlot ? '#6366f1' : hex }} />
      <div className="p-4">
        {entry.is_override && (
          <div className="flex items-center gap-1.5 mb-2">
            <div className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-400/80">Override</span>
          </div>
        )}
        <div className="flex items-start gap-2 mb-3">
          <div className="flex-1 min-w-0">
            {isClockSlot
              ? (
                <div className="flex items-center gap-1.5 min-w-0">
                  <Clock className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
                  <div className="text-sm font-semibold text-zinc-100 truncate">{clock?.name ?? 'No clock'}</div>
                </div>
              )
              : <div className="text-sm font-semibold text-zinc-100 truncate">{show?.name ?? (entry.show_id ? 'Orphaned entry' : 'No show')}</div>
            }
            {show?.host && <div className="text-xs text-zinc-400 mt-0.5">{show.host}</div>}
          </div>
          <button onClick={onClose} className="flex-shrink-0 p-0.5 text-zinc-600 hover:text-zinc-300 transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="space-y-1.5 mb-3">
          <InfoRow label="Time" value={`${entry.time_start} – ${entry.time_end}`} mono />
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setPicking(true)}
            className="flex-1 py-1.5 text-xs font-medium text-zinc-300 hover:text-white border border-zinc-700 hover:border-zinc-500 rounded-lg transition-colors"
          >
            Change
          </button>
          {show && (
            <button
              onClick={() => navigate(`/shows/${show.id}`)}
              title="Edit show"
              className="p-1.5 text-zinc-500 hover:text-indigo-400 border border-zinc-700 hover:border-zinc-600 rounded-lg transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
          {isClockSlot && clock && (
            <button
              onClick={() => navigate(`/clocks/${clock.id}`)}
              title="Edit clock"
              className="p-1.5 text-zinc-500 hover:text-indigo-400 border border-zinc-700 hover:border-zinc-600 rounded-lg transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
          {onRestore && (
            <button
              onClick={onRestore}
              title="Restore template slot"
              className="p-1.5 text-zinc-500 hover:text-amber-400 border border-zinc-700 hover:border-zinc-600 rounded-lg transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={onRemove}
            className="p-1.5 text-zinc-500 hover:text-red-400 border border-zinc-700 hover:border-zinc-600 rounded-lg transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Broadcast Intervals Tab ──────────────────────────────────────────────────

const INTERVAL_COLORS = [
  '#818cf8', '#a78bfa', '#22d3ee', '#34d399',
  '#fbbf24', '#fb7185', '#fb923c', '#2dd4bf',
  '#f472b6', '#a3e635',
];

type RibbonCreateDrag = { startMin: number; endMin: number; columnRect: DOMRect };
type RibbonPending    = { startMin: number; endMin: number; x: number; y: number };
type RibbonBlockDrag  = {
  op: 'move' | 'resize-start' | 'resize-end';
  iv: BroadcastInterval;
  startMin: number;
  endMin: number;
  origStartMin: number;
  origEndMin: number;
};
type PlaceDrag        = { interval: BroadcastInterval; targetDayOfWeek: number | null };
type SlotBlockDrag    = {
  op: 'move' | 'resize-start' | 'resize-end';
  slot: BroadcastIntervalSlot;
  startMin: number;
  endMin: number;
  origStartMin: number;
  origEndMin: number;
};
type EditingInterval = { interval: BroadcastInterval; x: number; y: number };
type DeletingSlot    = { slot: BroadcastIntervalSlot; x: number; y: number };

function IntervalsTab() {
  const qc = useQueryClient();
  const { data: intervals = [] } = useQuery({ queryKey: ['intervals'],      queryFn: fetchIntervals });
  const { data: slots = [] }     = useQuery({ queryKey: ['interval-slots'], queryFn: fetchIntervalSlots });

  const invalidateIntervals = () => qc.invalidateQueries({ queryKey: ['intervals'] });
  const invalidateSlots     = () => qc.invalidateQueries({ queryKey: ['interval-slots'] });
  const invalidateAll       = () => { invalidateIntervals(); invalidateSlots(); };

  const createIntervalMut = useMutation({ mutationFn: createInterval, onSuccess: invalidateIntervals });
  const updateIntervalMut = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: BroadcastIntervalPatch }) => updateInterval(id, patch),
    onSuccess: invalidateIntervals,
  });
  const deleteIntervalMut = useMutation({ mutationFn: deleteInterval, onSuccess: invalidateAll });
  const createSlotMut     = useMutation({ mutationFn: createIntervalSlot, onSuccess: invalidateSlots });
  const updateSlotMut     = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: BroadcastIntervalSlotPatch }) => updateIntervalSlot(id, patch),
    onSuccess: invalidateSlots,
  });
  const deleteSlotMut = useMutation({ mutationFn: deleteIntervalSlot, onSuccess: invalidateSlots });

  const [ribbonCreateDrag, setRibbonCreateDrag] = useState<RibbonCreateDrag | null>(null);
  const [ribbonPending,    setRibbonPending]    = useState<RibbonPending | null>(null);
  const [placeDrag,        setPlaceDrag]        = useState<PlaceDrag | null>(null);
  const [editingInterval,  setEditingInterval]  = useState<EditingInterval | null>(null);
  const [deletingSlot,     setDeletingSlot]     = useState<DeletingSlot | null>(null);

  const placeDragTargetRef     = useRef<number | null>(null);
  const placeDragMouseYRef     = useRef<number>(0);
  const placeDragColumnRectRef = useRef<DOMRect | null>(null);

  function startRibbonCreateDrag(startMin: number, rect: DOMRect) {
    let current: RibbonCreateDrag = { startMin, endMin: startMin + 60, columnRect: rect };
    setRibbonCreateDrag(current);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';

    const onMove = (e: MouseEvent) => {
      const raw    = (e.clientY - current.columnRect.top) / TOTAL_HEIGHT * 24 * 60;
      const endMin = Math.max(current.startMin + 15, Math.round(Math.min(24 * 60, raw) / 15) * 15);
      current = { ...current, endMin };
      setRibbonCreateDrag({ ...current });
    };

    const onUp = (e: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const drag = current;
      setRibbonCreateDrag(null);
      if (drag.endMin - drag.startMin < 15) return;
      setRibbonPending({ startMin: drag.startMin, endMin: drag.endMin, x: e.clientX, y: e.clientY });
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function startPlaceDrag(interval: BroadcastInterval) {
    placeDragTargetRef.current     = null;
    placeDragColumnRectRef.current = null;
    placeDragMouseYRef.current     = 0;
    setPlaceDrag({ interval, targetDayOfWeek: null });
    document.body.style.cursor    = 'grabbing';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => { placeDragMouseYRef.current = ev.clientY; };
    document.addEventListener('mousemove', onMove);

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor    = '';
      document.body.style.userSelect = '';
      const targetDayOfWeek = placeDragTargetRef.current;
      const columnRect      = placeDragColumnRectRef.current;
      const mouseY          = placeDragMouseYRef.current;
      setPlaceDrag(null);
      placeDragTargetRef.current     = null;
      placeDragColumnRectRef.current = null;
      if (!targetDayOfWeek) return;
      const alreadyPlaced = slots.some(
        (s) => s.interval_id === interval.id && s.day_of_week === targetDayOfWeek,
      );
      if (alreadyPlaced) return;
      const dur = Math.max(15, timeToMinutes(interval.default_end_time) - timeToMinutes(interval.default_start_time));
      let startMin: number;
      if (columnRect && mouseY > 0) {
        const raw = (mouseY - columnRect.top) / TOTAL_HEIGHT * 24 * 60;
        startMin  = Math.max(0, Math.min(24 * 60 - dur, Math.round(raw / 15) * 15));
      } else {
        startMin = timeToMinutes(interval.default_start_time);
      }
      const wouldOverlap = slots.some(
        (s) => s.day_of_week === targetDayOfWeek &&
               timeToMinutes(s.end_time) > startMin &&
               timeToMinutes(s.start_time) < startMin + dur,
      );
      if (wouldOverlap) return;
      createSlotMut.mutate({
        interval_id: interval.id,
        day_of_week: targetDayOfWeek,
        start_time: minutesToTime(startMin),
        end_time:   minutesToTime(startMin + dur),
      });
    };

    document.addEventListener('mouseup', onUp);
  }

  function setPlaceDragTarget(dayOfWeek: number | null, rect?: DOMRect) {
    placeDragTargetRef.current = dayOfWeek;
    if (rect) placeDragColumnRectRef.current = rect;
    setPlaceDrag((prev) => (prev ? { ...prev, targetDayOfWeek: dayOfWeek } : null));
  }

  return (
    <div onClick={() => { setEditingInterval(null); setDeletingSlot(null); }}>
      <p className="mb-3 text-xs text-zinc-500">
        Drag on ribbon to define intervals · Drag interval blocks into weekday columns to schedule
      </p>

      <div className="rounded-xl border-4 border-amber-500/40 flex flex-col">
        {/* Day headers */}
        <div className="sticky top-0 z-10 flex-shrink-0 flex border-b border-zinc-700 rounded-tl-[10px] rounded-tr-[10px] bg-zinc-800">
          <div className="w-16 flex-shrink-0 bg-zinc-900/70 border-r border-zinc-700 flex items-center justify-center">
            <Clock className="w-4 h-4 text-zinc-500" />
          </div>
          {DAY_NAMES.map((name, i) => (
            <div key={i} className={`flex-1 py-4 text-center ${i < 6 ? 'border-r border-zinc-500/80 [box-shadow:inset_-1px_0_0_rgba(0,0,0,0.55)]' : ''}`}>
              <div className="text-[15px] font-semibold text-zinc-100">{name}</div>
            </div>
          ))}
          <div className="w-3 flex-shrink-0" />
        </div>

        {/* Body */}
        <div className="bg-zinc-950 overflow-hidden">
          <div className="flex pt-2" style={{ height: TOTAL_HEIGHT + 8 }}>
            <IntervalRibbonColumn
              intervals={intervals}
              activeDrag={ribbonCreateDrag}
              placeDragIntervalId={placeDrag?.interval.id ?? null}
              onDragStart={(startMin, rect) => startRibbonCreateDrag(startMin, rect)}
              onBlockDragStart={(iv) => startPlaceDrag(iv)}
              onBlockUpdate={(id, defaultStart, defaultEnd) =>
                updateIntervalMut.mutate({ id, patch: { default_start_time: defaultStart, default_end_time: defaultEnd } })
              }
              onBlockClick={(iv, x, y) => setEditingInterval({ interval: iv, x, y })}
            />
            <div className="flex-1 grid grid-cols-7 divide-x divide-zinc-700/50">
              {DAY_NAMES.map((_, i) => {
                const dayOfWeek    = i + 1;
                const daySlots     = slots.filter((s) => s.day_of_week === dayOfWeek);
                const isValidTarget = placeDrag !== null && !slots.some(
                  (s) => s.interval_id === placeDrag.interval.id && s.day_of_week === dayOfWeek,
                );
                return (
                  <IntervalDayColumn
                    key={i}
                    slots={daySlots}
                    intervals={intervals}
                    isValidTarget={isValidTarget}
                    isActiveTarget={placeDrag?.targetDayOfWeek === dayOfWeek}
                    isDraggingPlace={placeDrag !== null}
                    placeDragInterval={placeDrag?.interval ?? null}
                    onSlotClick={(slot, x, y) => setDeletingSlot({ slot, x, y })}
                    onSlotUpdate={(id, startTime, endTime) =>
                      updateSlotMut.mutate({ id, patch: { start_time: startTime, end_time: endTime } })
                    }
                    onMouseEnter={(rect) => { if (placeDrag) setPlaceDragTarget(dayOfWeek, rect); }}
                    onMouseLeave={() => { if (placeDrag) setPlaceDragTarget(null); }}
                  />
                );
              })}
            </div>
            <div className="w-3 flex-shrink-0" />
          </div>
        </div>
      </div>

      {ribbonPending && (
        <IntervalCreatePopover
          startMin={ribbonPending.startMin}
          endMin={ribbonPending.endMin}
          x={ribbonPending.x}
          y={ribbonPending.y}
          onClose={() => setRibbonPending(null)}
          onSave={(name, color) => {
            createIntervalMut.mutate({
              name,
              color,
              default_start_time: minutesToTime(ribbonPending.startMin),
              default_end_time:   minutesToTime(ribbonPending.endMin >= 24 * 60 ? 0 : ribbonPending.endMin),
            });
            setRibbonPending(null);
          }}
        />
      )}

      {editingInterval && (
        <IntervalEditPopover
          interval={editingInterval.interval}
          x={editingInterval.x}
          y={editingInterval.y}
          onClose={() => setEditingInterval(null)}
          onSave={(patch) => {
            updateIntervalMut.mutate({ id: editingInterval.interval.id, patch });
            setEditingInterval(null);
          }}
          onDelete={() => { deleteIntervalMut.mutate(editingInterval.interval.id); setEditingInterval(null); }}
        />
      )}

      {deletingSlot && (() => {
        const iv = intervals.find((i) => i.id === deletingSlot.slot.interval_id);
        return (
          <SlotDeletePopover
            slot={deletingSlot.slot}
            intervalName={iv?.name ?? '?'}
            intervalColor={iv?.color ?? '#818cf8'}
            x={deletingSlot.x}
            y={deletingSlot.y}
            onClose={() => setDeletingSlot(null)}
            onDelete={() => { deleteSlotMut.mutate(deletingSlot.slot.id); setDeletingSlot(null); }}
          />
        );
      })()}
    </div>
  );
}

function IntervalRibbonColumn({
  intervals, activeDrag, placeDragIntervalId,
  onDragStart, onBlockDragStart, onBlockUpdate, onBlockClick,
}: {
  intervals: BroadcastInterval[];
  activeDrag: RibbonCreateDrag | null;
  placeDragIntervalId: number | null;
  onDragStart: (startMin: number, rect: DOMRect) => void;
  onBlockDragStart: (iv: BroadcastInterval) => void;
  onBlockUpdate: (id: number, defaultStart: string, defaultEnd: string) => void;
  onBlockClick: (iv: BroadcastInterval, x: number, y: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [blockDrag, setBlockDrag] = useState<RibbonBlockDrag | null>(null);

  // Returns the time bounds within which this interval can move/resize
  function getNeighborBounds(iv: BroadcastInterval) {
    const sorted    = [...intervals].sort((a, b) => timeToMinutes(a.default_start_time) - timeToMinutes(b.default_start_time));
    const idx       = sorted.findIndex((i) => i.id === iv.id);
    const prevEnd   = idx > 0 ? timeToMinutes(sorted[idx - 1].default_end_time) : 0;
    const nextStart = idx < sorted.length - 1 ? timeToMinutes(sorted[idx + 1].default_start_time) : 24 * 60;
    return { prevEnd, nextStart };
  }

  // Body drag: horizontal → place drag, vertical → move, no movement → click/edit
  function handleBodyMouseDown(e: React.MouseEvent, iv: BroadcastInterval) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;

    const startX       = e.clientX;
    const startY       = e.clientY;
    const origStartMin = timeToMinutes(iv.default_start_time);
    const origEndMin   = timeToMinutes(iv.default_end_time);
    const dur          = origEndMin - origStartMin;
    const cursorMin    = (startY - rect.top) / TOTAL_HEIGHT * 24 * 60;
    const offsetMin    = Math.max(0, cursorMin - origStartMin);
    const { prevEnd, nextStart } = getNeighborBounds(iv);

    let phase: 'undecided' | 'placing' | 'moving' = 'undecided';
    let current: RibbonBlockDrag = { op: 'move', iv, startMin: origStartMin, endMin: origEndMin, origStartMin, origEndMin };

    const onMove = (ev: MouseEvent) => {
      const dx = Math.abs(ev.clientX - startX);
      const dy = Math.abs(ev.clientY - startY);

      if (phase === 'undecided') {
        if (dx <= 5 && dy <= 5) return;
        phase = dx > dy ? 'placing' : 'moving';
        if (phase === 'placing') {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          onBlockDragStart(iv);
          return;
        }
        document.body.style.cursor     = 'grabbing';
        document.body.style.userSelect = 'none';
        setBlockDrag(current);
      }

      if (phase === 'moving') {
        const raw      = (ev.clientY - rect.top) / TOTAL_HEIGHT * 24 * 60;
        const clamped  = Math.max(0, Math.min(24 * 60, raw));
        const rawStart = Math.round((clamped - offsetMin) / 15) * 15;
        const newStart = Math.max(prevEnd, Math.min(Math.min(nextStart, 24 * 60 - 15) - dur, rawStart));
        current = { ...current, startMin: newStart, endMin: newStart + dur };
        setBlockDrag({ ...current });
      }
    };

    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
      const drag = current;
      setBlockDrag(null);
      if (phase === 'undecided') {
        onBlockClick(iv, ev.clientX, ev.clientY);
        const stopClick = (ce: Event) => { ce.stopPropagation(); document.removeEventListener('click', stopClick, true); };
        document.addEventListener('click', stopClick, true);
        return;
      }
      if (phase === 'moving' && drag.startMin !== drag.origStartMin) {
        onBlockUpdate(iv.id, minutesToTime(drag.startMin), minutesToTime(Math.min(drag.endMin, 24 * 60 - 15)));
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function handleResizeMouseDown(e: React.MouseEvent, iv: BroadcastInterval, op: 'resize-start' | 'resize-end') {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;

    const origStartMin = timeToMinutes(iv.default_start_time);
    const origEndMin   = timeToMinutes(iv.default_end_time);
    const { prevEnd, nextStart } = getNeighborBounds(iv);

    let current: RibbonBlockDrag = { op, iv, startMin: origStartMin, endMin: origEndMin, origStartMin, origEndMin };
    setBlockDrag(current);
    document.body.style.cursor     = 'ns-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      const raw     = (ev.clientY - rect.top) / TOTAL_HEIGHT * 24 * 60;
      const clamped = Math.max(0, Math.min(24 * 60, raw));
      const snapped = Math.round(clamped / 15) * 15;
      let { startMin, endMin } = current;

      if (op === 'resize-start') {
        startMin = Math.max(prevEnd, Math.min(current.endMin - 15, snapped));
      } else {
        endMin = Math.max(current.startMin + 15, Math.min(Math.min(nextStart, 24 * 60 - 15), snapped));
      }

      current = { ...current, startMin, endMin };
      setBlockDrag({ ...current });
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
      const drag = current;
      setBlockDrag(null);
      if (drag.startMin === drag.origStartMin && drag.endMin === drag.origEndMin) return;
      onBlockUpdate(iv.id, minutesToTime(drag.startMin), minutesToTime(Math.min(drag.endMin, 24 * 60 - 15)));
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function handleColumnMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const raw      = (e.clientY - rect.top) / TOTAL_HEIGHT * 24 * 60;
    const startMin = Math.floor(raw / 15) * 15;
    onDragStart(startMin, rect);
  }

  return (
    <div
      ref={ref}
      className="w-16 flex-shrink-0 relative border-r border-zinc-700 bg-zinc-900/50 cursor-cell"
      style={{ height: TOTAL_HEIGHT }}
      onMouseDown={handleColumnMouseDown}
    >
      {/* Hour grid lines + labels */}
      {HOURS.map((h) => (
        <div key={h} className="absolute left-0 right-0 border-t border-zinc-700/40" style={{ top: h * HOUR_HEIGHT }}>
          {h > 0 && (
            <span className="absolute right-2 text-sm text-zinc-400 font-mono -translate-y-[10px] select-none pointer-events-none">
              {String(h).padStart(2, '0')}:00
            </span>
          )}
        </div>
      ))}

      {/* Interval blocks — colored strip only, no text (click to edit/see name) */}
      {intervals.map((iv) => {
        const isDragging  = blockDrag?.iv.id === iv.id;
        const startMin    = isDragging ? blockDrag!.startMin : timeToMinutes(iv.default_start_time);
        const rawEndMin   = isDragging ? blockDrag!.endMin   : timeToMinutes(iv.default_end_time);
        const endMin      = rawEndMin === 0 && startMin > 0 ? 24 * 60 : rawEndMin;
        const top        = (startMin / (24 * 60)) * TOTAL_HEIGHT;
        const height     = Math.max(((endMin - startMin) / (24 * 60)) * TOTAL_HEIGHT, 8);
        const isPlacing  = placeDragIntervalId === iv.id;

        return (
          <div
            key={iv.id}
            title={iv.name}
            className={`absolute left-0 right-1 rounded select-none ${isDragging ? 'opacity-60' : isPlacing ? 'opacity-30' : 'hover:brightness-125 cursor-grab'}`}
            style={{ top, height, backgroundColor: iv.color + '55', borderLeft: `3px solid ${iv.color}` }}
            onMouseDown={(e) => handleBodyMouseDown(e, iv)}
          >
            <div className="absolute top-0 left-0 right-0 h-2 cursor-ns-resize" onMouseDown={(e) => { e.stopPropagation(); handleResizeMouseDown(e, iv, 'resize-start'); }} />
            <div className="absolute bottom-0 left-0 right-0 h-2 cursor-ns-resize" onMouseDown={(e) => { e.stopPropagation(); handleResizeMouseDown(e, iv, 'resize-end'); }} />
          </div>
        );
      })}

      {/* Create-drag ghost */}
      {activeDrag && (
        <div
          className="absolute left-0 right-0.5 rounded-md pointer-events-none"
          style={{
            top:    (activeDrag.startMin / (24 * 60)) * TOTAL_HEIGHT,
            height: Math.max(((activeDrag.endMin - activeDrag.startMin) / (24 * 60)) * TOTAL_HEIGHT, 4),
            backgroundColor: '#818cf840',
            borderLeft: '3px solid #818cf8',
          }}
        />
      )}
    </div>
  );
}

function IntervalDayColumn({
  slots, intervals, isValidTarget, isActiveTarget, isDraggingPlace, placeDragInterval,
  onSlotClick, onSlotUpdate, onMouseEnter, onMouseLeave,
}: {
  slots: BroadcastIntervalSlot[];
  intervals: BroadcastInterval[];
  isValidTarget: boolean;
  isActiveTarget: boolean;
  isDraggingPlace: boolean;
  placeDragInterval: BroadcastInterval | null;
  onSlotClick: (slot: BroadcastIntervalSlot, x: number, y: number) => void;
  onSlotUpdate: (id: number, startTime: string, endTime: string) => void;
  onMouseEnter: (rect: DOMRect) => void;
  onMouseLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [blockDrag, setBlockDrag] = useState<SlotBlockDrag | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);

  function handleMouseMove(e: React.MouseEvent) {
    if (!isActiveTarget || !placeDragInterval || !ghostRef.current) return;
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const dur     = Math.max(15, timeToMinutes(placeDragInterval.default_end_time) - timeToMinutes(placeDragInterval.default_start_time));
    const raw     = (e.clientY - rect.top) / TOTAL_HEIGHT * 24 * 60;
    const snapped = Math.round(raw / 15) * 15;

    // Find the free gap that contains the cursor
    const sorted = [...slots].sort((a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time));
    let validStart: number | null = null;
    let prev = 0;
    for (let i = 0; i <= sorted.length; i++) {
      const gapStart = prev;
      const gapEnd   = i < sorted.length ? timeToMinutes(sorted[i].start_time) : 24 * 60;
      if (gapEnd - gapStart >= dur && snapped >= gapStart && snapped <= gapEnd) {
        validStart = Math.max(gapStart, Math.min(gapEnd - dur, snapped));
        break;
      }
      if (i < sorted.length) prev = timeToMinutes(sorted[i].end_time);
    }

    if (validStart === null) { ghostRef.current.style.display = 'none'; return; }
    ghostRef.current.style.display = 'block';

    const start  = validStart;
    const end    = start + dur;
    const top    = (start / (24 * 60)) * TOTAL_HEIGHT;
    const height = Math.max((dur / (24 * 60)) * TOTAL_HEIGHT, 20);
    ghostRef.current.style.top    = `${top}px`;
    ghostRef.current.style.height = `${height}px`;
    const timeEl = ghostRef.current.querySelector<HTMLElement>('[data-ghost-time]');
    if (timeEl) {
      timeEl.textContent   = `${minutesToTime(start)}–${minutesToTime(end >= 24 * 60 ? 0 : end)}`;
      timeEl.style.display = height >= 40 ? '' : 'none';
    }
  }

  function handleSlotMouseDown(e: React.MouseEvent, slot: BroadcastIntervalSlot, op: SlotBlockDrag['op']) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;

    const origStartMin = timeToMinutes(slot.start_time);
    const origEndMin   = timeToMinutes(slot.end_time);
    const cursorMin    = (e.clientY - rect.top) / TOTAL_HEIGHT * 24 * 60;
    const offsetMin    = op === 'move' ? Math.max(0, cursorMin - origStartMin) : 0;
    const startX = e.clientX, startY = e.clientY;
    let didMove = false;

    // Collision bounds: can't overlap adjacent slots in this day
    const sorted    = [...slots].sort((a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time));
    const idx       = sorted.findIndex((s) => s.id === slot.id);
    const prevEnd   = idx > 0 ? timeToMinutes(sorted[idx - 1].end_time) : 0;
    const nextStart = idx < sorted.length - 1 ? timeToMinutes(sorted[idx + 1].start_time) : 24 * 60;

    let current: SlotBlockDrag = { op, slot, startMin: origStartMin, endMin: origEndMin, origStartMin, origEndMin };
    setBlockDrag(current);
    document.body.style.cursor     = op === 'move' ? 'grabbing' : 'ns-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      if (!didMove && (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3)) didMove = true;
      const raw     = (ev.clientY - rect.top) / TOTAL_HEIGHT * 24 * 60;
      const clamped = Math.max(0, Math.min(24 * 60, raw));
      const snapped = Math.round(clamped / 15) * 15;
      let { startMin, endMin } = current;

      if (current.op === 'move') {
        const dur      = origEndMin - origStartMin;
        const rawStart = Math.round((clamped - offsetMin) / 15) * 15;
        startMin = Math.max(prevEnd, Math.min(nextStart - dur, rawStart));
        endMin   = startMin + dur;
      } else if (current.op === 'resize-start') {
        startMin = Math.max(prevEnd, Math.min(current.endMin - 15, snapped));
      } else {
        endMin = Math.max(current.startMin + 15, Math.min(nextStart, snapped));
      }

      current = { ...current, startMin, endMin };
      setBlockDrag({ ...current });
    };

    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
      const drag = current;
      setBlockDrag(null);
      if (!didMove) {
        onSlotClick(slot, ev.clientX, ev.clientY);
        const stopClick = (ce: Event) => { ce.stopPropagation(); document.removeEventListener('click', stopClick, true); };
        document.addEventListener('click', stopClick, true);
        return;
      }
      if (drag.startMin === drag.origStartMin && drag.endMin === drag.origEndMin) return;
      onSlotUpdate(slot.id, minutesToTime(drag.startMin), minutesToTime(Math.min(drag.endMin, 24 * 60 - 15)));
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  return (
    <div
      ref={ref}
      className={`relative ${isDraggingPlace ? 'cursor-copy' : ''}`}
      style={{ height: TOTAL_HEIGHT }}
      onMouseEnter={() => { const r = ref.current?.getBoundingClientRect(); if (r) onMouseEnter(r); }}
      onMouseLeave={onMouseLeave}
      onMouseMove={handleMouseMove}
    >
      {HOURS.map((h) => (
        <div key={h}      className="absolute left-0 right-0 border-t border-zinc-700/60" style={{ top: h * HOUR_HEIGHT }} />
      ))}
      {HOURS.map((h) => (
        <div key={`hh${h}`} className="absolute left-0 right-0 border-t border-zinc-700/30" style={{ top: h * HOUR_HEIGHT + HOUR_HEIGHT / 2 }} />
      ))}

      {slots.map((slot) => {
        const iv         = intervals.find((i) => i.id === slot.interval_id);
        const color      = iv?.color ?? '#818cf8';
        const isDragging = blockDrag?.slot.id === slot.id;
        const startMin   = isDragging ? blockDrag!.startMin : timeToMinutes(slot.start_time);
        const endMin     = isDragging ? blockDrag!.endMin   : timeToMinutes(slot.end_time);
        const top        = (startMin / (24 * 60)) * TOTAL_HEIGHT;
        const height     = Math.max(((endMin - startMin) / (24 * 60)) * TOTAL_HEIGHT, 20);
        const timeLabel  = `${minutesToTime(startMin)}–${minutesToTime(endMin >= 24 * 60 ? 0 : endMin)}`;

        return (
          <div
            key={slot.id}
            className={`absolute inset-x-0.5 rounded-md text-sm font-medium select-none ${isDragging ? 'opacity-60' : 'hover:brightness-110 cursor-grab'}`}
            style={{ top, height, backgroundColor: color + '33', borderLeft: `3px solid ${color}`, color }}
            onMouseDown={(e) => handleSlotMouseDown(e, slot, 'move')}
          >
            <div className="absolute top-0 left-0 right-0 h-2 cursor-ns-resize z-10"
              onMouseDown={(e) => { e.stopPropagation(); handleSlotMouseDown(e, slot, 'resize-start'); }} />
            <div className="absolute bottom-0 left-0 right-0 h-2 cursor-ns-resize z-10"
              onMouseDown={(e) => { e.stopPropagation(); handleSlotMouseDown(e, slot, 'resize-end'); }} />
            <div className="px-1.5 py-1 leading-tight overflow-hidden">
              <div className="font-semibold truncate">{iv?.name ?? '?'}</div>
              {height >= 40 && <div className="opacity-75 text-xs font-mono">{timeLabel}</div>}
            </div>
          </div>
        );
      })}

      {placeDragInterval && (
        <div
          ref={ghostRef}
          className="absolute inset-x-0.5 rounded-md text-sm font-medium pointer-events-none opacity-60"
          style={{
            display: isActiveTarget ? 'block' : 'none',
            top: 0, height: 20,
            backgroundColor: placeDragInterval.color + '33',
            borderLeft: `3px solid ${placeDragInterval.color}`,
            color: placeDragInterval.color,
          }}
        >
          <div className="px-1.5 py-1 leading-tight overflow-hidden">
            <div className="font-semibold truncate">{placeDragInterval.name}</div>
            <div data-ghost-time className="opacity-75 text-xs font-mono hidden" />
          </div>
        </div>
      )}
    </div>
  );
}

function IntervalCreatePopover({ startMin, endMin, x, y, onClose, onSave }: {
  startMin: number;
  endMin: number;
  x: number;
  y: number;
  onClose: () => void;
  onSave: (name: string, color: string) => void;
}) {
  const [name, setName]   = useState('');
  const [color, setColor] = useState(INTERVAL_COLORS[0]);
  const left = Math.min(x + 12, window.innerWidth  - 288);
  const top  = Math.min(y,      window.innerHeight - 340);

  return (
    <div
      className="fixed z-50 bg-zinc-900 border border-zinc-700/80 rounded-xl shadow-2xl w-72 overflow-hidden"
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <span className="text-sm font-medium text-zinc-200">New Interval</span>
        <button onClick={onClose} className="p-0.5 text-zinc-600 hover:text-zinc-300"><X className="w-3.5 h-3.5" /></button>
      </div>
      <div className="px-4 py-3 space-y-3">
        <div className="text-xs text-zinc-400 font-mono">
          {minutesToTime(startMin)} – {minutesToTime(endMin >= 24 * 60 ? 0 : endMin)} (default)
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Name</label>
          <input
            autoFocus
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onSave(name.trim(), color); }}
            className="w-full px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
            placeholder="Prime Time"
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1.5">Color</label>
          <div className="flex flex-wrap gap-1.5">
            {INTERVAL_COLORS.map((c) => (
              <button
                key={c}
                className={`w-5 h-5 rounded-full border-2 transition-transform ${color === c ? 'border-white scale-110' : 'border-transparent'}`}
                style={{ backgroundColor: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 py-1.5 text-xs text-zinc-400 border border-zinc-700 rounded-lg hover:border-zinc-500 transition-colors">Cancel</button>
          <button
            onClick={() => { if (name.trim()) onSave(name.trim(), color); }}
            disabled={!name.trim()}
            className="flex-1 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg disabled:opacity-40 transition-colors"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

function IntervalEditPopover({ interval, x, y, onClose, onSave, onDelete }: {
  interval: BroadcastInterval;
  x: number;
  y: number;
  onClose: () => void;
  onSave: (patch: BroadcastIntervalPatch) => void;
  onDelete: () => void;
}) {
  const [name,      setName]      = useState(interval.name);
  const [color,     setColor]     = useState(interval.color);
  const [startTime, setStartTime] = useState(interval.default_start_time);
  const [endTime,   setEndTime]   = useState(interval.default_end_time);
  const left = Math.min(x + 12, window.innerWidth  - 288);
  const top  = Math.min(y,      window.innerHeight - 440);

  return (
    <div
      className="fixed z-50 bg-zinc-900 border border-zinc-700/80 rounded-xl shadow-2xl w-72 overflow-hidden"
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <span className="text-sm font-medium text-zinc-200">Edit Interval</span>
        <button onClick={onClose} className="p-0.5 text-zinc-600 hover:text-zinc-300"><X className="w-3.5 h-3.5" /></button>
      </div>
      <div className="px-4 py-3 space-y-3">
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Name</label>
          <input
            autoFocus
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Default start</label>
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Default end</label>
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1.5">Color</label>
          <div className="flex flex-wrap gap-1.5">
            {INTERVAL_COLORS.map((c) => (
              <button
                key={c}
                className={`w-5 h-5 rounded-full border-2 transition-transform ${color === c ? 'border-white scale-110' : 'border-transparent'}`}
                style={{ backgroundColor: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onDelete} className="p-1.5 text-zinc-500 hover:text-red-400 border border-zinc-700 hover:border-zinc-600 rounded-lg transition-colors">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <button onClick={onClose} className="flex-1 py-1.5 text-xs text-zinc-400 border border-zinc-700 rounded-lg hover:border-zinc-500 transition-colors">Cancel</button>
          <button
            onClick={() => { if (name.trim()) onSave({ name: name.trim(), color, default_start_time: startTime, default_end_time: endTime }); }}
            disabled={!name.trim()}
            className="flex-1 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg disabled:opacity-40 transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function SlotDeletePopover({ slot, intervalName, intervalColor, x, y, onClose, onDelete }: {
  slot: BroadcastIntervalSlot;
  intervalName: string;
  intervalColor: string;
  x: number;
  y: number;
  onClose: () => void;
  onDelete: () => void;
}) {
  const left = Math.min(x + 12, window.innerWidth  - 256);
  const top  = Math.min(y,      window.innerHeight - 160);

  return (
    <div
      className="fixed z-50 bg-zinc-900 border border-zinc-700/80 rounded-xl shadow-2xl w-56 overflow-hidden"
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-4 py-3 space-y-3">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: intervalColor }} />
          <span className="text-sm font-medium text-zinc-200">{intervalName}</span>
        </div>
        <div className="text-xs text-zinc-400 font-mono">{slot.start_time} – {slot.end_time}</div>
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-1.5 text-xs text-zinc-400 border border-zinc-700 rounded-lg hover:border-zinc-500 transition-colors">Cancel</button>
          <button
            onClick={onDelete}
            className="flex-1 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-500 rounded-lg transition-colors"
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Shared sub-components ────────────────────────────────────────────────────

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-zinc-500 flex-shrink-0">{label}</span>
      <span className={`text-xs text-zinc-200 text-right truncate ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}
