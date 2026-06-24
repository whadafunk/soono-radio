import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Loader, UploadCloud, Check, AlertCircle, X,
  Music, Bell, Sparkles, Tag, Megaphone, Waves, Mic, Trash2,
} from 'lucide-react';
import { MEDIA_CATEGORIES, MediaCategory, IngestJob } from '@soono/shared';
import { fetchIngestJobs, clearIngestJobs, uploadLibraryFiles } from '../../api';

const CATEGORY_LABELS: Record<MediaCategory, string> = {
  music:     'Music',
  jingle:    'Jingle',
  envelope:   'Envelope',
  spot:      'Spot',
  promo:     'Promo',
  bed:       'Bed',
  recording: 'Recording',
};

const CATEGORY_ICONS: Record<MediaCategory, React.ElementType> = {
  music:     Music,
  jingle:    Bell,
  envelope:   Sparkles,
  spot:      Tag,
  promo:     Megaphone,
  bed:       Waves,
  recording: Mic,
};

// Visual grouping for the picker
const CATEGORY_GROUPS: { label: string; categories: MediaCategory[] }[] = [
  { label: 'Music',      categories: ['music'] },
  { label: 'Imaging',    categories: ['jingle', 'envelope'] },
  { label: 'Advertising',categories: ['spot', 'promo'] },
  { label: 'Other',      categories: ['bed', 'recording'] },
];

interface ActiveUpload {
  uid: string;
  filename: string;
  size: number;
  loaded: number;
  status: 'uploading' | 'queued' | 'failed';
  error?: string;
  jobId?: string;
}

type IngestTab = 'pending' | 'completed' | 'failed';

const STATUS_SORT: Record<IngestJob['status'], number> = {
  analyzing: 0, transcoding: 0, queued: 1, failed: 2, completed: 3,
};

// ─── Category picker modal ────────────────────────────────────────────────────

