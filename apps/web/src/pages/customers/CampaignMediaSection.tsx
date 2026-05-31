import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader, Plus, X, Search, Music, Check } from 'lucide-react';
import { CampaignMediaWithMedia } from '@soono/shared';
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

function SpotSweepPills({
  playAsSpot,
  playAsSweep,
  showSweep,
  onChange,
  disabled,
}: {
  playAsSpot: boolean;
  playAsSweep: boolean;
  showSweep: boolean;
  onChange: (spot: boolean, sweep: boolean) => void;
  disabled: boolean;
}) {
  const active = 'bg-brand-600/20 border-brand-600 text-brand-200';
  const inactive = 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-200';

  function toggle(kind: 'spot' | 'sweep') {
    if (kind === 'spot') {
      const next = !playAsSpot;
      if (!next && !playAsSweep) return; // must keep at least one
      onChange(next, playAsSweep);
    } else {
      const next = !playAsSweep;
      if (!next && !playAsSpot) return;
      onChange(playAsSpot, next);
    }
  }

  return (
    <div className="flex gap-1 text-xs font-medium">
      <button
        type="button"
        onClick={() => toggle('spot')}
        disabled={disabled}
        className={`px-2.5 py-1 border rounded-md transition-colors disabled:opacity-50 ${playAsSpot ? active : inactive}`}
      >
        Spot
      </button>
      {showSweep && (
        <button
          type="button"
          onClick={() => toggle('sweep')}
          disabled={disabled}
          className={`px-2.5 py-1 border rounded-md transition-colors disabled:opacity-50 ${playAsSweep ? active : inactive}`}
        >
          Sweep
        </button>
      )}
    </div>
  );
}

function MediaClipRow({
  item,
  hasSweeps,
  onToggle,
  onRemove,
  isPending,
}: {
  item: CampaignMediaWithMedia;
  hasSweeps: boolean;
  onToggle: (id: number, spot: boolean, sweep: boolean) => void;
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
      <SpotSweepPills
        playAsSpot={item.play_as_spot}
        playAsSweep={item.play_as_sweep}
        showSweep={hasSweeps}
        onChange={(spot, sweep) => onToggle(item.id, spot, sweep)}
        disabled={isPending}
      />
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
  durationBracket,
}: {
  clips: CampaignMediaWithMedia[];
  onAdd: (data: CampaignMediaAdd) => void;
  onRemove: (attachmentId: number) => void;
  onClose: () => void;
  isPending: boolean;
  durationBracket: number | null | undefined;
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
          {items.map((mediaItem) => {
            const attachmentId = attachedByMediaId.get(mediaItem.id);
            const isAttached = attachmentId !== undefined;
            const tooLong = !isAttached && durationBracket != null && (mediaItem.duration_seconds ?? 0) > durationBracket;
            return (
              <button
                key={mediaItem.id}
                type="button"
                disabled={isPending || tooLong}
                onClick={() => {
                  if (isAttached) {
                    onRemove(attachmentId);
                  } else {
                    onAdd({
                      media_id: mediaItem.id,
                      play_as_spot: true,
                      play_as_sweep: false,
                      title: mediaItem.title,
                      artist: mediaItem.artist,
                      duration_seconds: mediaItem.duration_seconds,
                      original_filename: mediaItem.original_filename,
                    });
                  }
                }}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors disabled:opacity-50 ${
                  isAttached
                    ? 'bg-brand-600/10 hover:bg-brand-600/20'
                    : tooLong
                    ? 'opacity-50 cursor-not-allowed'
                    : 'hover:bg-zinc-800/60'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-200 truncate">
                    {mediaItem.title ?? (
                      <span className="italic text-zinc-500">{mediaItem.original_filename}</span>
                    )}
                  </p>
                  {mediaItem.artist && (
                    <p className="text-xs text-zinc-500 truncate">{mediaItem.artist}</p>
                  )}
                </div>
                <span className="text-xs text-zinc-500 font-mono flex-shrink-0 w-10 text-right">
                  {formatDuration(mediaItem.duration_seconds)}
                </span>
                <span className={`flex items-center gap-1 text-xs flex-shrink-0 w-20 justify-end ${isAttached ? 'text-brand-400' : tooLong ? 'text-amber-500' : 'text-zinc-600'}`}>
                  {isAttached ? (
                    <><Check className="w-3.5 h-3.5" /> Added</>
                  ) : tooLong ? (
                    <>Too long ({mediaItem.duration_seconds}s)</>
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
  durationBracket,
}: {
  campaignId: number;
  sweepsPerMonth: number | null | undefined;
  durationBracket: number | null | undefined;
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
    mutationFn: ({ id, play_as_spot, play_as_sweep }: { id: number; play_as_spot: boolean; play_as_sweep: boolean }) =>
      updateCampaignMedia(id, { play_as_spot, play_as_sweep }),
    onSuccess: invalidate,
  });

  const removeMutation = useMutation({
    mutationFn: (id: number) => removeCampaignMedia(id),
    onSuccess: invalidate,
  });

  const isPending =
    addMutation.isPending || toggleMutation.isPending || removeMutation.isPending;

  const hasSweeps = !!sweepsPerMonth;

  // warn when sweeps are disabled but clips are still tagged sweep
  const sweepOnlyCount = clips.filter((c) => c.play_as_sweep && !c.play_as_spot).length;
  const bothTaggedCount = clips.filter((c) => c.play_as_sweep && c.play_as_spot).length;
  const showSweepWarning = !hasSweeps && (sweepOnlyCount > 0 || bothTaggedCount > 0);

  return (
    <>
      <div className="space-y-2">
        {showSweepWarning && (
          <div className="flex items-start gap-2 px-3 py-2 bg-amber-900/20 border border-amber-800/50 rounded-lg text-amber-300 text-xs">
            <span className="flex-shrink-0 mt-0.5">⚠</span>
            <span>
              Sweeps are disabled.
              {sweepOnlyCount > 0 && ` ${sweepOnlyCount} sweep-only clip${sweepOnlyCount !== 1 ? 's' : ''} will be removed.`}
              {bothTaggedCount > 0 && ` ${bothTaggedCount} clip${bothTaggedCount !== 1 ? 's' : ''} tagged for both will be demoted to spot-only.`}
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
              hasSweeps={hasSweeps}
              onToggle={(id, spot, sweep) => toggleMutation.mutate({ id, play_as_spot: spot, play_as_sweep: sweep })}
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
          durationBracket={durationBracket}
        />
      )}
    </>
  );
}
