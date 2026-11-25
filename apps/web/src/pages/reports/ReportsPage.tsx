import { useSearchParams } from 'react-router-dom';
import { ComingSoon } from '../ComingSoon';
import { RecordingsTab } from './RecordingsTab';

const TABS = [
  { id: 'broadcast-log', label: 'Broadcast Log' },
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'recordings', label: 'Recordings' },
] as const;
type TabId = (typeof TABS)[number]['id'];

// Reports: proof of what the station broadcast. Recordings is built; the
// other two tabs wait for the broadcast-journal requirements
// (docs/reports-recordings-design.md).
export function ReportsPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: TabId = TABS.some((t) => t.id === requested) ? (requested as TabId) : 'recordings';

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-white">Reports</h1>

      <div className="flex items-center gap-1 border-b border-zinc-800">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setParams({ tab: t.id })}
            className={`px-4 py-2 text-sm -mb-px border-b-2 ${
              t.id === tab
                ? 'border-brand-500 text-white font-medium'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'broadcast-log' && <ComingSoon page="Broadcast Log" />}
      {tab === 'campaigns' && <ComingSoon page="Campaign Reports" />}
      {tab === 'recordings' && <RecordingsTab />}
    </div>
  );
}
