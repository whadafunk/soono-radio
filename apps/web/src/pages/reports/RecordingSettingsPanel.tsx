import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RecordingSettingsSchema, type RecordingSettings } from '@soono/shared';
import { apiErrorMessage, fetchRecordingSettings, updateRecordingSettings } from '../../api';

const FIELD_LABELS: Record<keyof RecordingSettings, string> = {
  retention_days: 'Keep recordings for',
  min_free_gb: 'Free disk floor',
  protected_days: 'Never delete anything younger than',
};

// Null-safe: react-hook-form also runs setValueAs on defaults (CLAUDE.md).
const asNumber = (v: unknown) => (v === '' || v == null ? Number.NaN : Number(v));

// Retention settings — they take effect at the next sweep, no restart.
// Recording quality and file length live with the Mix Engine settings because
// changing them restarts the Mix Engine.
export function RecordingSettingsPanel() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['recording-settings'], queryFn: fetchRecordingSettings });
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  const { register, handleSubmit, reset } = useForm<RecordingSettings>({ resolver: zodResolver(RecordingSettingsSchema) });
  useEffect(() => { if (data) reset(data); }, [data, reset]);

  const mutation = useMutation({
    mutationFn: updateRecordingSettings,
    onSuccess: (next) => {
      queryClient.setQueryData(['recording-settings'], next);
      setProblems([]);
      setSaved(true);
      setTimeout(() => setSaved(false), 4000);
    },
    onError: (err) => setProblems([apiErrorMessage(err)]),
  });

  const inputClass = 'w-24 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white';

  return (
    <form
      className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-4"
      onSubmit={handleSubmit(
        (values) => { setProblems([]); mutation.mutate(values); },
        // Every validation failure is shown next to Save — a submit that does
        // nothing with no message is a bug.
        (errors) => setProblems(
          (Object.keys(errors) as Array<keyof RecordingSettings>).map((k) => `${FIELD_LABELS[k] ?? k}: ${errors[k]?.message ?? 'invalid'}`),
        ),
      )}
    >
      <h2 className="text-sm font-semibold text-zinc-200">Retention</h2>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="text-sm text-zinc-300">
          <span className="block mb-1">{FIELD_LABELS.retention_days}</span>
          <input type="number" min={1} step={1} {...register('retention_days', { setValueAs: asNumber })} className={inputClass} /> days
          <span className="block text-xs text-zinc-400 mt-1">Older recordings are deleted automatically.</span>
        </label>
        <label className="text-sm text-zinc-300">
          <span className="block mb-1">{FIELD_LABELS.min_free_gb}</span>
          <input type="number" min={0} step={1} {...register('min_free_gb', { setValueAs: asNumber })} className={inputClass} /> GB
          <span className="block text-xs text-zinc-400 mt-1">Below this, the oldest recordings are deleted first.</span>
        </label>
        <label className="text-sm text-zinc-300">
          <span className="block mb-1">{FIELD_LABELS.protected_days}</span>
          <input type="number" min={0} step={1} {...register('protected_days', { setValueAs: asNumber })} className={inputClass} /> days
          <span className="block text-xs text-zinc-400 mt-1">The disk floor never crosses this age; it warns instead.</span>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={mutation.isPending} className="px-3 py-1.5 bg-brand-600 hover:bg-brand-500 text-white rounded text-sm disabled:opacity-40">
          {mutation.isPending ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-sm text-emerald-400">Saved — applies at the next hourly sweep.</span>}
        {problems.length > 0 && <span className="text-sm text-red-400">{problems.join(' · ')}</span>}
      </div>
      <p className="text-xs text-zinc-400">
        Recording quality and file length are set in{' '}
        <Link to="/settings/liquidsoap" className="text-brand-400 hover:text-brand-300 underline">Settings → Mix Engine → Recording</Link>.
      </p>
    </form>
  );
}
