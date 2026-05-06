import { useState, useId } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Plus, GripVertical, Trash2, Pencil, Check, X, Clock } from 'lucide-react';
import { Clock as ClockType, ClockSegment, ClockSegmentType, CLOCK_SEGMENT_TYPES } from '@radio/shared';
import { fetchClocks, createClock, updateClock, deleteClock } from '../../api';

// ─── Segment metadata ─────────────────────────────────────────────────────────

const SEGMENT_META: Record<ClockSegmentType, { label: string; color: string; bg: string; border: string; text: string }> = {
  music:   { label: 'Music',   color: '#6366f1', bg: 'bg-indigo-500/15',  border: 'border-indigo-500/40',  text: 'text-indigo-300'  },
  ad:      { label: 'Ad',      color: '#f59e0b', bg: 'bg-amber-500/15',   border: 'border-amber-500/40',   text: 'text-amber-300'   },
  jingle:  { label: 'Jingle',  color: '#14b8a6', bg: 'bg-teal-500/15',    border: 'border-teal-500/40',    text: 'text-teal-300'    },
  news:    { label: 'News',    color: '#f43f5e', bg: 'bg-rose-500/15',    border: 'border-rose-500/40',    text: 'text-rose-300'    },
  live:    { label: 'Live',    color: '#10b981', bg: 'bg-emerald-500/15', border: 'border-emerald-500/40', text: 'text-emerald-300' },
  promo:   { label: 'Promo',   color: '#8b5cf6', bg: 'bg-violet-500/15',  border: 'border-violet-500/40',  text: 'text-violet-300'  },
  silence: { label: 'Silence', color: '#71717a', bg: 'bg-zinc-500/10',    border: 'border-zinc-500/40',    text: 'text-zinc-400'    },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function totalMinutes(segments: ClockSegment[]): number {
  return segments.reduce((acc, s) => acc + s.duration_minutes, 0);
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function ClocksPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<ClockType | null>(null); // working copy
  const [dirty, setDirty] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  };

  const { data: clocks = [] } = useQuery({ queryKey: ['clocks'], queryFn: fetchClocks });

  const saveMutation = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Partial<ClockType> }) =>
      updateClock(id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clocks'] });
      setDirty(false);
      showToast('success', 'Clock saved');
    },
    onError: (e) => showToast('error', (e as Error).message),
  });

  const createMutation = useMutation({
    mutationFn: createClock,
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['clocks'] });
      setCreatingNew(false);
      setNewName('');
      selectClock(created);
      showToast('success', 'Clock created');
    },
    onError: (e) => showToast('error', (e as Error).message),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteClock,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clocks'] });
      setSelectedId(null);
      setDraft(null);
      setDirty(false);
      setConfirmDelete(false);
      showToast('success', 'Clock deleted');
    },
    onError: (e) => showToast('error', (e as Error).message),
  });

  const selectClock = (clock: ClockType) => {
    setSelectedId(clock.id);
    setDraft(JSON.parse(JSON.stringify(clock))); // deep copy
    setDirty(false);
    setConfirmDelete(false);
  };

  const updateDraft = (updater: (c: ClockType) => ClockType) => {
    setDraft((prev) => prev ? updater(prev) : prev);
    setDirty(true);
  };

  const handleSave = () => {
    if (!draft) return;
    saveMutation.mutate({ id: draft.id, patch: { name: draft.name, description: draft.description, segments: draft.segments } });
  };

  const handleDiscard = () => {
    const original = clocks.find((c) => c.id === selectedId);
    if (original) { setDraft(JSON.parse(JSON.stringify(original))); setDirty(false); }
  };

  const handleSegmentReorder = (oldIndex: number, newIndex: number) => {
    updateDraft((c) => ({ ...c, segments: arrayMove(c.segments, oldIndex, newIndex) }));
  };

  const handleAddSegment = (type: ClockSegmentType) => {
    updateDraft((c) => ({
      ...c,
      segments: [...c.segments, { id: makeId(), type, duration_minutes: type === 'jingle' ? 1 : type === 'ad' ? 3 : 8, label: null }],
    }));
  };

  const handleUpdateSegment = (id: string, patch: Partial<ClockSegment>) => {
    updateDraft((c) => ({ ...c, segments: c.segments.map((s) => s.id === id ? { ...s, ...patch } : s) }));
  };

  const handleDeleteSegment = (id: string) => {
    updateDraft((c) => ({ ...c, segments: c.segments.filter((s) => s.id !== id) }));
  };

  const selected = draft;
  const total = selected ? totalMinutes(selected.segments) : 0;
  const overflow = total > 60;

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">Clocks</h1>
          <p className="text-zinc-400 mt-1 text-sm">Build reusable hour templates — drag segments to reorder.</p>
        </div>
      </div>

      {toast && (
        <div className={`flex-shrink-0 px-4 py-2.5 rounded-lg text-sm ${toast.type === 'success' ? 'bg-green-900/20 border border-green-800 text-green-300' : 'bg-red-900/20 border border-red-800 text-red-300'}`}>
          {toast.message}
        </div>
      )}

      <div className="flex-1 min-h-0 flex gap-4">
        {/* Left: clock list */}
        <div className="w-56 flex-shrink-0 flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Clocks</span>
            <button
              onClick={() => setCreatingNew(true)}
              className="p-1 text-zinc-400 hover:text-white hover:bg-zinc-700 rounded transition-colors"
              title="New clock"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

          {creatingNew && (
            <div className="px-3 py-2 border-b border-zinc-800 flex gap-1.5">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newName.trim()) createMutation.mutate({ name: newName.trim(), segments: [] });
                  if (e.key === 'Escape') { setCreatingNew(false); setNewName(''); }
                }}
                placeholder="Clock name…"
                className="flex-1 min-w-0 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
              />
              <button
                onClick={() => newName.trim() && createMutation.mutate({ name: newName.trim(), segments: [] })}
                className="p-1 text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                <Check className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => { setCreatingNew(false); setNewName(''); }} className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <div className="flex-1 overflow-auto">
            {clocks.length === 0 && !creatingNew && (
              <p className="px-4 py-6 text-xs text-zinc-400 text-center">No clocks yet.<br />Create one to get started.</p>
            )}
            {clocks.map((clock) => {
              const mins = totalMinutes(clock.segments);
              const isSelected = clock.id === selectedId;
              return (
                <button
                  key={clock.id}
                  onClick={() => selectClock(clock)}
                  className={`w-full text-left px-4 py-3 border-b border-zinc-800/60 transition-colors ${
                    isSelected ? 'bg-indigo-600/20 border-l-2 border-l-indigo-500' : 'hover:bg-zinc-800/50'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Clock className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
                    <span className="text-sm font-medium text-white truncate">{clock.name}</span>
                  </div>
                  <div className="flex gap-2 mt-1 ml-5">
                    <span className={`text-xs ${mins > 60 ? 'text-red-400' : 'text-zinc-400'}`}>{mins} min</span>
                    <span className="text-xs text-zinc-400">· {clock.segments.length} seg</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Right: editor */}
        {selected ? (
          <div className="flex-1 min-w-0 flex flex-col gap-4">
            {/* Clock header */}
            <div className="flex-shrink-0 flex items-start gap-3 bg-zinc-900 border border-zinc-800 rounded-lg px-5 py-4">
              <div className="flex-1 min-w-0">
                <input
                  value={selected.name}
                  onChange={(e) => updateDraft((c) => ({ ...c, name: e.target.value }))}
                  className="text-lg font-semibold text-white bg-transparent border-b border-transparent hover:border-zinc-700 focus:border-indigo-500 focus:outline-none w-full transition-colors pb-0.5"
                />
                <input
                  value={selected.description ?? ''}
                  onChange={(e) => updateDraft((c) => ({ ...c, description: e.target.value || null }))}
                  placeholder="Add a description…"
                  className="mt-1 text-sm text-zinc-300 bg-transparent border-b border-transparent hover:border-zinc-700 focus:border-indigo-500 focus:outline-none w-full transition-colors pb-0.5 placeholder:text-zinc-500"
                />
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {dirty && (
                  <>
                    <button onClick={handleDiscard} className="px-3 py-1.5 text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors">
                      Discard
                    </button>
                    <button onClick={handleSave} disabled={saveMutation.isPending} className="px-3 py-1.5 text-xs text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors disabled:opacity-50">
                      {saveMutation.isPending ? 'Saving…' : 'Save'}
                    </button>
                  </>
                )}
                {!dirty && !confirmDelete && (
                  <button onClick={() => setConfirmDelete(true)} className="p-1.5 text-zinc-400 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors" title="Delete clock">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
                {confirmDelete && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-400">Delete?</span>
                    <button onClick={() => deleteMutation.mutate(selected.id)} disabled={deleteMutation.isPending} className="px-2.5 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition-colors">Yes</button>
                    <button onClick={() => setConfirmDelete(false)} className="px-2.5 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-white rounded transition-colors">Cancel</button>
                  </div>
                )}
              </div>
            </div>

            {/* Timeline */}
            <ClockTimeline segments={selected.segments} total={total} overflow={overflow} />

            {/* Segment list */}
            <div className="flex-1 min-h-0 flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
              <div className="px-5 py-3 border-b border-zinc-800 flex items-center justify-between flex-shrink-0">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Segments</span>
                  <span className={`text-xs font-mono px-2 py-0.5 rounded ${overflow ? 'bg-red-900/30 text-red-400' : 'bg-zinc-800 text-zinc-400'}`}>
                    {total} / 60 min{overflow ? ' — over by ' + (total - 60) : ''}
                  </span>
                </div>
                {/* Add segment buttons */}
                <div className="flex flex-wrap gap-1 justify-end">
                  {CLOCK_SEGMENT_TYPES.map((type) => {
                    const meta = SEGMENT_META[type];
                    return (
                      <button
                        key={type}
                        onClick={() => handleAddSegment(type)}
                        className={`px-2.5 py-1 text-xs rounded border transition-colors ${meta.bg} ${meta.border} ${meta.text} hover:brightness-125`}
                      >
                        + {meta.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex-1 overflow-auto">
                <SegmentList
                  segments={selected.segments}
                  onReorder={handleSegmentReorder}
                  onUpdate={handleUpdateSegment}
                  onDelete={handleDeleteSegment}
                />
                {selected.segments.length === 0 && (
                  <div className="px-5 py-10 text-center text-zinc-400 text-sm">
                    No segments yet — use the buttons above to add music, ads, jingles, and more.
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center bg-zinc-900 border border-zinc-800 rounded-lg">
            <p className="text-zinc-400 text-sm">Select a clock to edit it</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Timeline visualization ───────────────────────────────────────────────────

function ClockTimeline({ segments, total, overflow }: { segments: ClockSegment[]; total: number; overflow: boolean }) {
  const cap = Math.max(total, 60);
  return (
    <div className="flex-shrink-0 bg-zinc-900 border border-zinc-800 rounded-lg px-5 py-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Hour overview</span>
        <span className="text-xs text-zinc-400 font-mono">60 min</span>
      </div>
      {/* Bar */}
      <div className="relative h-10 flex rounded overflow-hidden bg-zinc-800">
        {segments.map((seg) => {
          const meta = SEGMENT_META[seg.type];
          const widthPct = (seg.duration_minutes / cap) * 100;
          return (
            <div
              key={seg.id}
              className="flex items-center justify-center overflow-hidden transition-all duration-150 border-r border-zinc-900/50 last:border-r-0"
              style={{ width: `${widthPct}%`, backgroundColor: meta.color + '33' }}
              title={`${seg.label ?? meta.label} · ${seg.duration_minutes} min`}
            >
              {seg.duration_minutes >= 4 && (
                <span className="text-xs font-medium truncate px-1" style={{ color: meta.color }}>
                  {seg.duration_minutes >= 8 ? (seg.label ?? meta.label) : `${seg.duration_minutes}m`}
                </span>
              )}
            </div>
          );
        })}
        {/* Remaining fill if under 60 */}
        {total < 60 && (
          <div
            className="flex items-center justify-center"
            style={{ width: `${((60 - total) / 60) * 100}%` }}
          >
            <span className="text-xs text-zinc-400">{60 - total}m free</span>
          </div>
        )}
      </div>
      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3">
        {CLOCK_SEGMENT_TYPES.filter((t) => segments.some((s) => s.type === t)).map((type) => {
          const meta = SEGMENT_META[type];
          const mins = segments.filter((s) => s.type === type).reduce((a, s) => a + s.duration_minutes, 0);
          return (
            <div key={type} className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: meta.color + '88' }} />
              <span className="text-xs text-zinc-300">{meta.label}</span>
              <span className="text-xs text-zinc-400 font-mono">{mins}m</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Sortable segment list ────────────────────────────────────────────────────

function SegmentList({
  segments,
  onReorder,
  onUpdate,
  onDelete,
}: {
  segments: ClockSegment[];
  onReorder: (oldIndex: number, newIndex: number) => void;
  onUpdate: (id: string, patch: Partial<ClockSegment>) => void;
  onDelete: (id: string) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = segments.findIndex((s) => s.id === active.id);
    const newIndex = segments.findIndex((s) => s.id === over.id);
    if (oldIndex !== -1 && newIndex !== -1) onReorder(oldIndex, newIndex);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={segments.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-zinc-900 border-b border-zinc-800">
            <tr>
              <th className="w-8" />
              <th className="py-2 px-4 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider w-24">Type</th>
              <th className="py-2 px-4 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider">Label</th>
              <th className="py-2 px-4 text-right text-xs font-medium text-zinc-400 uppercase tracking-wider w-28">Duration</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {segments.map((seg) => (
              <SortableSegmentRow
                key={seg.id}
                segment={seg}
                onUpdate={onUpdate}
                onDelete={onDelete}
              />
            ))}
          </tbody>
        </table>
      </SortableContext>
    </DndContext>
  );
}

function SortableSegmentRow({
  segment,
  onUpdate,
  onDelete,
}: {
  segment: ClockSegment;
  onUpdate: (id: string, patch: Partial<ClockSegment>) => void;
  onDelete: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: segment.id });
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelValue, setLabelValue] = useState(segment.label ?? '');
  const meta = SEGMENT_META[segment.type];

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  const commitLabel = () => {
    onUpdate(segment.id, { label: labelValue.trim() || null });
    setEditingLabel(false);
  };

  return (
    <tr ref={setNodeRef} style={style} className="border-b border-zinc-800/60 hover:bg-zinc-800/30 group">
      {/* Drag handle */}
      <td className="pl-3 pr-1 py-2.5 w-8">
        <button
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing text-zinc-500 hover:text-zinc-200 transition-colors touch-none"
        >
          <GripVertical className="w-4 h-4" />
        </button>
      </td>

      {/* Type */}
      <td className="px-4 py-2.5">
        <select
          value={segment.type}
          onChange={(e) => onUpdate(segment.id, { type: e.target.value as ClockSegmentType })}
          className={`text-xs px-2 py-1 rounded border bg-transparent cursor-pointer focus:outline-none ${meta.border} ${meta.text}`}
        >
          {CLOCK_SEGMENT_TYPES.map((t) => (
            <option key={t} value={t} className="bg-zinc-900 text-white">{SEGMENT_META[t].label}</option>
          ))}
        </select>
      </td>

      {/* Label */}
      <td className="px-4 py-2.5">
        {editingLabel ? (
          <input
            autoFocus
            value={labelValue}
            onChange={(e) => setLabelValue(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={(e) => { if (e.key === 'Enter') commitLabel(); if (e.key === 'Escape') setEditingLabel(false); }}
            placeholder={meta.label}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-sm text-white focus:outline-none focus:border-indigo-500"
          />
        ) : (
          <button
            onClick={() => { setLabelValue(segment.label ?? ''); setEditingLabel(true); }}
            className="text-sm text-left w-full"
          >
            {segment.label
              ? <span className="text-zinc-200">{segment.label}</span>
              : <span className="text-zinc-400 italic">{meta.label}</span>
            }
          </button>
        )}
      </td>

      {/* Duration */}
      <td className="px-4 py-2.5 text-right">
        <div className="flex items-center justify-end gap-1.5">
          <button
            onClick={() => onUpdate(segment.id, { duration_minutes: Math.max(1, segment.duration_minutes - 1) })}
            className="w-5 h-5 flex items-center justify-center rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white transition-colors text-xs font-bold"
          >−</button>
          <input
            type="number"
            min={1}
            max={59}
            value={segment.duration_minutes}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!isNaN(v) && v >= 1 && v <= 59) onUpdate(segment.id, { duration_minutes: v });
            }}
            className="w-10 text-center bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500 py-0.5"
          />
          <button
            onClick={() => onUpdate(segment.id, { duration_minutes: Math.min(59, segment.duration_minutes + 1) })}
            className="w-5 h-5 flex items-center justify-center rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white transition-colors text-xs font-bold"
          >+</button>
          <span className="text-xs text-zinc-400 w-7 text-left">min</span>
        </div>
      </td>

      {/* Delete */}
      <td className="pr-3 py-2.5 w-10">
        <button
          onClick={() => onDelete(segment.id)}
          className="p-1 text-zinc-400 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors opacity-0 group-hover:opacity-100"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </td>
    </tr>
  );
}
