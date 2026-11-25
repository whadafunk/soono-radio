import { RECORDING_FLAGS, RECORDING_FLAG_LABELS, type RecordingFilter } from '@soono/shared';
import { inputClass } from './recordingFormat';

const WEEKDAYS: Array<{ iso: number; label: string }> = [
  { iso: 1, label: 'Mon' }, { iso: 2, label: 'Tue' }, { iso: 3, label: 'Wed' }, { iso: 4, label: 'Thu' },
  { iso: 5, label: 'Fri' }, { iso: 6, label: 'Sat' }, { iso: 7, label: 'Sun' },
];
const HOURS = Array.from({ length: 25 }, (_, h) => h);
const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;

// The period and the filters over it. Filters only narrow what is listed; a
// day's totals and its no-recording time are never hidden by them.
export function RecordingFilterBar({ from, to, today, onPeriod, filter, onFilter }: {
  from: string;
  to: string;
  today: string;
  onPeriod: (from: string, to: string) => void;
  filter: RecordingFilter;
  onFilter: (filter: RecordingFilter) => void;
}) {
  const toggleWeekday = (iso: number) => {
    const weekdays = filter.weekdays.includes(iso) ? filter.weekdays.filter((d) => d !== iso) : [...filter.weekdays, iso];
    onFilter({ ...filter, weekdays });
  };
  const hour = (value: string): number | null => (value === '' ? null : Number(value));
  const hoursIncomplete = (filter.hourFrom == null) !== (filter.hourTo == null);
  const hoursBackwards = filter.hourFrom != null && filter.hourTo != null && filter.hourTo <= filter.hourFrom;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="text-sm text-zinc-300">
          <span className="block mb-1">Period</span>
          <div className="flex items-center gap-2">
            <input type="date" aria-label="Period start" value={from} max={to} onChange={(e) => { if (e.target.value) onPeriod(e.target.value, to); }} className={inputClass} />
            <span className="text-zinc-400">–</span>
            <input type="date" aria-label="Period end" value={to} min={from} max={today} onChange={(e) => { if (e.target.value) onPeriod(from, e.target.value); }} className={inputClass} />
          </div>
        </div>

        <div className="text-sm text-zinc-300">
          <span className="block mb-1">Hours</span>
          <div className="flex items-center gap-2">
            <select aria-label="From hour" value={filter.hourFrom ?? ''} onChange={(e) => onFilter({ ...filter, hourFrom: hour(e.target.value) })} className={inputClass}>
              <option value="">Any</option>
              {HOURS.slice(0, 24).map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>
            <span className="text-zinc-400">–</span>
            <select aria-label="To hour" value={filter.hourTo ?? ''} onChange={(e) => onFilter({ ...filter, hourTo: hour(e.target.value) })} className={inputClass}>
              <option value="">Any</option>
              {HOURS.slice(1).map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>
          </div>
        </div>

        <div className="text-sm text-zinc-300">
          <span className="block mb-1">Days of the week</span>
          <div className="flex items-center gap-1">
            {WEEKDAYS.map((d) => {
              const on = filter.weekdays.includes(d.iso);
              return (
                <button
                  key={d.iso}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleWeekday(d.iso)}
                  className={`px-2 py-1.5 rounded text-sm border ${on ? 'bg-zinc-600 border-zinc-500 text-white' : 'bg-zinc-900 border-zinc-700 text-zinc-300 hover:text-white'}`}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
        </div>

        <label className="text-sm text-zinc-300">
          <span className="block mb-1">Flag</span>
          <select
            aria-label="Flag filter"
            value={filter.flag}
            onChange={(e) => onFilter({ ...filter, flag: e.target.value as RecordingFilter['flag'] })}
            className={inputClass}
          >
            <option value="any">Any</option>
            <option value="unflagged">Unflagged</option>
            {RECORDING_FLAGS.map((f) => <option key={f} value={f}>{RECORDING_FLAG_LABELS[f]}</option>)}
          </select>
        </label>

        <label className="inline-flex items-center gap-2 text-sm text-zinc-300 pb-1.5">
          <input type="checkbox" checked={filter.noRecordingOnly} onChange={(e) => onFilter({ ...filter, noRecordingOnly: e.target.checked })} />
          No recording only
        </label>
      </div>
      {hoursIncomplete && <p className="text-xs text-zinc-400">Choose both a start and an end hour to filter by hours.</p>}
      {hoursBackwards && <p className="text-xs text-amber-300">The end hour must be after the start hour; the hours filter is not applied.</p>}
    </div>
  );
}