function CategoryPickerModal({
  fileCount,
  onSelect,
  onCancel,
}: {
  fileCount: number;
  onSelect: (category: MediaCategory) => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div>
            <h2 className="text-sm font-semibold text-white">Select category</h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              {fileCount} {fileCount === 1 ? 'file' : 'files'} ready to upload
            </p>
          </div>
          <button
            onClick={onCancel}
            className="p-1.5 text-zinc-400 hover:text-white rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {CATEGORY_GROUPS.map((group) => (
            <div key={group.label}>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">
                {group.label}
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                {group.categories.map((cat) => {
                  const Icon = CATEGORY_ICONS[cat];
                  return (
                    <button
                      key={cat}
                      onClick={() => onSelect(cat)}
                      className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 hover:border-zinc-500 text-zinc-200 hover:text-white transition-colors text-left"
                    >
                      <Icon className="w-4 h-4 text-zinc-400 flex-shrink-0" />
                      <span className="text-sm font-medium">{CATEGORY_LABELS[cat]}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function LibraryUpload() {
  const [active, setActive] = useState<ActiveUpload[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);
  const [ingestTab, setIngestTab] = useState<IngestTab>('pending');
  const [batchJobIds, setBatchJobIds] = useState<Set<string>>(new Set());
  const [clearing, setClearing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const { data: jobs = [] } = useQuery({
    queryKey: ['ingest-jobs'],
    queryFn: fetchIngestJobs,
    refetchInterval: (query) => {
      const data = query.state.data as IngestJob[] | undefined;
      const uploadsPending = active.some((a) => a.status === 'uploading' || a.status === 'queued');
      const pipelinePending = (data ?? []).some(
        (j) => j.status === 'queued' || j.status === 'analyzing' || j.status === 'transcoding',
      );
      return uploadsPending || pipelinePending ? 1500 : 5000;
    },
  });

  useEffect(() => {
    if (active.length === 0 || jobs.length === 0) return;
    const knownIds = new Set(jobs.map((j) => j.id));
    setActive((prev) => prev.filter((a) => !a.jobId || !knownIds.has(a.jobId)));
  }, [jobs, active.length]);

  const startUpload = useCallback(async (files: File[], category: MediaCategory) => {
    const initial: ActiveUpload[] = files.map((f) => ({
      uid: crypto.randomUUID(),
      filename: f.name,
      size: f.size,
      loaded: 0,
      status: 'uploading',
    }));
    const initialUids = new Set(initial.map((u) => u.uid));
    setActive((prev) => [...initial, ...prev]);

    try {
      const result = await uploadLibraryFiles(files, category, (loaded, total) => {
        setActive((prev) =>
          prev.map((u) => {
            if (!initialUids.has(u.uid) || u.status !== 'uploading') return u;
            return {
              ...u,
              loaded: Math.min(u.size, Math.round((loaded / total) * u.size)),
            };
          }),
        );
      });

      // Map server job IDs back to upload items by position within this batch.
      const uidList = initial.map((u) => u.uid);
      setActive((prev) =>
        prev.map((u) => {
          const idx = uidList.indexOf(u.uid);
          if (idx === -1 || u.status !== 'uploading') return u;
          return {
            ...u,
            loaded: u.size,
            status: 'queued',
            jobId: result.jobs[idx]?.job_id,
          };
        }),
      );

      // Replace (not append) batch tracker so the progress bar shows only this batch.
      setBatchJobIds(new Set(result.jobs.map((j: { job_id: string }) => j.job_id)));
    } catch (err) {
      setActive((prev) =>
        prev.map((u) => {
          if (!initialUids.has(u.uid) || u.status !== 'uploading') return u;
          return { ...u, status: 'failed', error: (err as Error).message };
        }),
      );
    }
  }, []);

  const handleFiles = useCallback((files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setPendingFiles(list);
  }, []);

  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragActive(true); };
  const onDragLeave = () => setDragActive(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
  };

  // Partition jobs into tabs
  const pendingJobs = [...jobs]
    .filter((j) => j.status === 'queued' || j.status === 'analyzing' || j.status === 'transcoding')
    .sort((a, b) => STATUS_SORT[a.status] - STATUS_SORT[b.status]);
  const completedJobsList = jobs.filter((j) => j.status === 'completed');
  const failedJobsList = jobs.filter((j) => j.status === 'failed');

  const tabJobs =
    ingestTab === 'pending'   ? pendingJobs :
    ingestTab === 'completed' ? completedJobsList :
                                failedJobsList;

  const pipelineBusy = pendingJobs.length > 0;
  const activeJob = pendingJobs.find((j) => j.status === 'analyzing' || j.status === 'transcoding');

  // Progress bar scoped to the current upload batch only
  const batchJobs = batchJobIds.size > 0 ? jobs.filter((j) => batchJobIds.has(j.id)) : jobs;
  const batchTotal = batchJobs.length;
  const batchCompleted = batchJobs.filter((j) => j.status === 'completed').length;
  const batchFailed = batchJobs.filter((j) => j.status === 'failed').length;
  const pct = batchTotal > 0 ? Math.round((batchCompleted / batchTotal) * 100) : 0;

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-3xl font-bold text-white">Upload Audio</h1>
        <p className="text-zinc-400 mt-2">
          Drop files or click to browse — you'll choose a category before each upload starts.
        </p>
      </div>

      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-lg p-12 text-center cursor-pointer transition-colors ${
          dragActive
            ? 'border-brand-500 bg-brand-600/10'
            : 'border-zinc-700 hover:border-zinc-600 bg-zinc-900'
        }`}
      >
        <UploadCloud className="w-12 h-12 mx-auto text-zinc-500 mb-3" />
        <p className="text-zinc-300 font-medium">Drop audio files here, or click to browse</p>
        <p className="text-zinc-500 text-sm mt-1">
          MP3, FLAC, WAV, M4A, OGG — anything ffmpeg reads. Files larger than 256k MP3 are re-encoded; smaller MP3s pass through. Batch limit: 4 GB.
        </p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="audio/*,.mp3,.flac,.wav,.m4a,.ogg,.opus,.aac"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {active.length > 0 && (
        <div className="space-y-1.5">
          {active.map((a, idx) => (
            <UploadingRow
              key={`${a.filename}-${idx}`}
              upload={a}
              onDismiss={() => setActive((prev) => prev.filter((_, i) => i !== idx))}
            />
          ))}
        </div>
      )}

      {jobs.length > 0 && (
        <section className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          {pipelineBusy && (
            <div className="px-4 pt-3 pb-2 border-b border-zinc-800 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-sm text-zinc-300">
                  <span className="font-semibold text-white">{batchCompleted}</span>
                  <span className="text-zinc-500"> / {batchTotal} processed</span>
                  {batchFailed > 0 && <span className="ml-2 text-red-400">{batchFailed} failed</span>}
                </span>
                {activeJob && (
                  <span className="text-xs text-zinc-500 truncate max-w-xs text-right" title={activeJob.uploaded_filename}>
                    {activeJob.status === 'transcoding' ? 'Transcoding' : 'Analysing'}: {activeJob.uploaded_filename}
                  </span>
                )}
              </div>
              <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-brand-500 rounded-full transition-all duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )}

          <div className="flex items-center border-b border-zinc-800">
            <div className="flex flex-1">
              {([
                { key: 'pending',   label: 'Pending',   count: pendingJobs.length },
                { key: 'completed', label: 'Completed',  count: completedJobsList.length },
                { key: 'failed',    label: 'Failed',     count: failedJobsList.length },
              ] as { key: IngestTab; label: string; count: number }[]).map(({ key, label, count }) => (
                <button
                  key={key}
                  onClick={() => setIngestTab(key)}
                  className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors border-b-2 -mb-px ${
                    ingestTab === key
                      ? 'border-brand-500 text-brand-300'
                      : 'border-transparent text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {label}
                  <span className={`px-1.5 py-0.5 rounded text-xs font-semibold ${
                    ingestTab === key
                      ? key === 'failed' ? 'bg-red-900/40 text-red-300' : 'bg-brand-900/40 text-brand-300'
                      : 'bg-zinc-800 text-zinc-500'
                  }`}>
                    {count}
                  </span>
                </button>
              ))}
            </div>
            {(ingestTab === 'completed' || ingestTab === 'failed') && tabJobs.length > 0 && (
              <button
                onClick={async () => {
                  setClearing(true);
                  try {
                    await clearIngestJobs(ingestTab as 'completed' | 'failed');
                    await queryClient.invalidateQueries({ queryKey: ['ingest-jobs'] });
                  } finally {
                    setClearing(false);
                  }
                }}
                disabled={clearing}
                className="flex items-center gap-1.5 mr-3 px-2.5 py-1.5 text-xs text-zinc-500 hover:text-red-400 hover:bg-zinc-800 rounded transition-colors disabled:opacity-40"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear
              </button>
            )}
          </div>

          <div className="overflow-y-auto" style={{ maxHeight: '400px' }}>
            {tabJobs.length === 0 ? (
              <p className="px-4 py-6 text-sm text-zinc-500 text-center">
                {ingestTab === 'pending'   ? 'Nothing pending.' :
                 ingestTab === 'failed'    ? 'No failures.' : 'No completed files yet.'}
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-zinc-900 border-b border-zinc-800 z-10">
                  <tr>
                    <th className="text-left font-medium text-zinc-500 uppercase tracking-wider px-4 py-2 text-xs">File</th>
                    <th className="text-left font-medium text-zinc-500 uppercase tracking-wider px-4 py-2 text-xs">Category</th>
                    <th className="text-left font-medium text-zinc-500 uppercase tracking-wider px-4 py-2 text-xs">Status</th>
                    <th className="text-left font-medium text-zinc-500 uppercase tracking-wider px-4 py-2 text-xs">Loudness</th>
                    <th className="text-left font-medium text-zinc-500 uppercase tracking-wider px-4 py-2 text-xs">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {tabJobs.map((job) => (
                    <JobRow key={job.id} job={job} />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}

      {pendingFiles && (
        <CategoryPickerModal
          fileCount={pendingFiles.length}
          onSelect={(category) => {
            startUpload(pendingFiles, category);
            setPendingFiles(null);
            setIngestTab('pending');
          }}
          onCancel={() => setPendingFiles(null)}
        />
      )}
    </div>
  );
}

// ─── Upload progress row ──────────────────────────────────────────────────────

function UploadingRow({ upload, onDismiss }: { upload: ActiveUpload; onDismiss: () => void }) {
  const pct = upload.size === 0 ? 0 : Math.round((upload.loaded / upload.size) * 100);

  return (
    <div className="flex items-center gap-3 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-xs text-zinc-300 truncate flex-1">{upload.filename}</p>
          {upload.status === 'uploading' && (
            <span className="flex-shrink-0 text-xs text-zinc-500 w-8 text-right">{pct}%</span>
          )}
          {upload.status === 'queued' && (
            <span className="flex-shrink-0 text-xs text-zinc-500 flex items-center gap-1">
              <Loader className="w-3 h-3 animate-spin" /> queued
            </span>
          )}
          {upload.status === 'failed' && (
            <span className="flex-shrink-0 text-xs text-red-400 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" /> {upload.error}
            </span>
          )}
        </div>
        {upload.status === 'uploading' && (
          <div className="mt-1 h-1 bg-zinc-800 rounded-full overflow-hidden">
            <div className="h-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      {(upload.status === 'failed' || upload.status === 'queued') && (
        <button onClick={onDismiss} className="flex-shrink-0 p-1 text-zinc-600 hover:text-zinc-400 transition-colors">
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

// ─── Ingest job row ───────────────────────────────────────────────────────────

function JobRow({ job }: { job: IngestJob }) {
  const statusColor = {
    queued:      'text-zinc-400',
    analyzing:   'text-amber-400',
    transcoding: 'text-amber-400',
    completed:   'text-green-400',
    failed:      'text-red-400',
  }[job.status];

  const statusIcon =
    job.status === 'completed'   ? <Check className="w-3.5 h-3.5" /> :
    job.status === 'failed'      ? <AlertCircle className="w-3.5 h-3.5" /> :
    job.status === 'queued'      ? <Loader className="w-3.5 h-3.5 text-zinc-600" /> :
                                   <Loader className="w-3.5 h-3.5 animate-spin" />;

  return (
    <tr className="border-t border-zinc-800/50 hover:bg-zinc-800/20">
      <td className="px-4 py-1.5 text-zinc-200 truncate max-w-xs" title={job.uploaded_filename}>
        {job.uploaded_filename}
      </td>
      <td className="px-4 py-1.5 text-zinc-500">{CATEGORY_LABELS[job.category]}</td>
      <td className={`px-4 py-1.5 ${statusColor}`}>
        <span className="flex items-center gap-1.5">
          {statusIcon}
          {job.status}
        </span>
      </td>
      <td className="px-4 py-1.5 text-zinc-400 font-mono">
        {job.measured_lufs !== null ? `${job.measured_lufs.toFixed(1)} LUFS` : '—'}
      </td>
      <td className="px-4 py-1.5 text-zinc-500">
        {job.error_message || (job.needs_transcode ? 'transcoded' : job.status === 'completed' ? 'pass-through' : '')}
      </td>
    </tr>
  );
}
