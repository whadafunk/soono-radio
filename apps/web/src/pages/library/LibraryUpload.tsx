import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader, UploadCloud, Check, AlertCircle, X } from 'lucide-react';
import { MEDIA_CATEGORIES, MediaCategory, IngestJob } from '@radio/shared';

const CATEGORY_LABELS: Record<MediaCategory, string> = {
  music: 'Music',
  jingle: 'Jingle',
  promo: 'Promo',
  intro: 'Intro',
  outro: 'Outro',
  bed: 'Bed',
  spot: 'Spot',
  recording: 'Recording',
};
import { fetchIngestJobs, uploadLibraryFiles } from '../../api';

interface ActiveUpload {
  filename: string;
  size: number;
  loaded: number;
  status: 'uploading' | 'queued' | 'failed';
  error?: string;
  jobId?: string;
}

export function LibraryUpload() {
  const [category, setCategory] = useState<MediaCategory>('music');
  const [active, setActive] = useState<ActiveUpload[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Poll the recent ingest_jobs list so the user sees their files moving from
  // queued → analyzing → transcoding → completed/failed without an SSE channel.
  const hasPending = active.some((a) => a.status === 'uploading' || a.status === 'queued');
  const { data: jobs = [] } = useQuery({
    queryKey: ['ingest-jobs'],
    queryFn: fetchIngestJobs,
    refetchInterval: hasPending ? 1500 : 5000,
  });

  // Once the API has accepted the upload and we have a job_id, the row from
  // /library/ingest takes over as the source of truth. We can drop matching
  // entries from `active` once they appear in the polled list.
  useEffect(() => {
    if (active.length === 0 || jobs.length === 0) return;
    const knownIds = new Set(jobs.map((j) => j.id));
    setActive((prev) => prev.filter((a) => !a.jobId || !knownIds.has(a.jobId)));
  }, [jobs, active.length]);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;

      const initial: ActiveUpload[] = list.map((f) => ({
        filename: f.name,
        size: f.size,
        loaded: 0,
        status: 'uploading',
      }));
      setActive((prev) => [...initial, ...prev]);

      try {
        const result = await uploadLibraryFiles(list, category, (loaded, total) => {
          setActive((prev) => {
            const next = [...prev];
            for (let i = 0; i < initial.length; i++) {
              if (next[i] && next[i].status === 'uploading') {
                // Spread progress proportionally across the batch so the bar
                // moves smoothly even though XHR reports a single total.
                next[i] = {
                  ...next[i],
                  loaded: Math.min(next[i].size, Math.round((loaded / total) * next[i].size)),
                };
              }
            }
            return next;
          });
        });

        setActive((prev) => {
          const next = [...prev];
          for (let i = 0; i < initial.length; i++) {
            if (next[i] && next[i].status === 'uploading') {
              next[i] = {
                ...next[i],
                loaded: next[i].size,
                status: 'queued',
                jobId: result.jobs[i]?.job_id,
              };
            }
          }
          return next;
        });
      } catch (err) {
        setActive((prev) => {
          const next = [...prev];
          for (let i = 0; i < initial.length; i++) {
            if (next[i] && next[i].status === 'uploading') {
              next[i] = { ...next[i], status: 'failed', error: (err as Error).message };
            }
          }
          return next;
        });
      }
    },
    [category],
  );

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(true);
  };
  const onDragLeave = () => setDragActive(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
  };

  const recentJobs = jobs.slice(0, 25);

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-3xl font-bold text-white">Upload Audio</h1>
        <p className="text-zinc-400 mt-2">
          Drop one or many files. Each batch uses a single category — change it before dropping if needed.
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-zinc-300 mb-2">Category for this batch</label>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as MediaCategory)}
          className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
        >
          {MEDIA_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </div>

      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-lg p-12 text-center cursor-pointer transition-colors ${
          dragActive
            ? 'border-indigo-500 bg-indigo-600/10'
            : 'border-zinc-700 hover:border-zinc-600 bg-zinc-900'
        }`}
      >
        <UploadCloud className="w-12 h-12 mx-auto text-zinc-500 mb-3" />
        <p className="text-zinc-300 font-medium">Drop audio files here, or click to browse</p>
        <p className="text-zinc-500 text-sm mt-1">
          MP3, FLAC, WAV, M4A, OGG — anything ffmpeg reads. Files larger than 256k MP3 are re-encoded; smaller MP3s pass through.
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
        <section>
          <h2 className="text-lg font-semibold text-white mb-3">Uploading</h2>
          <div className="space-y-2">
            {active.map((a, idx) => (
              <UploadingRow
                key={`${a.filename}-${idx}`}
                upload={a}
                onDismiss={() => setActive((prev) => prev.filter((_, i) => i !== idx))}
              />
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="text-lg font-semibold text-white mb-3">Recent Ingests</h2>
        {recentJobs.length === 0 ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 text-zinc-500 text-sm">
            No uploads yet.
          </div>
        ) : (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-zinc-950/50 border-b border-zinc-800">
                <tr>
                  <th className="text-left text-xs font-medium text-zinc-400 uppercase tracking-wider px-4 py-2">File</th>
                  <th className="text-left text-xs font-medium text-zinc-400 uppercase tracking-wider px-4 py-2">Category</th>
                  <th className="text-left text-xs font-medium text-zinc-400 uppercase tracking-wider px-4 py-2">Status</th>
                  <th className="text-left text-xs font-medium text-zinc-400 uppercase tracking-wider px-4 py-2">Loudness</th>
                  <th className="text-left text-xs font-medium text-zinc-400 uppercase tracking-wider px-4 py-2">Notes</th>
                </tr>
              </thead>
              <tbody>
                {recentJobs.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function UploadingRow({ upload, onDismiss }: { upload: ActiveUpload; onDismiss: () => void }) {
  const pct = upload.size === 0 ? 0 : Math.round((upload.loaded / upload.size) * 100);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-zinc-200 truncate">{upload.filename}</p>
          <div className="flex items-center gap-2 mt-1">
            {upload.status === 'uploading' && (
              <>
                <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-indigo-500 transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="text-xs text-zinc-500 w-12 text-right">{pct}%</span>
              </>
            )}
            {upload.status === 'queued' && (
              <span className="text-xs text-zinc-500 flex items-center gap-1">
                <Loader className="w-3 h-3 animate-spin" /> uploaded — queued for processing
              </span>
            )}
            {upload.status === 'failed' && (
              <span className="text-xs text-red-400 flex items-center gap-1">
                <AlertCircle className="w-3 h-3" /> {upload.error}
              </span>
            )}
          </div>
        </div>
        {(upload.status === 'failed' || upload.status === 'queued') && (
          <button
            onClick={onDismiss}
            className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
            title="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function JobRow({ job }: { job: IngestJob }) {
  const statusColor = {
    queued: 'text-zinc-400',
    analyzing: 'text-amber-400',
    transcoding: 'text-amber-400',
    completed: 'text-green-400',
    failed: 'text-red-400',
  }[job.status];

  const statusIcon =
    job.status === 'completed' ? (
      <Check className="w-3.5 h-3.5" />
    ) : job.status === 'failed' ? (
      <AlertCircle className="w-3.5 h-3.5" />
    ) : (
      <Loader className="w-3.5 h-3.5 animate-spin" />
    );

  return (
    <tr className="border-t border-zinc-800/60">
      <td className="px-4 py-2 text-zinc-200 truncate max-w-xs" title={job.uploaded_filename}>
        {job.uploaded_filename}
      </td>
      <td className="px-4 py-2 text-zinc-400">{CATEGORY_LABELS[job.category]}</td>
      <td className={`px-4 py-2 ${statusColor}`}>
        <span className="flex items-center gap-1.5">
          {statusIcon}
          {job.status}
        </span>
      </td>
      <td className="px-4 py-2 text-zinc-400 font-mono text-xs">
        {job.measured_lufs !== null ? `${job.measured_lufs.toFixed(1)} LUFS` : '—'}
      </td>
      <td className="px-4 py-2 text-zinc-500 text-xs">
        {job.error_message || (job.needs_transcode ? 'transcoded' : job.status === 'completed' ? 'pass-through' : '')}
      </td>
    </tr>
  );
}
