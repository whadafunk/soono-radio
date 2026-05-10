import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader, Plus, X, Search, Music, Check } from 'lucide-react';
import { CampaignMediaWithMedia } from '@radio/shared';
import {
  fetchCampaignMedia,
  addCampaignMedia,
  updateCampaignMedia,
  removeCampaignMedia,
  fetchLibrary,
  LibraryListResponse,
  CampaignMediaAdd,
} from '../../api';

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function SweepToggle({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}) {
  const active = 'bg-indigo-600/20 border-indigo-600 text-indigo-200';
  const inactive = 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-200';
  return (
    <div className="flex text-xs font-medium">
      <button
        type="button"
        onClick={() => onChange(false)}
        disabled={disabled}
        className={`px-2.5 py-1 border rounded-l-md transition-colors disabled:opacity-50 ${!value ? active : inactive}`}
      >
        Standalone
      </button>
      <button
        type="button"
        onClick={() => onChange(true)}
        disabled={disabled}
        className={`px-2.5 py-1 border-t border-b border-r rounded-r-md transition-colors disabled:opacity-50 ${value ? active : inactive}`}
      >
        Sweep
      </button>
    </div>
  );
}

function MediaClipRow({
  item,
  showSweepToggle,
  onToggleSweep,
  onRemove,
  isPending,
}: {
  item: CampaignMediaWithMedia;
  showSweepToggle: boolean;
  onToggleSweep: (id: number, sweep: boolean) => void;
  onRemove: (id: number) => void;
  isPending: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-zinc-800/50 border border-zinc-700/50 rounded-lg">
      <Music className="w-4 h-4 text-zinc-500 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-zinc-200 truncate">
          {item.title ?? <span className="text-zinc-500 italic">Untitled</span>}
        </p>
        {item.artist && (
          <p className="text-xs text-zinc-500 truncate">{item.artist}</p>
        )}
      </div>
      <span className="text-xs text-zinc-500 font-mono flex-shrink-0 w-10 text-right">
        {formatDuration(item.duration_seconds ?? 0)}
      </span>
      {showSweepToggle && (
        <SweepToggle
          value={item.play_as_sweep}
          onChange={(v) => onToggleSweep(item.id, v)}
          disabled={isPending}
        />
      )}
      <button
        type="button"
        onClick={() => onRemove(item.id)}
        disabled={isPending}
        className="p-1 text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-50 flex-shrink-0"
        title="Remove"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

function LibraryPickerModal({
  clips,
  onAdd,
  onRemove,
  onClose,
  isPending,
}: {
  clips: CampaignMediaWithMedia[];
  onAdd: (data: CampaignMediaAdd) => void;
  onRemove: (attachmentId: number) => void;
  onClose: () => void;
  isPending: boolean;
}) {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  const { data, isLoading } = useQuery<LibraryListResponse>({
    queryKey: ['library-picker', debouncedQ],
    queryFn: () =>
      fetchLibrary({
        q: debouncedQ || undefined,
        category: 'spot',
        sort: 'created_at',
        order: 'desc',
        limit: 40,
        offset: 0,
      }),
  });

  const attachedByMediaId = new Map(clips.map((c) => [c.media_id, c.id]));
  const items = data?.items ?? [];

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-6 bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-zinc-900 border border-zinc-700 rounded-xl flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 p-4 border-b border-zinc-800">
          <Search className="w-4 h-4 text-zinc-500 flex-shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search spots…"
            className="flex-1 bg-transparent text-white placeholder-zinc-500 text-sm focus:outline-none"
          />
          {isLoading && <Loader className="w-4 h-4 animate-spin text-zinc-500" />}
          <button onClick={onClose} className="p-1 text-zinc-500 hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-zinc-800/60">
          {items.length === 0 && !isLoading && (
            <p className="text-zinc-500 text-sm p-6 text-center">No spots found.</p>
          )}
          {items.map((media) => {
            const attachmentId = attachedByMediaId.get(media.id);
            const isAttached = attachmentId !== undefined;
            return (
              <button
                key={media.id}
                type="button"
                disabled={isPending}
                onClick={() => {
                  if (isAttached) {
                    onRemove(attachmentId);
                  } else {
                    onAdd({
                      media_id: media.id,
                      play_as_sweep: false,
                      title: media.title,
                      artist: media.artist,
                      duration_seconds: media.duration_seconds,
                      original_filename: media.original_filename,
                    });
                  }
                }}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors disabled:opacity-50 ${
                  isAttached
                    ? 'bg-indigo-600/10 hover:bg-indigo-600/20'
                    : 'hover:bg-zinc-800/60'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-200 truncate">
                    {media.title ?? (
                      <span className="italic text-zinc-500">{media.original_filename}</span>
                    )}
                  </p>
                  {media.artist && (
                    <p className="text-xs text-zinc-500 truncate">{media.artist}</p>
                  )}
                </div>
                <span className="text-xs text-zinc-500 font-mono flex-shrink-0 w-10 text-right">
                  {formatDuration(media.duration_seconds)}
                </span>
                <span className={`flex items-center gap-1 text-xs flex-shrink-0 w-20 justify-end ${isAttached ? 'text-indigo-400' : 'text-zinc-600'}`}>
                  {isAttached ? (
                    <><Check className="w-3.5 h-3.5" /> Added</>
                  ) : (
                    <><Plus className="w-3.5 h-3.5" /> Add</>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        <div className="px-4 py-3 border-t border-zinc-800 text-xs text-zinc-500">
          Click a spot to add or remove it. Close when done.
        </div>
      </div>
    </div>
  );
}

export function CampaignMediaSection({
  campaignId,
  sweepsPerMonth,
}: {
  campaignId: number;
  sweepsPerMonth: number | null | undefined;
}) {
  const queryClient = useQueryClient();
  const [showPicker, setShowPicker] = useState(false);

  const { data: clips = [], isLoading } = useQuery<CampaignMediaWithMedia[]>({
    queryKey: ['campaign-media', campaignId],
    queryFn: () => fetchCampaignMedia(campaignId),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['campaign-media', campaignId] });

  const addMutation = useMutation({
    mutationFn: (data: CampaignMediaAdd) => addCampaignMedia(campaignId, data),
    onSuccess: invalidate,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, play_as_sweep }: { id: number; play_as_sweep: boolean }) =>
      updateCampaignMedia(id, { play_as_sweep }),
    onSuccess: invalidate,
  });

  const removeMutation = useMutation({
    mutationFn: (id: number) => removeCampaignMedia(id),
    onSuccess: invalidate,
  });

  const isPending =
    addMutation.isPending || toggleMutation.isPending || removeMutation.isPending;

  const hasSweeps = !!sweepsPerMonth;
  const sweepClipCount = clips.filter((c) => c.play_as_sweep).length;
  const showSweepWarning = !hasSweeps && sweepClipCount > 0;

  return (
    <>
      <div className="space-y-2">
        {showSweepWarning && (
          <div className="flex items-start gap-2 px-3 py-2 bg-amber-900/20 border border-amber-800/50 rounded-lg text-amber-300 text-xs">
            <span className="flex-shrink-0 mt-0.5">⚠</span>
            <span>
              {sweepClipCount} clip{sweepClipCount !== 1 ? 's' : ''} set as Sweep will be removed when you save.
            </span>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-4">
            <Loader className="w-4 h-4 animate-spin text-zinc-500" />
          </div>
        ) : clips.length === 0 ? (
          <p className="text-sm text-zinc-500 py-1">No clips attached yet.</p>
        ) : (
          clips.map((item) => (
            <MediaClipRow
              key={item.id}
              item={item}
              showSweepToggle={hasSweeps}
              onToggleSweep={(id, sweep) => toggleMutation.mutate({ id, play_as_sweep: sweep })}
              onRemove={(id) => removeMutation.mutate(id)}
              isPending={isPending}
            />
          ))
        )}

        <button
          type="button"
          onClick={() => setShowPicker(true)}
          disabled={isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 rounded-lg transition-colors disabled:opacity-50"
        >
          <Plus className="w-3.5 h-3.5" />
          Add clip
        </button>
      </div>

      {showPicker && (
        <LibraryPickerModal
          clips={clips}
          onAdd={(data) => addMutation.mutate(data)}
          onRemove={(id) => removeMutation.mutate(id)}
          onClose={() => setShowPicker(false)}
          isPending={isPending}
        />
      )}
    </>
  );
}
