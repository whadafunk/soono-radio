import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Loader, Trash2, Check, AlertCircle, AlertTriangle, ChevronDown, ChevronUp,
  Fingerprint, Wand2, Activity, RefreshCcw,
} from 'lucide-react';
import type { BackgroundJob, LookupIdResults, AnalyseResults, StoredCandidate } from '@soono/shared';
import {
  fetchActivityJobs,
  fetchActivityJob,
  resolveActivityItem,
  dismissAllActivityItems,
  deleteActivityJob,
} from '../../api';

function formatDate(d: Date | string | null): string {
  if (!d) return '—';
  const dt = typeof d === 'string' ? new Date(d) : d;
  return dt.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

function StatusBadge({ status }: { status: BackgroundJob['status'] }) {
  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-brand-900/40 border border-brand-600 text-brand-300">
        <Loader className="w-2.5 h-2.5 animate-spin" />
        Running
      </span>
    );
  }
  if (status === 'review_pending') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-900/40 border border-amber-700 text-amber-300">
        <AlertTriangle className="w-2.5 h-2.5" />
        Needs Review
      </span>
    );
  }
  if (status === 'completed') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-900/40 border border-green-700 text-green-300">
        <Check className="w-2.5 h-2.5" />
        Completed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-zinc-800 border border-zinc-700 text-zinc-400">
      <Check className="w-2.5 h-2.5" />
      Done
    </span>
  );
}

function TypeIcon({ type }: { type: BackgroundJob['type'] }) {
  if (type === 'lookup_id') return <Fingerprint className="w-4 h-4 text-brand-400 flex-shrink-0" />;
  if (type === 'analyse') return <Wand2 className="w-4 h-4 text-violet-400 flex-shrink-0" />;
  return <RefreshCcw className="w-4 h-4 text-zinc-400 flex-shrink-0" />;
}

function SourceBadge({ source }: { source: StoredCandidate['source'] }) {
  if (source === 'acoustid') return <span className="text-[10px] bg-brand-900/40 border border-brand-700 text-brand-300 px-1.5 py-0.5 rounded">AcoustID</span>;
  if (source === 'musicbrainz') return <span className="text-[10px] bg-purple-900/40 border border-purple-700 text-purple-300 px-1.5 py-0.5 rounded">MusicBrainz</span>;
  if (source === 'artist-confirmed') return <span className="text-[10px] bg-emerald-900/40 border border-emerald-700 text-emerald-300 px-1.5 py-0.5 rounded">Artist confirmed</span>;
  return <span className="text-[10px] bg-zinc-800 border border-zinc-700 text-zinc-400 px-1.5 py-0.5 rounded">Filename</span>;
}

