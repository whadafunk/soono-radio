import { useState, useEffect, useMemo, Fragment, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, X, Trash2, RotateCcw, Clock, Pencil, Mic, AlertTriangle } from 'lucide-react';
import { Show, ShowColor, TemplateEntry, CalendarEntry, Clock as ClockType } from '@radio/shared';
import {
  fetchShows, fetchTemplateEntries,
  createTemplateEntry, updateTemplateEntry, deleteTemplateEntry,
  fetchCalendarEntries, createCalendarEntry, updateCalendarEntry, deleteCalendarEntry,
  fetchClocks,
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

type Mode = 'template' | 'calendar';

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
        endMin = Math.max(current.startMin + 15, Math.min(24 * 60, snapMin(clamped)));
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
          {(['template', 'calendar'] as Mode[]).map((m) => (
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

      {/* ── Grid wrapper ── */}
      {/* No overflow-hidden here — it would break sticky positioning on the header */}
      <div className={`rounded-xl border-4 flex flex-col ${
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
      </div>

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
        const ovn  = isOvernightEntry(entry.time_start, entry.time_end);
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
        const ovn  = isOvernightEntry(entry.time_start, entry.time_end);
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
        const ovn  = isOvernightEntry(entry.time_start, entry.time_end);
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

// ─── Shared sub-components ────────────────────────────────────────────────────

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-zinc-500 flex-shrink-0">{label}</span>
      <span className={`text-xs text-zinc-200 text-right truncate ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}