function SkippedItem({
  item,
  onResolve,
  resolving,
}: {
  item: LookupIdResults['skipped'][number];
  onResolve: (mediaId: number, action: 'apply' | 'dismiss', candidateIndex?: number) => void;
  resolving: boolean;
}) {
  const [showCandidates, setShowCandidates] = useState(false);

  return (
    <li className={`bg-zinc-800/60 rounded-lg px-3 py-2 ${item.resolved ? 'opacity-50' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-zinc-200 truncate">{item.filename}</p>
          <p className="text-xs text-amber-400/80 mt-0.5">{item.reason}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {item.resolved ? (
            <span className="text-xs text-zinc-500 italic">Resolved</span>
          ) : (
            <>
              {item.candidates.length > 0 && (
                <button
                  onClick={() => setShowCandidates((v) => !v)}
                  disabled={resolving}
                  className="text-xs text-brand-300 hover:text-brand-100 transition-colors"
                >
                  {showCandidates ? 'Hide' : `${item.candidates.length} candidate${item.candidates.length !== 1 ? 's' : ''}`}
                </button>
              )}
              <button
                onClick={() => onResolve(item.id, 'dismiss')}
                disabled={resolving}
                className="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors disabled:opacity-50"
              >
                Dismiss
              </button>
            </>
          )}
        </div>
      </div>

      {showCandidates && !item.resolved && (
        <ul className="mt-2 space-y-1">
          {item.candidates.map((c, i) => (
            <li key={i} className="flex items-center gap-2 bg-zinc-700/40 rounded px-2 py-1.5">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white truncate">{c.title ?? <span className="italic text-zinc-400">Unknown title</span>}</p>
                <p className="text-xs text-zinc-400 truncate">
                  {c.artist ?? '—'}{c.album ? ` · ${c.album}` : ''}{c.year ? ` (${c.year})` : ''}
                </p>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <SourceBadge source={c.source} />
                <span className="text-xs font-mono text-zinc-400">{Math.round(c.score * 100)}%</span>
                <button
                  onClick={() => onResolve(item.id, 'apply', i)}
                  disabled={resolving}
                  className="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-white transition-colors disabled:opacity-50"
                >
                  Apply
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function LookupIdDetail({
  results,
  jobId,
  pendingReview,
}: {
  results: LookupIdResults;
  jobId: string;
  pendingReview: boolean;
}) {
  const queryClient = useQueryClient();
  const unresolvedCount = useMemo(() => results.skipped.filter((s) => !s.resolved).length, [results]);

  const resolveMutation = useMutation({
    mutationFn: ({ mediaId, action, candidateIndex }: { mediaId: number; action: 'apply' | 'dismiss'; candidateIndex?: number }) =>
      resolveActivityItem(jobId, mediaId, action, candidateIndex),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['activity-job', jobId] });
      queryClient.invalidateQueries({ queryKey: ['activity-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['activity-stats'] });
    },
  });

  const dismissAllMutation = useMutation({
    mutationFn: () => dismissAllActivityItems(jobId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['activity-job', jobId] });
      queryClient.invalidateQueries({ queryKey: ['activity-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['activity-stats'] });
    },
  });

  const handleResolve = (mediaId: number, action: 'apply' | 'dismiss', candidateIndex?: number) => {
    resolveMutation.mutate({ mediaId, action, candidateIndex });
  };

  return (
    <div className="space-y-4">
      {pendingReview && unresolvedCount > 0 && (
        <div className="flex items-center justify-between bg-amber-900/10 border border-amber-800/40 rounded-lg px-3 py-2">
          <p className="text-sm text-amber-300">
            {unresolvedCount} item{unresolvedCount !== 1 ? 's' : ''} need manual review
          </p>
          <button
            onClick={() => dismissAllMutation.mutate()}
            disabled={dismissAllMutation.isPending}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 transition-colors disabled:opacity-50"
          >
            {dismissAllMutation.isPending && <Loader className="w-3 h-3 animate-spin" />}
            Dismiss all
          </button>
        </div>
      )}

      {results.applied.length > 0 && (
        <section>
          <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-green-400 mb-2">
            <Check className="w-3.5 h-3.5" />
            Applied ({results.applied.length})
          </h4>
          <ul className="space-y-1.5">
            {results.applied.map((r) => (
              <li key={r.id} className="bg-zinc-800/60 rounded-lg px-3 py-2">
                <p className="text-[11px] text-zinc-500 truncate mb-0.5">{r.filename}</p>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm text-white font-medium truncate">{r.title ?? <span className="italic text-zinc-400">Unknown title</span>}</p>
                    <p className="text-xs text-zinc-400 truncate">
                      {r.artist ?? '—'}{r.album ? ` · ${r.album}` : ''}{r.year ? ` (${r.year})` : ''}
                    </p>
                  </div>
                  <span className="flex-shrink-0 text-xs font-mono text-green-400 bg-green-900/30 border border-green-800/50 rounded px-1.5 py-0.5">
                    {Math.round(r.score * 100)}%
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {results.skipped.length > 0 && (
        <section>
          <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-amber-400 mb-2">
            <AlertTriangle className="w-3.5 h-3.5" />
            Skipped ({results.skipped.length})
          </h4>
          <ul className="space-y-1.5">
            {results.skipped.map((item) => (
              <SkippedItem
                key={item.id}
                item={item}
                onResolve={handleResolve}
                resolving={resolveMutation.isPending}
              />
            ))}
          </ul>
        </section>
      )}

      {results.failed.length > 0 && (
        <section>
          <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-red-400 mb-2">
            <AlertCircle className="w-3.5 h-3.5" />
            Failed ({results.failed.length})
          </h4>
          <ul className="space-y-1.5">
            {results.failed.map((r) => (
              <li key={r.id} className="bg-zinc-800/60 rounded-lg px-3 py-2 flex items-start justify-between gap-3">
                <p className="text-sm text-zinc-300 truncate min-w-0">{r.filename}</p>
                <span className="flex-shrink-0 text-xs text-red-400 text-right max-w-[50%]">{r.error}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {results.applied.length === 0 && results.skipped.length === 0 && results.failed.length === 0 && (
        <p className="text-sm text-zinc-500 text-center py-4">No tracks were processed.</p>
      )}
    </div>
  );
}

function AnalyseDetail({ results }: { results: AnalyseResults }) {
  return (
    <div className="space-y-4">
      {results.succeeded.length > 0 && (
        <section>
          <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-green-400 mb-2">
            <Check className="w-3.5 h-3.5" />
            Succeeded ({results.succeeded.length})
          </h4>
          <ul className="space-y-1">
            {results.succeeded.map((r) => (
              <li key={r.id} className="bg-zinc-800/60 rounded px-3 py-1.5 text-sm text-zinc-300 truncate">{r.filename}</li>
            ))}
          </ul>
        </section>
      )}
      {results.failed.length > 0 && (
        <section>
          <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-red-400 mb-2">
            <AlertCircle className="w-3.5 h-3.5" />
            Failed ({results.failed.length})
          </h4>
          <ul className="space-y-1.5">
            {results.failed.map((r) => (
              <li key={r.id} className="bg-zinc-800/60 rounded-lg px-3 py-2 flex items-start justify-between gap-3">
                <p className="text-sm text-zinc-300 truncate min-w-0">{r.filename}</p>
                <span className="flex-shrink-0 text-xs text-red-400 text-right max-w-[50%]">{r.error}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function JobCard({ job, onDelete }: { job: BackgroundJob; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(job.status === 'review_pending');
  const canExpand = job.status !== 'running';

  const { data: detail, isLoading: loadingDetail } = useQuery({
    queryKey: ['activity-job', job.id],
    queryFn: () => fetchActivityJob(job.id),
    enabled: expanded && canExpand,
  });

  const results = useMemo<LookupIdResults | AnalyseResults | { error: string } | null>(() => {
    if (!detail?.results_json) return null;
    try {
      return JSON.parse(detail.results_json);
    } catch {
      return null;
    }
  }, [detail]);

  const isErrorResult = results && 'error' in results;
  const lookupResults = job.type === 'lookup_id' && results && !isErrorResult ? results as LookupIdResults : null;
  const analyseResults = job.type === 'analyse' && results && !isErrorResult ? results as AnalyseResults : null;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-3">
        <TypeIcon type={job.type} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-white truncate">{job.label}</p>
          <p className="text-xs text-zinc-500 mt-0.5">{formatDate(job.created_at)}</p>
        </div>

        {job.status !== 'running' && (
          <div className="flex items-center gap-3 text-xs text-zinc-500 flex-shrink-0">
            {job.succeeded > 0 && (
              <span className="text-green-400">{job.succeeded} ok</span>
            )}
            {job.review_pending > 0 && (
              <span className="text-amber-400">{job.review_pending} pending</span>
            )}
            {job.failed > 0 && (
              <span className="text-red-400">{job.failed} failed</span>
            )}
            <span className="text-zinc-600">/ {job.total}</span>
          </div>
        )}

        <StatusBadge status={job.status} />

        {canExpand && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="p-1 text-zinc-400 hover:text-white transition-colors"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        )}

        <button
          onClick={onDelete}
          className="p-1 text-zinc-500 hover:text-red-400 transition-colors"
          title="Delete"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {expanded && canExpand && (
        <div className="border-t border-zinc-800 px-4 py-4">
          {loadingDetail && (
            <div className="flex items-center justify-center py-4">
              <Loader className="w-4 h-4 animate-spin text-zinc-500" />
            </div>
          )}
          {detail && isErrorResult && (
            <div className="flex items-center gap-2 text-sm text-red-300">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{(results as { error: string }).error}</span>
            </div>
          )}
          {lookupResults && (
            <LookupIdDetail
              results={lookupResults}
              jobId={job.id}
              pendingReview={job.status === 'review_pending'}
            />
          )}
          {analyseResults && (
            <AnalyseDetail results={analyseResults} />
          )}
        </div>
      )}
    </div>
  );
}

export function ActivityPage() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['activity-jobs'],
    queryFn: fetchActivityJobs,
    refetchInterval: (query) => {
      const jobs = query.state.data;
      return jobs?.some((j) => j.status === 'running') ? 5_000 : false;
    },
  });

  const jobs = data ?? [];
  const hasRunning = jobs.some((j) => j.status === 'running');
  const pendingReview = jobs.filter((j) => j.status === 'review_pending').length;

  const deleteMutation = useMutation({
    mutationFn: deleteActivityJob,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['activity-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['activity-stats'] });
    },
  });

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Activity</h1>
          <p className="text-zinc-400 mt-1">
            {hasRunning
              ? 'Jobs running in background…'
              : pendingReview > 0
                ? `${pendingReview} job${pendingReview !== 1 ? 's' : ''} need review`
                : 'Background job results and review queue'}
          </p>
        </div>
        {hasRunning && <Loader className="w-5 h-5 animate-spin text-brand-400" />}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader className="w-6 h-6 animate-spin text-brand-500" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-12 text-center">
          <Activity className="w-10 h-10 text-zinc-700 mx-auto mb-3" />
          <p className="text-zinc-400 font-medium">No background jobs yet</p>
          <p className="text-zinc-600 text-sm mt-1">Bulk Lookup ID and Audio Analysis jobs will appear here</p>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onDelete={() => deleteMutation.mutate(job.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
