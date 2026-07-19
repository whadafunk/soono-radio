import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, useController, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Loader,
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  Pencil,
  X,
  UserPlus,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertTriangle,
} from 'lucide-react';
import {
  Customer,
  CustomerCreate,
  CustomerCreateSchema,
  CustomerPatch,
  CustomerPatchSchema,
  Campaign,
  CampaignCreate,
  CampaignCreateSchema,
  CampaignPatch,
  CampaignPatchSchema,
  FIRST_IN_SLOT_MODES,
  BroadcastInterval,
  Contact,
  ContactCreate,
  ContactCreateSchema,
  ContactPatch,
  ContactPatchSchema,
  User,
  Show,
  CampaignValidationDraft,
  CampaignValidationDraftSchema,
} from '@soono/shared';
import { HelpTooltip } from '../../components/HelpTooltip';
import { CampaignMediaSection } from './CampaignMediaSection';
import { MusicCampaignsPage } from './MusicCampaignsPage';
import { SpotBudgetDetailsModal } from './SpotBudgetDetailsModal';
import { BTN_PRIMARY_SM, BTN_SECONDARY_SM, BTN_DESTRUCTIVE_SM, INPUT, LABEL } from '../../ui';
import { SaveStatus } from '../../components/SaveStatus';
import {
  fetchCustomers,
  validateCampaign,
  fetchCampaignValidationSummary,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  deleteCustomers,
  deleteCampaigns,
  deleteContacts,
  fetchCampaigns,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  fetchContacts,
  fetchAllContacts,
  fetchContactsWithCustomers,
  fetchContactCustomers,
  createContact,
  updateContact,
  deleteContact,
  associateContact,
  dissociateContact,
  setContactPrimary,
  fetchCampaignLedger,
  fetchCampaignMedia,
  removeCampaignMedia,
  updateCampaignMedia,
  fetchUsers,
  fetchShows,
  fetchIntervals,
  fetchSpotBudget,
  fetchSpotBudgetPacing,
  fetchCampaignBudget,
} from '../../api';

// ─── Spot budget helpers ──────────────────────────────────────────────────────

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoOffsetDays(base: string, days: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function fmtMinutes(mins: number): string {
  return mins.toFixed(1);
}

// ─── Global Budget Panel ──────────────────────────────────────────────────────

function GlobalBudgetPanel() {
  const today = isoToday();
  const end30 = isoOffsetDays(today, 30);
  const [showDetails, setShowDetails] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['spot-budget', today, end30],
    queryFn: () => fetchSpotBudget(today, end30, 'estimated'),
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="px-4 py-3 bg-zinc-900/60 border border-zinc-800 rounded-lg flex items-center gap-2 text-zinc-400 text-xs">
        <Loader className="w-3.5 h-3.5 animate-spin" />
        Loading spot budget…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="px-4 py-3 bg-zinc-900/60 border border-zinc-800 rounded-lg text-xs text-zinc-500">
        Spot budget unavailable
      </div>
    );
  }

  const available = data.available.global.minutes;
  const used = data.demand.totals.global.minutes;
  const total = data.inventory.effective.global.minutes;
  const breaksAvailable = data.available.global.breaks;
  const breaksUsed = data.demand.totals.global.breaks;
  const breaksTotal = data.inventory.effective.global.breaks;

  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const barColor = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-brand-500';

  return (
    <div className="px-4 py-3 bg-zinc-900/60 border border-zinc-800 rounded-lg space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
          30-Day Spot Budget
        </span>
        <span className="flex items-center gap-4">
          <span className="text-xs text-zinc-400">
            {fmtMinutes(used)} / {fmtMinutes(total)} min used ({pct}%)
          </span>
          <button
            type="button"
            onClick={() => setShowDetails(true)}
            className="text-xs text-brand-400 hover:text-brand-300 font-medium"
          >
            Details
          </button>
        </span>
      </div>
      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center gap-6 text-xs">
        <span>
          <span className="text-zinc-400">Available: </span>
          <span className="text-zinc-300 font-medium">{fmtMinutes(available)} min</span>
        </span>
        <span>
          <span className="text-zinc-400">First-slot breaks: </span>
          <span className="text-zinc-300 font-medium">{breaksAvailable} of {breaksTotal} free</span>
          {breaksUsed > 0 && (
            <span className="text-zinc-500 ml-1">({breaksUsed} used)</span>
          )}
        </span>
      </div>
      {total === 0 && (
        <div className="text-xs text-amber-400">
          Schedule doesn't resolve for this window — add calendar or template entries.
        </div>
      )}
      {showDetails && (
        <SpotBudgetDetailsModal
          start={today}
          end={end30}
          overview={data}
          onClose={() => setShowDetails(false)}
        />
      )}
    </div>
  );
}

// ─── Per-campaign pacing cell ─────────────────────────────────────────────────

function SpotPacingCell({ campaignId }: { campaignId: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ['spot-budget-pacing', campaignId],
    queryFn: () => fetchSpotBudgetPacing(campaignId),
    staleTime: 2 * 60 * 1000,
  });

  if (isLoading) return <span className="text-zinc-600 text-xs">…</span>;
  if (!data) return null;

  const { delta } = data;
  const abs = Math.round(Math.abs(delta) * 10) / 10;

  if (delta >= 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-green-400">
        <TrendingUp className="w-3 h-3" />
        {delta === 0 ? 'On pace' : `Ahead +${abs}`}
      </span>
    );
  }
  if (abs <= 3) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-amber-400">
        <Minus className="w-3 h-3" />
        {`Behind −${abs}`}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-red-400">
      <TrendingDown className="w-3 h-3" />
      {`Behind −${abs}`}
    </span>
  );
}

// ─── Budget impact summary (used in create/edit forms) ────────────────────────

// D96 Phase C — live sale-time validation. Debounces the form state, asks the
// validator, and renders per-check verdicts with the numbers. The same checks
// re-run for every active campaign after schedule edits (problem badges).
function CampaignValidationPanel({ raw }: { raw: unknown }) {
  const [debounced, setDebounced] = useState<CampaignValidationDraft | null>(null);
  const rawJson = JSON.stringify(raw);
  useEffect(() => {
    const t = setTimeout(() => {
      const parsed = CampaignValidationDraftSchema.safeParse(raw);
      setDebounced(parsed.success ? parsed.data : null);
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawJson]);

  const { data, isFetching } = useQuery({
    queryKey: ['campaign-validate', debounced],
    queryFn: () => validateCampaign(debounced!),
    enabled: debounced != null,
    staleTime: 30_000,
  });

  if (!debounced) return null;
  const tone =
    data?.verdict === 'refuse' ? 'border-red-800 bg-red-900/15'
    : data?.verdict === 'warnings' ? 'border-amber-800 bg-amber-900/15'
    : 'border-zinc-700/50 bg-zinc-800/40';
  return (
    <div className={`rounded-lg border px-3 py-2 space-y-1 ${tone}`}>
      <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
        Can the schedule keep this promise?
        {isFetching && <Loader className="w-3 h-3 animate-spin" />}
        {data && (
          <span className={
            data.verdict === 'refuse' ? 'text-red-400'
            : data.verdict === 'warnings' ? 'text-amber-400'
            : 'text-green-400'
          }>
            {data.verdict === 'refuse' ? 'No — see below' : data.verdict === 'warnings' ? 'Yes, barely' : 'Yes'}
          </span>
        )}
      </p>
      {data?.checks.map((c) => (
        <p key={c.key} className={`text-xs ${
          c.level === 'fail' ? 'text-red-300' : c.level === 'warn' ? 'text-amber-300' : 'text-zinc-400'
        }`}>
          {c.level === 'fail' ? '✕ ' : c.level === 'warn' ? '⚠ ' : '✓ '}{c.message}
        </p>
      ))}
    </div>
  );
}

function CampaignProblemBadge({ campaignId }: { campaignId: number }) {
  const { data } = useQuery({
    queryKey: ['campaign-validation-summary'],
    queryFn: fetchCampaignValidationSummary,
    staleTime: 60_000,
  });
  const row = data?.find((r) => r.campaign_id === campaignId);
  if (!row || row.verdict === 'fit') return null;
  return (
    <span title={row.headline ?? 'Validation problem'} className="inline-block ml-1.5 align-middle">
      <AlertTriangle className={`w-3.5 h-3.5 inline -mt-0.5 ${row.verdict === 'refuse' ? 'text-red-400' : 'text-amber-400'}`} />
    </span>
  );
}

// D96 Phase D — delivery ledger: sold / delivered / today's quota /
// shortfall / per-spot rotation / day-by-day forecast, all from
// play_history and the same quota formula the engine gates with.
function CampaignDeliveryPanel({ campaignId }: { campaignId: number }) {
  const { data: ledger } = useQuery({
    queryKey: ['campaign-ledger', campaignId],
    queryFn: () => fetchCampaignLedger(campaignId),
    staleTime: 30_000,
  });
  if (!ledger) return null;
  const pct = ledger.total_plays > 0 ? Math.round((ledger.delivered / ledger.total_plays) * 100) : 0;
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Delivery</p>
      <div className="flex items-center gap-3">
        <div className="flex-1 bg-zinc-700 rounded-full h-2">
          <div
            className={`h-2 rounded-full ${ledger.shortfall > 0 ? 'bg-red-500' : 'bg-green-500'}`}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
        <span className="text-xs text-zinc-300 whitespace-nowrap">
          {ledger.delivered} / {ledger.total_plays} delivered ({pct}%)
        </span>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-400">
        <span>Today: <span className="text-zinc-200">{ledger.delivered_today} / {ledger.quota_today}</span></span>
        <span>Remaining: <span className="text-zinc-200">{ledger.remaining} plays · {ledger.remaining_days} days</span></span>
        {ledger.aborted > 0 && <span>Cut mid-air (not billed): <span className="text-amber-300">{ledger.aborted}</span></span>}
      </div>
      {ledger.shortfall > 0 && (
        <p className="text-xs text-red-300 bg-red-900/20 border border-red-800/60 rounded px-2 py-1.5">
          ⚠ Even at the catch-up limit, {ledger.shortfall} plays cannot be delivered by the end date — extend the campaign or settle the difference.
        </p>
      )}
      {ledger.per_spot.length > 1 && (
        <div className="text-xs text-zinc-400 space-y-0.5">
          {ledger.per_spot.map((sp) => (
            <p key={sp.media_id}>
              <span className="text-zinc-300">{sp.title ?? `media #${sp.media_id}`}</span>
              {' — '}{sp.delivered} plays (weight {sp.weight}{sp.weight === 0 ? ', benched' : ''})
            </p>
          ))}
        </div>
      )}
      {ledger.forecast.length > 0 && ledger.remaining > 0 && (
        <div className="text-xs text-zinc-400">
          <span className="text-zinc-500">Next days: </span>
          {ledger.forecast.slice(0, 14).map((f) => `${f.date.slice(5)}×${f.planned}`).join(' · ')}
          {ledger.forecast.length > 14 && ' …'}
        </div>
      )}
    </div>
  );
}

function AllowedIntervalsPicker({
  intervals,
  value,
  onChange,
  disabled,
}: {
  intervals: BroadcastInterval[];
  value: number[] | null;
  onChange: (v: number[] | null) => void;
  disabled: boolean;
}) {
  const inherit = value == null;
  const toggle = (id: number) => {
    const current = value ?? [];
    onChange(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  };
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={inherit}
          onChange={(e) => onChange(e.target.checked ? null : [])}
          disabled={disabled}
          className="rounded border-zinc-700 text-brand-600 h-4 w-4"
        />
        Use station default airing windows
        <HelpTooltip text="Restriction: the windows this campaign may air in AT ALL. Inherited from the station's standard commercial day unless overridden here. This is the fence — guarantees are minimums inside it." />
      </label>
      {!inherit && (
        <div className="flex flex-wrap gap-2">
          {intervals.map((iv) => {
            const on = (value ?? []).includes(iv.id);
            return (
              <button
                key={iv.id}
                type="button"
                onClick={() => toggle(iv.id)}
                disabled={disabled}
                className={`px-2.5 py-1 text-xs border rounded-md transition-colors disabled:opacity-50 ${
                  on
                    ? 'bg-brand-600/20 border-brand-500 text-brand-300'
                    : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:bg-zinc-700'
                }`}
              >
                {iv.name}
              </button>
            );
          })}
          {(value ?? []).length === 0 && (
            <p className="text-xs text-amber-400 w-full">
              No windows selected — treated as station default until you pick at least one.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function BudgetImpactRow({
  startsOn,
  endsOn,
  totalPlays,
  durationBracket,
  firstInSlot,
}: {
  startsOn: string;
  endsOn: string;
  totalPlays: number;
  durationBracket: number;
  firstInSlot: boolean;
}) {
  const isValid = startsOn.length === 10 && endsOn.length === 10 && totalPlays > 0;

  // Always use the 30-day rolling reference window, not the campaign's own dates.
  const today = new Date().toISOString().slice(0, 10);
  const windowEnd = new Date();
  windowEnd.setDate(windowEnd.getDate() + 30);
  const windowEndStr = windowEnd.toISOString().slice(0, 10);

  const { data, isLoading } = useQuery({
    queryKey: ['spot-budget-30d'],
    queryFn: () => fetchSpotBudget(today, windowEndStr, 'estimated'),
    enabled: isValid,
    staleTime: 5 * 60 * 1000,
  });

  if (!isValid) return null;

  // Pro-rate the campaign's draw to its overlap with the 30-day window.
  const overlapStart = startsOn > today ? startsOn : today;
  const overlapEnd = endsOn < windowEndStr ? endsOn : windowEndStr;
  const overlapDays = Math.max(0, Math.ceil(
    (new Date(overlapEnd).getTime() - new Date(overlapStart).getTime()) / 86400000,
  ));
  // D96: total_plays covers the whole campaign — pro-rate by day overlap.
  const campaignDays = Math.max(1, Math.round(
    (new Date(endsOn).getTime() - new Date(startsOn).getTime()) / 86400000,
  ) + 1);
  const playsInWindow = (overlapDays / campaignDays) * totalPlays;
  const estimatedMinutes = (playsInWindow * durationBracket) / 60;

  const remaining = data ? data.available.global.minutes : null;
  const afterThis = remaining !== null ? remaining - estimatedMinutes : null;

  return (
    <div className="rounded-lg bg-zinc-800/40 border border-zinc-700/50 px-3 py-2 space-y-1">
      <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Budget Impact (next 30 days)</p>
      <div className="flex flex-wrap gap-x-6 gap-y-0.5 text-xs">
        <span>
          <span className="text-zinc-400">Est. draw: </span>
          <span className="text-zinc-300">{fmtMinutes(estimatedMinutes)} min</span>
          {firstInSlot && (
            <span className="text-zinc-500 ml-1">· {overlapDays} first-slot breaks</span>
          )}
        </span>
        {isLoading && <span className="text-zinc-500">Checking availability…</span>}
        {afterThis !== null && !isLoading && (
          <span>
            <span className="text-zinc-400">Remaining after: </span>
            <span className={afterThis < 0 ? 'text-red-400' : 'text-zinc-300'}>
              {fmtMinutes(afterThis)} min
            </span>
            {afterThis < 0 && (
              <span className="text-red-400 ml-1">(over budget)</span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

type SortConfig = { column: string; direction: 'asc' | 'desc' } | null;


function sortRows<T extends object>(rows: T[], sort: SortConfig): T[] {
  if (!sort) return rows;
  return [...rows].sort((a, b) => {
    let aVal: unknown = a[sort.column as keyof T];
    let bVal: unknown = b[sort.column as keyof T];
    if (typeof aVal === 'string') aVal = aVal.toLowerCase();
    if (typeof bVal === 'string') bVal = bVal.toLowerCase();
    const cmp = (aVal as string | number) < (bVal as string | number) ? -1 : (aVal as string | number) > (bVal as string | number) ? 1 : 0;
    return sort.direction === 'asc' ? cmp : -cmp;
  });
}


export function CustomersList() {
  const queryClient = useQueryClient();

  const [focusedCustomerId, setFocusedCustomerId] = useState<number | null>(null);
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<Set<number>>(new Set());
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<Set<number>>(new Set());
  const [selectedContactIds, setSelectedContactIds] = useState<Set<number>>(new Set());
  const [activeTab, setActiveTab] = useState<'campaigns' | 'contacts' | 'music-campaigns'>('campaigns');
  const [editTarget, setEditTarget] = useState<{
    type: 'customer' | 'campaign' | 'contact';
    id: number;
  } | null>(null);
  const [isCreatingCustomer, setIsCreatingCustomer] = useState(false);
  const [isCreatingCampaign, setIsCreatingCampaign] = useState(false);
  const [isCreatingContact, setIsCreatingContact] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{ type: 'success' | 'error' | 'warning'; message: string } | null>(null);
  const [customerSort, setCustomerSort] = useState<SortConfig>(null);
  const [campaignSort, setCampaignSort] = useState<SortConfig>(null);
  const [contactSort, setContactSort] = useState<SortConfig>(null);
  const [focusedCampaignId, setFocusedCampaignId] = useState<number | null>(null);
  const [focusedContactId, setFocusedContactId] = useState<number | null>(null);
  const [confirmDeleteCustomers, setConfirmDeleteCustomers] = useState(false);
  const [confirmingDeleteCustomers, setConfirmingDeleteCustomers] = useState(false);
  const [confirmingDeleteCampaigns, setConfirmingDeleteCampaigns] = useState(false);
  const [confirmingDeleteContacts, setConfirmingDeleteContacts] = useState(false);
  const deleteCustomerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deleteCampaignTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deleteContactTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showSaveStatus = (type: 'success' | 'error' | 'warning', message: string) => {
    setSaveStatus({ type, message });
    setTimeout(() => setSaveStatus(null), 3000);
  };

  useEffect(() => {
    setConfirmingDeleteCustomers(false);
    if (deleteCustomerTimer.current) clearTimeout(deleteCustomerTimer.current);
  }, [selectedCustomerIds]);

  useEffect(() => {
    setConfirmingDeleteCampaigns(false);
    if (deleteCampaignTimer.current) clearTimeout(deleteCampaignTimer.current);
  }, [selectedCampaignIds, focusedCampaignId]);

  useEffect(() => {
    setConfirmingDeleteContacts(false);
    if (deleteContactTimer.current) clearTimeout(deleteContactTimer.current);
  }, [selectedContactIds, focusedContactId]);

  const { data: rawCustomers = [], isLoading } = useQuery({
    queryKey: ['customers'],
    queryFn: fetchCustomers,
  });

  const { data: allCampaigns = [] } = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => fetchCampaigns(),
  });

  const { data: allContactsWithCustomers = [] } = useQuery({
    queryKey: ['contacts-all-with-customers'],
    queryFn: fetchContactsWithCustomers,
  });

  const { data: filteredContacts = [] } = useQuery({
    queryKey: ['contacts', focusedCustomerId],
    queryFn: () => fetchContacts(focusedCustomerId!),
    enabled: focusedCustomerId !== null,
  });

  const { data: allContacts = [] } = useQuery({
    queryKey: ['contacts-all'],
    queryFn: fetchAllContacts,
  });

  const { data: allUsers = [] } = useQuery({
    queryKey: ['users'],
    queryFn: fetchUsers,
  });

  const customers = sortRows(rawCustomers, customerSort);

  const displayedCampaigns = focusedCustomerId
    ? sortRows(
        allCampaigns.filter((c) => c.customer_id === focusedCustomerId),
        campaignSort,
      )
    : sortRows(allCampaigns, campaignSort);

  const displayedContacts = focusedCustomerId
    ? sortRows(filteredContacts, contactSort)
    : sortRows(allContactsWithCustomers, contactSort);

  const isCustomerActive = (customerId: number) =>
    allCampaigns.some((c) => c.customer_id === customerId && c.active);

  const toggleSort = (
    column: string,
    setSortFn: (s: SortConfig) => void,
    currentSort: SortConfig,
  ) => {
    if (currentSort?.column === column) {
      setSortFn(currentSort.direction === 'asc' ? { column, direction: 'desc' } : null);
    } else {
      setSortFn({ column, direction: 'asc' });
    }
  };

  const handleCustomerRowClick = (id: number) => {
    setFocusedCustomerId((prev) => (prev === id ? null : id));
  };

  const toggleCustomerCheckbox = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedCustomerIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allCustomersSelected = customers.length > 0 && customers.every((c) => selectedCustomerIds.has(c.id));
  const toggleAllCustomers = () =>
    setSelectedCustomerIds(allCustomersSelected ? new Set() : new Set(customers.map((c) => c.id)));

  const toggleCampaignCheckbox = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedCampaignIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allCampaignsSelected = displayedCampaigns.length > 0 && displayedCampaigns.every((c) => selectedCampaignIds.has(c.id));
  const toggleAllCampaigns = () =>
    setSelectedCampaignIds(allCampaignsSelected ? new Set() : new Set(displayedCampaigns.map((c) => c.id)));

  const toggleContactCheckbox = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedContactIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allContactsSelected = displayedContacts.length > 0 && (displayedContacts as Array<{ id: number }>).every((c) => selectedContactIds.has(c.id));
  const toggleAllContacts = () =>
    setSelectedContactIds(allContactsSelected ? new Set() : new Set((displayedContacts as Array<{ id: number }>).map((c) => c.id)));

  const clearCustomerFocus = () => {
    setFocusedCustomerId(null);
    setSelectedCustomerIds(new Set());
  };

  const canEditCustomer = selectedCustomerIds.size === 1;
  const editCustomerId = canEditCustomer ? [...selectedCustomerIds][0] : null;

  // Effective delete set: checkboxes take priority; fall back to focused row.
  const effectiveCustomerDeleteIds: number[] =
    selectedCustomerIds.size > 0
      ? [...selectedCustomerIds]
      : focusedCustomerId !== null
        ? [focusedCustomerId]
        : [];
  const canDeleteCustomer = effectiveCustomerDeleteIds.length > 0;

  const canEditCampaign = selectedCampaignIds.size === 1;
  const editCampaignId = canEditCampaign ? [...selectedCampaignIds][0] : null;
  const effectiveCampaignDeleteIds: number[] =
    selectedCampaignIds.size > 0
      ? [...selectedCampaignIds]
      : focusedCampaignId !== null ? [focusedCampaignId] : [];
  const canDeleteCampaign = effectiveCampaignDeleteIds.length > 0;

  const canEditContact = selectedContactIds.size === 1;
  const editContactId = canEditContact ? [...selectedContactIds][0] : null;
  const effectiveContactDeleteIds: number[] =
    selectedContactIds.size > 0
      ? [...selectedContactIds]
      : focusedContactId !== null ? [focusedContactId] : [];
  const canDeleteContact = effectiveContactDeleteIds.length > 0;

  const selectedCustomersHaveCampaigns = effectiveCustomerDeleteIds.some((cid) =>
    allCampaigns.some((c) => c.customer_id === cid),
  );

  const createCustomerMutation = useMutation({
    mutationFn: createCustomer,
    onSuccess: (newCustomer) => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      setIsCreatingCustomer(false);
      setFocusedCustomerId(newCustomer.id);
      setSelectedCustomerIds(new Set([newCustomer.id]));
      showSaveStatus('success', 'Customer created');
    },
    onError: (err) => showSaveStatus('error', (err as Error).message),
  });

  const updateCustomerMutation = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: CustomerPatch }) => updateCustomer(id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      setEditTarget(null);
      showSaveStatus('success', 'Customer updated');
    },
    onError: (err) => showSaveStatus('error', (err as Error).message),
  });

  const deleteCustomersMutation = useMutation({
    mutationFn: (ids: number[]) => deleteCustomers(ids),
    onSuccess: (_, ids) => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-all-with-customers'] });
      setSelectedCustomerIds(new Set());
      setFocusedCustomerId(null);
      setConfirmDeleteCustomers(false);
      showSaveStatus('error', ids.length === 1 ? 'Customer deleted' : `${ids.length} customers deleted`);
    },
    onError: (err) => showSaveStatus('error', (err as Error).message),
  });

  const deleteCustomerMutation = useMutation({
    mutationFn: deleteCustomer,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-all-with-customers'] });
      setSelectedCustomerIds(new Set());
      setFocusedCustomerId(null);
      setEditTarget(null);
      showSaveStatus('error', 'Customer deleted');
    },
    onError: (err) => showSaveStatus('error', (err as Error).message),
  });

  const updateCampaignMutation = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: CampaignPatch }) => updateCampaign(id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      setEditTarget(null);
      showSaveStatus('success', 'Campaign updated');
    },
    onError: (err) => showSaveStatus('error', (err as Error).message),
  });

  const toggleCampaignActiveMutation = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) => updateCampaign(id, { active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['campaigns'] }),
  });

  const deleteCampaignsMutation = useMutation({
    mutationFn: (ids: number[]) => deleteCampaigns(ids),
    onSuccess: (_, ids) => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      setSelectedCampaignIds(new Set());
      showSaveStatus('error', ids.length === 1 ? 'Campaign deleted' : `${ids.length} campaigns deleted`);
    },
    onError: (err) => showSaveStatus('error', (err as Error).message),
  });

  const deleteCampaignMutation = useMutation({
    mutationFn: deleteCampaign,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      setEditTarget(null);
      showSaveStatus('error', 'Campaign deleted');
    },
    onError: (err) => showSaveStatus('error', (err as Error).message),
  });

  const createCampaignMutation = useMutation({
    mutationFn: createCampaign,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      setIsCreatingCampaign(false);
      showSaveStatus('success', 'Campaign created');
    },
    onError: (err) => showSaveStatus('error', (err as Error).message),
  });

  const createContactMutation = useMutation({
    mutationFn: createContact,
    onSuccess: (newContact) => {
      // Append directly to 'contacts-all' so the "pick existing" list is
      // immediately up-to-date without waiting for a network refetch.
      queryClient.setQueryData<Contact[]>(['contacts-all'], (old = []) => [
        ...old,
        newContact,
      ]);

      // Append directly to the per-customer list so the form shows the new
      // contact the moment the server confirms it.
      if (newContact.customer_id !== null) {
        const key = ['contacts', newContact.customer_id];
        queryClient.setQueryData<(Contact & { is_primary: boolean })[]>(key, (old = []) => [
          ...old,
          { ...newContact, is_primary: old.length === 0 },
        ]);
      }

      // Still invalidate so a background refetch reconciles any edge cases.
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-all-with-customers'] });
      setIsCreatingContact(false);
      showSaveStatus('success', 'Contact added');
    },
    onError: (err) => showSaveStatus('error', (err as Error).message),
  });

  const deleteContactsMutation = useMutation({
    mutationFn: (ids: number[]) => deleteContacts(ids),
    onSuccess: (_, ids) => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-all'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-all-with-customers'] });
      setSelectedContactIds(new Set());
      showSaveStatus('error', ids.length === 1 ? 'Contact deleted' : `${ids.length} contacts deleted`);
    },
    onError: (err) => showSaveStatus('error', (err as Error).message),
  });

  const associateContactMutation = useMutation({
    mutationFn: ({ customerId, contactId, isPrimary }: { customerId: number; contactId: number; isPrimary?: boolean }) =>
      associateContact(customerId, contactId, isPrimary),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-all-with-customers'] });
    },
    onError: (err) => showSaveStatus('error', (err as Error).message),
  });

  const dissociateContactMutation = useMutation({
    mutationFn: ({ customerId, contactId }: { customerId: number; contactId: number }) =>
      dissociateContact(customerId, contactId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-all-with-customers'] });
    },
    onError: (err) => showSaveStatus('error', (err as Error).message),
  });

  const setPrimaryMutation = useMutation({
    mutationFn: ({
      customerId,
      contactId,
      isPrimary,
    }: {
      customerId: number;
      contactId: number;
      isPrimary: boolean;
    }) => setContactPrimary(customerId, contactId, isPrimary),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-all-with-customers'] });
    },
    onError: (err) => showSaveStatus('error', (err as Error).message),
  });

  const updateContactMutation = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: ContactPatch }) => updateContact(id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-all-with-customers'] });
      setEditTarget(null);
      showSaveStatus('success', 'Contact updated');
    },
    onError: (err) => showSaveStatus('error', (err as Error).message),
  });

  const deleteContactMutation = useMutation({
    mutationFn: deleteContact,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-all'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-all-with-customers'] });
      setEditTarget(null);
      showSaveStatus('error', 'Contact deleted');
    },
    onError: (err) => showSaveStatus('error', (err as Error).message),
  });

  const handleDeleteCustomers = () => {
    if (selectedCustomersHaveCampaigns) {
      setConfirmingDeleteCustomers(false);
      if (deleteCustomerTimer.current) clearTimeout(deleteCustomerTimer.current);
      setConfirmDeleteCustomers(true);
    } else if (confirmingDeleteCustomers) {
      if (deleteCustomerTimer.current) clearTimeout(deleteCustomerTimer.current);
      setConfirmingDeleteCustomers(false);
      deleteCustomersMutation.mutate(effectiveCustomerDeleteIds);
    } else {
      setConfirmingDeleteCustomers(true);
      deleteCustomerTimer.current = setTimeout(() => setConfirmingDeleteCustomers(false), 4000);
    }
  };

  const handleDeleteCampaigns = () => {
    if (confirmingDeleteCampaigns) {
      if (deleteCampaignTimer.current) clearTimeout(deleteCampaignTimer.current);
      setConfirmingDeleteCampaigns(false);
      deleteCampaignsMutation.mutate(effectiveCampaignDeleteIds);
    } else {
      setConfirmingDeleteCampaigns(true);
      deleteCampaignTimer.current = setTimeout(() => setConfirmingDeleteCampaigns(false), 4000);
    }
  };

  const handleDeleteContacts = () => {
    if (confirmingDeleteContacts) {
      if (deleteContactTimer.current) clearTimeout(deleteContactTimer.current);
      setConfirmingDeleteContacts(false);
      deleteContactsMutation.mutate(effectiveContactDeleteIds);
    } else {
      setConfirmingDeleteContacts(true);
      deleteContactTimer.current = setTimeout(() => setConfirmingDeleteContacts(false), 4000);
    }
  };


  if (isLoading)
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader className="w-8 h-8 animate-spin text-brand-500" />
      </div>
    );

  const focusedCustomerName = focusedCustomerId
    ? customers.find((c) => c.id === focusedCustomerId)?.name
    : null;

  return (
    <div className="space-y-2 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold text-white flex-shrink-0">Customers ({customers.length})</h1>
        <div className="flex-1 min-w-0">
          <SaveStatus status={saveStatus} />
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => setIsCreatingCustomer(true)}
            className={BTN_PRIMARY_SM}
          >
            <Plus className="w-3.5 h-3.5" />
            New Customer
          </button>
          <button
            onClick={() => {
              if (editCustomerId) setEditTarget({ type: 'customer', id: editCustomerId });
            }}
            disabled={!canEditCustomer}
            className={BTN_SECONDARY_SM}
          >
            <Pencil className="w-3.5 h-3.5" />
            Edit
          </button>
          <button
            onClick={handleDeleteCustomers}
            disabled={!canDeleteCustomer || deleteCustomersMutation.isPending}
            title={!canDeleteCustomer ? 'Select customers to delete' : undefined}
            className={`${BTN_DESTRUCTIVE_SM} ${confirmingDeleteCustomers ? 'ring-2 ring-red-400 ring-offset-1 ring-offset-zinc-900 animate-pulse' : ''}`}
          >
            <Trash2 className="w-3.5 h-3.5" />
            {confirmingDeleteCustomers
              ? 'Click again to delete'
              : `Delete${effectiveCustomerDeleteIds.length > 0 ? ` (${effectiveCustomerDeleteIds.length})` : ''}`}
          </button>
        </div>
      </div>

      {/* Bulk customer delete confirm dialog */}
      {confirmDeleteCustomers && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-md p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm text-zinc-100 font-medium">
              Delete {effectiveCustomerDeleteIds.length} customer{effectiveCustomerDeleteIds.length > 1 ? 's' : ''}?
            </p>
            <p className="text-xs text-amber-400">
              Warning: these customers have active campaigns that will also be deleted.
            </p>
            <p className="text-xs text-zinc-400">This cannot be undone.</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDeleteCustomers(false)}
                disabled={deleteCustomersMutation.isPending}
                className="px-4 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteCustomersMutation.mutate(effectiveCustomerDeleteIds)}
                disabled={deleteCustomersMutation.isPending}
                className="px-4 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
              >
                {deleteCustomersMutation.isPending ? 'Deleting…' : 'Yes, delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Global Spot Budget Panel */}
      <GlobalBudgetPanel />

      {/* TOP: Customers Table */}
      <div className="flex-1 min-h-0 flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-800/60 sticky top-0">
              <tr className="border-b border-zinc-700">
                <th className="px-4 py-2 w-10 border-r border-zinc-700">
                  <input
                    type="checkbox"
                    checked={allCustomersSelected}
                    onChange={toggleAllCustomers}
                    className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-brand-600 focus:ring-brand-500 focus:ring-offset-0 cursor-pointer"
                  />
                </th>
                <SortableHeader
                  label="Name"
                  column="name"
                  isActive={customerSort?.column === 'name'}
                  direction={customerSort?.direction}
                  onSort={() => toggleSort('name', setCustomerSort, customerSort)}
                />
                <SortableHeader
                  label="Email"
                  column="email"
                  isActive={customerSort?.column === 'email'}
                  direction={customerSort?.direction}
                  onSort={() => toggleSort('email', setCustomerSort, customerSort)}
                />
                <th className="px-4 py-2 text-left text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {customers.map((customer) => (
                <tr
                  key={customer.id}
                  onClick={() => handleCustomerRowClick(customer.id)}
                  onDoubleClick={() => setEditTarget({ type: 'customer', id: customer.id })}
                  title="Double-click to edit"
                  className={`cursor-pointer transition-colors ${
                    focusedCustomerId === customer.id
                      ? 'bg-brand-600/20'
                      : 'hover:bg-zinc-800/50'
                  }`}
                >
                  <td className="px-4 py-3 border-r border-zinc-800/60" onClick={(e) => toggleCustomerCheckbox(customer.id, e)}>
                    <input
                      type="checkbox"
                      checked={selectedCustomerIds.has(customer.id)}
                      onChange={() => {}}
                      className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-brand-600 focus:ring-brand-500 focus:ring-offset-0 cursor-pointer"
                    />
                  </td>
                  <td className="px-6 py-3 font-medium text-white">{customer.name}</td>
                  <td className="px-6 py-3 text-zinc-300">{customer.email || '—'}</td>
                  <td className="px-6 py-3">
                    {isCustomerActive(customer.id) ? (
                      <span className="text-xs px-2 py-1 rounded bg-green-900/30 text-green-300">
                        Active
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-1 rounded bg-zinc-800 text-zinc-400">
                        No active campaigns
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {customers.length === 0 && (
            <div className="p-6 text-center text-zinc-300 text-sm">
              No customers. Create one to get started.
            </div>
          )}
        </div>
      </div>

      {/* BOTTOM: Campaigns / Contacts — always visible */}
      <div className="flex-1 min-h-0 flex flex-col bg-slate-950 border border-brand-900/50 rounded-lg overflow-hidden">
        {/* Tab bar + filter chip */}
        <div className="flex items-center border-b border-brand-900/30 bg-slate-900/50">
          <button
            onClick={() => setActiveTab('campaigns')}
            className={`px-4 py-3 text-sm font-medium transition-colors rounded-t ${
              activeTab === 'campaigns'
                ? 'text-white bg-zinc-800'
                : 'text-zinc-300 hover:text-white hover:bg-zinc-800/50'
            }`}
          >
            Campaigns ({displayedCampaigns.length})
          </button>
          <button
            onClick={() => setActiveTab('music-campaigns')}
            className={`px-4 py-3 text-sm font-medium transition-colors rounded-t ${
              activeTab === 'music-campaigns'
                ? 'text-white bg-zinc-800'
                : 'text-zinc-300 hover:text-white hover:bg-zinc-800/50'
            }`}
          >
            Music Campaigns
          </button>
          <button
            onClick={() => setActiveTab('contacts')}
            className={`px-4 py-3 text-sm font-medium transition-colors rounded-t ${
              activeTab === 'contacts'
                ? 'text-white bg-zinc-800'
                : 'text-zinc-300 hover:text-white hover:bg-zinc-800/50'
            }`}
          >
            Contacts ({displayedContacts.length})
          </button>
          <div className="flex-1" />
          {focusedCustomerId && focusedCustomerName && (
            <div className="mr-3 flex items-center gap-1.5 px-2.5 py-1 bg-brand-900/30 border border-brand-700/50 rounded-lg text-xs text-brand-300">
              <span>
                {focusedCustomerName}
                {selectedCustomerIds.size > 1 && (
                  <span className="ml-1 text-brand-400">+{selectedCustomerIds.size - 1} more</span>
                )}
              </span>
              <button onClick={clearCustomerFocus} className="hover:text-white">
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {activeTab === 'campaigns' ? (
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="flex items-center gap-3 px-5 py-3 border-b border-zinc-800 bg-zinc-800/30">
                <h2 className="text-sm font-semibold text-white flex-shrink-0">
                  Campaigns ({displayedCampaigns.length})
                </h2>
                <div className="flex-1" />
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => { if (focusedCustomerId) setIsCreatingCampaign(true); }}
                    disabled={!focusedCustomerId}
                    title={!focusedCustomerId ? 'Select a customer first' : undefined}
                    className={BTN_PRIMARY_SM}
                  >
                    <Plus className="w-3.5 h-3.5" />
                    New Campaign
                  </button>
                  <button
                    onClick={() => { if (editCampaignId) setEditTarget({ type: 'campaign', id: editCampaignId }); }}
                    disabled={!canEditCampaign}
                    className={BTN_SECONDARY_SM}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    Edit
                  </button>
                  <button
                    onClick={handleDeleteCampaigns}
                    disabled={!canDeleteCampaign || deleteCampaignsMutation.isPending}
                    title={!canDeleteCampaign ? 'Select campaigns to delete' : undefined}
                    className={`${BTN_DESTRUCTIVE_SM} ${confirmingDeleteCampaigns ? 'ring-2 ring-red-400 ring-offset-1 ring-offset-zinc-900 animate-pulse' : ''}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    {confirmingDeleteCampaigns
                      ? 'Click again to delete'
                      : `Delete${effectiveCampaignDeleteIds.length > 0 ? ` (${effectiveCampaignDeleteIds.length})` : ''}`}
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-800/60 sticky top-0">
                    <tr className="border-b border-zinc-700">
                      <th className="px-4 py-2 w-10 border-r border-zinc-700">
                        <input
                          type="checkbox"
                          checked={allCampaignsSelected}
                          onChange={toggleAllCampaigns}
                          className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-brand-600 focus:ring-brand-500 focus:ring-offset-0 cursor-pointer"
                        />
                      </th>
                      {!focusedCustomerId && (
                        <th className="px-4 py-2 text-left text-xs font-semibold text-zinc-400 uppercase tracking-wider border-r border-zinc-700">
                          Customer
                        </th>
                      )}
                      <SortableHeader
                        label="Name"
                        column="name"
                        isActive={campaignSort?.column === 'name'}
                        direction={campaignSort?.direction}
                        onSort={() => toggleSort('name', setCampaignSort, campaignSort)}
                      />
                      <SortableHeader
                        label="Total plays"
                        column="total_plays"
                        isActive={campaignSort?.column === 'total_plays'}
                        direction={campaignSort?.direction}
                        onSort={() =>
                          toggleSort('total_plays', setCampaignSort, campaignSort)
                        }
                      />
                      <SortableHeader
                        label="Period"
                        column="starts_on"
                        isActive={campaignSort?.column === 'starts_on'}
                        direction={campaignSort?.direction}
                        onSort={() => toggleSort('starts_on', setCampaignSort, campaignSort)}
                      />
                      <th className="px-4 py-2 text-left text-xs font-semibold text-zinc-400 uppercase tracking-wider border-r border-zinc-700">
                        Pacing
                      </th>
                      <th className="px-4 py-2 text-left text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                        Active
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800">
                    {displayedCampaigns.map((campaign) => (
                      <CampaignTableRow
                        key={campaign.id}
                        campaign={campaign}
                        showCustomer={!focusedCustomerId}
                        isSelected={selectedCampaignIds.has(campaign.id)}
                        isFocused={focusedCampaignId === campaign.id}
                        onToggle={(e) => toggleCampaignCheckbox(campaign.id, e)}
                        onRowClick={() => setFocusedCampaignId((prev) => prev === campaign.id ? null : campaign.id)}
                        onEdit={() => setEditTarget({ type: 'campaign', id: campaign.id })}
                        onToggleActive={(active) => toggleCampaignActiveMutation.mutate({ id: campaign.id, active })}
                      />
                    ))}
                  </tbody>
                </table>

                {displayedCampaigns.length === 0 && (
                  <div className="p-4 text-center text-zinc-300 text-sm">No campaigns</div>
                )}
              </div>
            </div>
          ) : activeTab === 'music-campaigns' ? (
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              <MusicCampaignsPage showSaveStatus={showSaveStatus} focusedCustomerId={focusedCustomerId} />
            </div>
          ) : (
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="flex items-center gap-3 px-5 py-3 border-b border-zinc-800 bg-zinc-800/30">
                <h2 className="text-sm font-semibold text-white flex-shrink-0">
                  Contacts ({displayedContacts.length})
                </h2>
                <div className="flex-1" />
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => { if (focusedCustomerId) setIsCreatingContact(true); }}
                    disabled={!focusedCustomerId}
                    title={!focusedCustomerId ? 'Select a customer first' : undefined}
                    className={BTN_PRIMARY_SM}
                  >
                    <Plus className="w-3.5 h-3.5" />
                    New Contact
                  </button>
                  <button
                    onClick={() => { if (editContactId) setEditTarget({ type: 'contact', id: editContactId }); }}
                    disabled={!canEditContact}
                    className={BTN_SECONDARY_SM}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    Edit
                  </button>
                  <button
                    onClick={handleDeleteContacts}
                    disabled={!canDeleteContact || deleteContactsMutation.isPending}
                    title={!canDeleteContact ? 'Select contacts to delete' : undefined}
                    className={`${BTN_DESTRUCTIVE_SM} ${confirmingDeleteContacts ? 'ring-2 ring-red-400 ring-offset-1 ring-offset-zinc-900 animate-pulse' : ''}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    {confirmingDeleteContacts
                      ? 'Click again to delete'
                      : `Delete${effectiveContactDeleteIds.length > 0 ? ` (${effectiveContactDeleteIds.length})` : ''}`}
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-800/60 sticky top-0">
                    <tr className="border-b border-zinc-700">
                      <th className="px-4 py-2 w-10 border-r border-zinc-700">
                        <input
                          type="checkbox"
                          checked={allContactsSelected}
                          onChange={toggleAllContacts}
                          className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-brand-600 focus:ring-brand-500 focus:ring-offset-0 cursor-pointer"
                        />
                      </th>
                      {!focusedCustomerId && (
                        <th className="px-4 py-2 text-left text-xs font-semibold text-zinc-400 uppercase tracking-wider border-r border-zinc-700">
                          Customer(s)
                        </th>
                      )}
                      <SortableHeader
                        label="Name"
                        column="name"
                        isActive={contactSort?.column === 'name'}
                        direction={contactSort?.direction}
                        onSort={() => toggleSort('name', setContactSort, contactSort)}
                      />
                      <SortableHeader
                        label="Email"
                        column="email"
                        isActive={contactSort?.column === 'email'}
                        direction={contactSort?.direction}
                        onSort={() => toggleSort('email', setContactSort, contactSort)}
                      />
                      <SortableHeader
                        label="Phone"
                        column="phone"
                        isActive={contactSort?.column === 'phone'}
                        direction={contactSort?.direction}
                        onSort={() => toggleSort('phone', setContactSort, contactSort)}
                      />
                      <SortableHeader
                        label="Role"
                        column="role"
                        isActive={contactSort?.column === 'role'}
                        direction={contactSort?.direction}
                        onSort={() => toggleSort('role', setContactSort, contactSort)}
                      />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800">
                    {displayedContacts.map((contact) => {
                      const withCustomers = contact as Contact & {
                        customer_names?: string[];
                        is_primary?: boolean;
                      };
                      return (
                        <tr
                          key={contact.id}
                          onClick={() => setFocusedContactId((prev) => prev === contact.id ? null : contact.id)}
                          onDoubleClick={() => setEditTarget({ type: 'contact', id: contact.id })}
                          title="Double-click to edit"
                          className={`cursor-pointer transition-colors ${
                            selectedContactIds.has(contact.id) || focusedContactId === contact.id
                              ? 'bg-brand-600/20'
                              : 'hover:bg-slate-900/50'
                          }`}
                        >
                          <td className="px-4 py-3 border-r border-zinc-800/60" onClick={(e) => toggleContactCheckbox(contact.id, e)}>
                            <input
                              type="checkbox"
                              checked={selectedContactIds.has(contact.id)}
                              onChange={() => {}}
                              className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-brand-600 focus:ring-brand-500 focus:ring-offset-0 cursor-pointer"
                            />
                          </td>
                          {!focusedCustomerId && (
                            <td className="px-6 py-3 text-zinc-400">
                              {withCustomers.customer_names?.join(', ') || '—'}
                            </td>
                          )}
                          <td className="px-6 py-3 font-medium text-white">{contact.name}</td>
                          <td className="px-6 py-3 text-zinc-300">{contact.email || '—'}</td>
                          <td className="px-6 py-3 text-zinc-300">{contact.phone || '—'}</td>
                          <td className="px-6 py-3 text-zinc-300">
                            <span className="text-xs px-2 py-0.5 bg-slate-800 rounded">
                              {contact.role || 'General'}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {displayedContacts.length === 0 && (
                  <div className="p-4 text-center text-zinc-300 text-sm">No contacts</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Create Modals */}
      {isCreatingCustomer && (
        <CreateModal title="New Customer" onClose={() => setIsCreatingCustomer(false)}>
          <CreateCustomerForm
            users={allUsers}
            onSubmit={(data) => createCustomerMutation.mutate(data)}
            onCancel={() => setIsCreatingCustomer(false)}
            isLoading={createCustomerMutation.isPending}
          />
        </CreateModal>
      )}

      {isCreatingCampaign && focusedCustomerId && (
        <CreateModal title="New Campaign" onClose={() => setIsCreatingCampaign(false)}>
          <CreateCampaignForm
            customers={customers}
            defaultCustomerId={focusedCustomerId}
            allCampaigns={allCampaigns}
            onSubmit={(data) => createCampaignMutation.mutate(data)}
            onCancel={() => setIsCreatingCampaign(false)}
            isLoading={createCampaignMutation.isPending}
          />
        </CreateModal>
      )}

      {isCreatingContact && focusedCustomerId && (
        <CreateModal title="New Contact" onClose={() => setIsCreatingContact(false)}>
          <CreateContactForm
            customerId={focusedCustomerId}
            onSubmit={(data) => createContactMutation.mutate(data)}
            onCancel={() => setIsCreatingContact(false)}
            isLoading={createContactMutation.isPending}
          />
        </CreateModal>
      )}

      {/* Edit Modal */}
      {editTarget && (
        <EditModal
          target={editTarget}
          customers={customers}
          campaigns={allCampaigns}
          contacts={filteredContacts}
          allContacts={allContacts}
          users={allUsers}
          onClose={() => setEditTarget(null)}
          onUpdateCustomer={(id, patch) => updateCustomerMutation.mutate({ id, patch })}
          onDeleteCustomer={(id) => deleteCustomerMutation.mutate(id)}
          onCreateContact={(data) => createContactMutation.mutate(data)}
          onAssociateContact={(customerId, contactId, isPrimary) =>
            associateContactMutation.mutate({ customerId, contactId, isPrimary })
          }
          onDissociateContact={(customerId, contactId) =>
            dissociateContactMutation.mutate({ customerId, contactId })
          }
          onSetPrimary={(customerId, contactId, isPrimary) =>
            setPrimaryMutation.mutate({ customerId, contactId, isPrimary })
          }
          onUpdateCampaign={(id, patch) => updateCampaignMutation.mutate({ id, patch })}
          onDeleteCampaign={(id) => deleteCampaignMutation.mutate(id)}
          onUpdateContact={(id, patch) => updateContactMutation.mutate({ id, patch })}
          onDeleteContact={(id) => deleteContactMutation.mutate(id)}
          isUpdating={
            updateCustomerMutation.isPending ||
            updateCampaignMutation.isPending ||
            updateContactMutation.isPending
          }
          isDeleting={
            deleteCustomerMutation.isPending ||
            deleteCampaignMutation.isPending ||
            deleteContactMutation.isPending
          }
        />
      )}
    </div>
  );
}

function SortableHeader({
  label,
  column,
  isActive,
  direction,
  onSort,
  borderColor = 'border-zinc-700',
}: {
  label: string;
  column: string;
  isActive: boolean;
  direction?: 'asc' | 'desc';
  onSort: () => void;
  borderColor?: string;
}) {
  const Icon = isActive && direction === 'desc' ? ChevronDown : ChevronUp;
  return (
    <th
      onClick={onSort}
      className={`px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider cursor-pointer select-none transition-colors border-r ${borderColor} ${isActive ? 'text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
    >
      <span className="flex items-center gap-1">
        {label}
        <Icon className={`w-4 h-4 flex-shrink-0 ${isActive ? 'text-brand-400' : 'text-zinc-400'}`} />
      </span>
    </th>
  );
}

function CreateModal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-zinc-700 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-700 rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function CreateCustomerForm({
  users,
  onSubmit,
  onCancel,
  isLoading,
}: {
  users: User[];
  onSubmit: (data: CustomerCreate) => void;
  onCancel: () => void;
  isLoading: boolean;
}) {
  const { register, handleSubmit, formState } = useForm<CustomerCreate>({
    resolver: zodResolver(CustomerCreateSchema),
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <div className="px-6 py-5 space-y-4">
        <div>
          <label className={LABEL}>Name *</label>
          <input
            type="text"
            {...register('name')}
            disabled={isLoading}
            className={INPUT}
            placeholder="ACME Corp"
          />
          {formState.errors.name && (
            <p className="text-red-400 text-xs mt-1">{formState.errors.name.message}</p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>Email</label>
            <input type="email" {...register('email')} disabled={isLoading} className={INPUT} />
            {formState.errors.email && (
              <p className="text-red-400 text-xs mt-1">{formState.errors.email.message}</p>
            )}
          </div>
          <div>
            <label className={LABEL}>Phone</label>
            <input type="text" {...register('phone')} disabled={isLoading} className={INPUT} />
          </div>
        </div>
        <div>
          <label className={LABEL}>Account Manager</label>
          <select
            {...register('account_manager_id', { setValueAs: (v) => (v === '' ? null : Number(v)) })}
            disabled={isLoading}
            className={INPUT}
          >
            <option value="">— None —</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.first_name} {u.last_name}
                {u.account_name ? ` (${u.account_name})` : ''}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={LABEL}>Notes</label>
          <textarea {...register('notes')} disabled={isLoading} rows={2} className={INPUT} />
        </div>
      </div>
      <div className="px-6 py-4 border-t border-zinc-700 flex justify-end gap-2 bg-zinc-800/50 rounded-b-xl">
        <button
          type="button"
          onClick={onCancel}
          disabled={isLoading}
          className="px-4 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isLoading}
          className="px-4 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
        >
          {isLoading ? 'Creating…' : 'Create Customer'}
        </button>
      </div>
    </form>
  );
}

function CampaignExclusionPicker({
  allCampaigns,
  excludeId,
  value,
  onChange,
  disabled,
}: {
  allCampaigns: (Campaign & { customer_name: string })[];
  excludeId: number | null;
  value: number[];
  onChange: (ids: number[]) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const available = allCampaigns.filter(c => c.id !== excludeId);
  const selected = allCampaigns.filter(c => value.includes(c.id));
  const toggle = (id: number) =>
    onChange(value.includes(id) ? value.filter(x => x !== id) : [...value, id]);

  return (
    <div className="space-y-2">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map(c => (
            <span key={c.id} className="flex items-center gap-1 px-2 py-0.5 bg-rose-900/30 border border-rose-700/50 rounded text-xs text-rose-300">
              {c.name}
              {!disabled && (
                <button type="button" onClick={() => toggle(c.id)} className="hover:text-white ml-0.5">
                  <X className="w-3 h-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {available.length > 0 ? (
        open ? (
          <div className="border border-zinc-700 rounded-lg overflow-hidden">
            <div className="max-h-40 overflow-y-auto divide-y divide-zinc-800">
              {available.map(c => (
                <label key={c.id} className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-zinc-800">
                  <input
                    type="checkbox"
                    checked={value.includes(c.id)}
                    onChange={() => toggle(c.id)}
                    disabled={disabled}
                    className="rounded border-zinc-600 text-rose-500 h-3.5 w-3.5"
                  />
                  <span className="text-sm text-white flex-1 truncate">{c.name}</span>
                  <span className="text-xs text-zinc-400 shrink-0">{c.customer_name}</span>
                </label>
              ))}
            </div>
            <button type="button" onClick={() => setOpen(false)} className="w-full px-3 py-1.5 text-xs text-zinc-400 hover:text-white bg-zinc-800/50 border-t border-zinc-700 text-left transition-colors">
              Done
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setOpen(true)} disabled={disabled} className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-white transition-colors py-1">
            <Plus className="w-3.5 h-3.5" />
            {selected.length === 0 ? 'Add exclusion' : 'Add more'}
          </button>
        )
      ) : (
        <p className="text-xs text-zinc-500">No other campaigns to exclude.</p>
      )}
    </div>
  );
}

function CreateCampaignForm({
  customers,
  defaultCustomerId,
  allCampaigns,
  onSubmit,
  onCancel,
  isLoading,
}: {
  customers: Customer[];
  defaultCustomerId: number;
  allCampaigns: (Campaign & { customer_name: string })[];
  onSubmit: (data: CampaignCreate) => void;
  onCancel: () => void;
  isLoading: boolean;
}) {
  const { data: shows = [] }     = useQuery<Show[]>({ queryKey: ['shows'], queryFn: fetchShows });
  const { data: intervals = [] } = useQuery<BroadcastInterval[]>({ queryKey: ['intervals'], queryFn: fetchIntervals });

  const { control, register, handleSubmit, formState, setValue } = useForm<CampaignCreate>({
    resolver: zodResolver(CampaignCreateSchema),
    defaultValues: {
      customer_id: defaultCustomerId,
      total_plays: 90,
      pacing_mode: 'even',
      allowed_interval_ids: null,
      advertiser_separation_spots: 1,
      competing_exclusions: [],
      first_in_slot: false,
      first_in_slot_mode: 'always',
      show_id: null,
      plays_per_show: null,
    },
  });

  const { field: exclusionsField } = useController({ name: 'competing_exclusions', control });
  const { field: allowedField } = useController({ name: 'allowed_interval_ids', control });
  const allFormValues  = useWatch({ control });
  const firstInSlot    = useWatch({ control, name: 'first_in_slot' });
  const selectedShowId = useWatch({ control, name: 'show_id' });
  const selectedIntervalId = useWatch({ control, name: 'interval_id' });
  const watchedStartsOn    = useWatch({ control, name: 'starts_on' }) ?? '';
  const watchedEndsOn      = useWatch({ control, name: 'ends_on' }) ?? '';
  const watchedPlays       = useWatch({ control, name: 'total_plays' }) ?? 0;
  const watchedDuration    = useWatch({ control, name: 'duration_bracket' }) ?? 30;

  // Broadcast Interval and Associated Show are mutually exclusive
  useEffect(() => { if (selectedIntervalId) { setValue('show_id', null); setValue('plays_per_show', null); } }, [selectedIntervalId]);
  useEffect(() => { if (selectedShowId) { setValue('interval_id', null); setValue('interval_plays_per_day', null); } }, [selectedShowId]);

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <div className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">
        <div>
          <label className={LABEL}>Customer *</label>
          <select {...register('customer_id', { valueAsNumber: true })} disabled={isLoading} className={INPUT}>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className={LABEL}>Campaign Name *</label>
          <input type="text" {...register('name')} disabled={isLoading} className={INPUT} placeholder="Summer Campaign 2026" />
          {formState.errors.name && <p className="text-red-400 text-xs mt-1">{formState.errors.name.message}</p>}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>
              Start Date *
              <HelpTooltip text="The first date this campaign is eligible to air." />
            </label>
            <input type="date" {...register('starts_on')} min={new Date().toISOString().slice(0, 10)} disabled={isLoading} className={INPUT} />
            {formState.errors.starts_on && <p className="text-red-400 text-xs mt-1">{formState.errors.starts_on.message}</p>}
          </div>
          <div>
            <label className={LABEL}>
              End Date *
              <HelpTooltip text="The last date this campaign is eligible to air. No plays are scheduled after this date." />
            </label>
            <input type="date" {...register('ends_on')} disabled={isLoading} className={INPUT} />
            {formState.errors.ends_on && <p className="text-red-400 text-xs mt-1">{formState.errors.ends_on.message}</p>}
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Spot Pacing</p>
          <div>
            <label className={LABEL}>
              Duration Bracket *
              <HelpTooltip text="The sold slot length for this campaign. Clips longer than this bracket cannot be attached." />
            </label>
            <select {...register('duration_bracket', { valueAsNumber: true })} disabled={isLoading} className={INPUT}>
              <option value="" className="bg-zinc-900">— Select —</option>
              {[15,30,45,60,90].map((s) => (
                <option key={s} value={s} className="bg-zinc-900">{s}s</option>
              ))}
            </select>
            {formState.errors.duration_bracket && <p className="text-red-400 text-xs mt-1">{formState.errors.duration_bracket.message}</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>
                Total Plays *
                <HelpTooltip text="Total number of spot airings sold for the whole campaign period (start to end date). Daily pacing is derived automatically and self-corrects; the monthly invoice bills what actually aired." />
              </label>
              <input type="number" min={1} {...register('total_plays', { valueAsNumber: true })} disabled={isLoading} className={INPUT} />
              {formState.errors.total_plays && <p className="text-red-400 text-xs mt-1">{formState.errors.total_plays.message}</p>}
            </div>
            <div>
              <label className={LABEL}>
                Max Plays / Day
                <HelpTooltip text="Hard cap on how many times spots can air in a single day. Leave blank for no daily limit." />
              </label>
              <input
                type="number"
                min={1}
                placeholder="No limit"
                {...register('max_plays_per_day', { setValueAs: v => (v === '' || v == null) ? null : Number(v) })}
                disabled={isLoading}
                className={INPUT}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>
                Min Gap Between Plays
                <HelpTooltip text="Minimum minutes between two plays of this campaign — keeps spots from clustering ('not twice in the same hour'). Blank = no gap rule." />
              </label>
              <input type="number" min={1} placeholder="No gap rule" {...register('min_gap_minutes', { setValueAs: v => (v === '' || v == null) ? null : Number(v) })} disabled={isLoading} className={INPUT} />
            </div>
            <div>
              <label className={LABEL}>
                Catch-up Limit (× pace)
                <HelpTooltip text="After missed days, the daily rate may rise up to this multiple of the campaign's original even pace. Blank = station default. Debt that can't fit under the limit surfaces as a shortfall alert instead of being crammed." />
              </label>
              <input type="number" min={1} step={0.5} placeholder="Station default" {...register('catch_up_factor', { setValueAs: v => (v === '' || v == null) ? null : Number(v) })} disabled={isLoading} className={INPUT} />
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Sweep Pacing</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>
                Sweeps / Month
                <HelpTooltip text="Target number of sweep airings per calendar month. Leave blank to disable sweeps for this campaign." />
              </label>
              <input
                type="number"
                min={0}
                placeholder="No sweeps"
                {...register('sweeps_per_month', { setValueAs: v => (v === '' || v == null) ? null : Number(v) })}
                disabled={isLoading}
                className={INPUT}
              />
            </div>
            <div>
              <label className={LABEL}>
                Max Sweeps / Day
                <HelpTooltip text="Hard cap on sweep plays per day. Only relevant when sweeps are configured." />
              </label>
              <input
                type="number"
                min={1}
                placeholder="No limit"
                {...register('max_sweeps_per_day', { setValueAs: v => (v === '' || v == null) ? null : Number(v) })}
                disabled={isLoading}
                className={INPUT}
              />
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Airing Windows</p>
          <AllowedIntervalsPicker
            intervals={intervals}
            value={allowedField.value ?? null}
            onChange={allowedField.onChange}
            disabled={isLoading}
          />
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Guarantees</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL + (selectedShowId ? ' opacity-40' : '')}>
                Guaranteed Interval
                <HelpTooltip text="Pay-extra guarantee: at least N plays every day inside this named window. A minimum, not a fence — other plays still land anywhere in the allowed airing windows. Mutually exclusive with a show guarantee." />
              </label>
              <select
                {...register('interval_id', { setValueAs: v => v === '' ? null : Number(v) })}
                disabled={isLoading || !!selectedShowId}
                className={INPUT + (selectedShowId ? ' opacity-40' : '')}
              >
                <option value="">No interval</option>
                {intervals.map((iv) => (
                  <option key={iv.id} value={iv.id}>{iv.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL + (!selectedIntervalId || selectedShowId ? ' opacity-40' : '')}>
                Guaranteed Plays / Day
                <HelpTooltip text="How many plays are guaranteed inside the selected interval each day. Counts within Total Plays, never on top of it." />
              </label>
              <input
                type="number"
                min={1}
                placeholder="—"
                {...register('interval_plays_per_day', { setValueAs: v => (v === '' || v == null) ? null : Number(v) })}
                disabled={isLoading || !selectedIntervalId || !!selectedShowId}
                className={INPUT + (!selectedIntervalId || selectedShowId ? ' opacity-40' : '')}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL + (selectedIntervalId ? ' opacity-40' : '')}>
                Associated Show
                <HelpTooltip text="Guarantee: at least N plays in every airing of this show. A minimum, not a fence. Mutually exclusive with an interval guarantee." />
              </label>
              <select
                {...register('show_id', { setValueAs: v => v === '' ? null : Number(v) })}
                disabled={isLoading || !!selectedIntervalId}
                className={INPUT + (selectedIntervalId ? ' opacity-40' : '')}
              >
                <option value="">Any show</option>
                {shows.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL + (!selectedShowId || selectedIntervalId ? ' opacity-40' : '')}>
                Guaranteed Plays / Airing
                <HelpTooltip text="How many plays are guaranteed in each airing of the selected show. Counts within Total Plays." />
              </label>
              <input
                type="number"
                min={1}
                placeholder="—"
                {...register('plays_per_show', { setValueAs: v => (v === '' || v == null) ? null : Number(v) })}
                disabled={isLoading || !selectedShowId || !!selectedIntervalId}
                className={INPUT + (!selectedShowId || selectedIntervalId ? ' opacity-40' : '')}
              />
            </div>
          </div>
        </div>

        <div className="pt-1 space-y-3">
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Placement Constraints</p>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>
                Pacing
                <HelpTooltip text="Even: plays spread across the whole period at a derived daily rate that self-corrects after missed days. ASAP: no daily quota — plays air as fast as caps and airing windows allow (burst campaigns)." />
              </label>
              <select {...register('pacing_mode')} disabled={isLoading} className={INPUT}>
                <option value="even">Even (default)</option>
                <option value="asap">ASAP (burst)</option>
              </select>
            </div>
            <div>
              <label className={LABEL}>
                Intra-break Separation
                <HelpTooltip text="Minimum number of other spots that must air between two plays from the same advertiser within a single commercial break." />
              </label>
              <input type="number" min={0} {...register('advertiser_separation_spots', { valueAsNumber: true })} disabled={isLoading} className={INPUT} />
            </div>
          </div>


          <div className="grid grid-cols-2 gap-3 items-end">
            <div className="flex items-center gap-2 pb-2">
              <input type="checkbox" {...register('first_in_slot')} disabled={isLoading} className="rounded border-zinc-700 text-brand-600 h-4 w-4 flex-shrink-0" />
              <label className="text-sm font-medium text-zinc-300 flex items-center gap-0">
                First in slot
                <HelpTooltip text="This campaign's spot should open the commercial break rather than appear mid-break." />
              </label>
            </div>
            <div>
              <label className={LABEL + (!firstInSlot ? ' opacity-40' : '')}>
                First-in-slot rule
                <HelpTooltip text="Every play: all airings open the break. At least once daily: the scheduler guarantees at least one opening position per day." />
              </label>
              <select
                {...register('first_in_slot_mode', { setValueAs: v => v === '' ? null : v })}
                disabled={isLoading || !firstInSlot}
                className={INPUT + (!firstInSlot ? ' opacity-40' : '')}
              >
                <option value="always">Every play</option>
                <option value="at_least_one">At least once daily</option>
              </select>
            </div>
          </div>

          <div>
            <label className={LABEL}>
              Competing Exclusions
              <HelpTooltip text="Campaigns that cannot air in the same commercial break as this one. Use for direct competitors or exclusivity agreements." />
            </label>
            <CampaignExclusionPicker
              allCampaigns={allCampaigns}
              excludeId={null}
              value={exclusionsField.value ?? []}
              onChange={exclusionsField.onChange}
              disabled={isLoading}
            />
          </div>
        </div>

        <div>
          <label className={LABEL}>Notes</label>
          <textarea {...register('notes')} disabled={isLoading} rows={2} className={INPUT} />
        </div>

        <BudgetImpactRow
          startsOn={watchedStartsOn}
          endsOn={watchedEndsOn}
          totalPlays={watchedPlays}
          durationBracket={watchedDuration}
          firstInSlot={firstInSlot}
        />

        <CampaignValidationPanel raw={allFormValues} />
      </div>
      <div className="px-6 py-4 border-t border-zinc-700 flex justify-end gap-2 bg-zinc-800/50 rounded-b-xl">
        <button type="button" onClick={onCancel} disabled={isLoading} className="px-4 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white text-sm rounded-lg transition-colors disabled:opacity-50">
          Cancel
        </button>
        <button type="submit" disabled={isLoading} className="px-4 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white text-sm rounded-lg transition-colors disabled:opacity-50">
          {isLoading ? 'Creating…' : 'Create Campaign'}
        </button>
      </div>
    </form>
  );
}

function CreateContactForm({
  customerId,
  onSubmit,
  onCancel,
  isLoading,
}: {
  customerId: number;
  onSubmit: (data: ContactCreate) => void;
  onCancel: () => void;
  isLoading: boolean;
}) {
  const { register, handleSubmit, formState } = useForm<ContactCreate>({
    resolver: zodResolver(ContactCreateSchema),
    defaultValues: { customer_id: customerId },
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <div className="px-6 py-5 space-y-4">
        <div>
          <label className={LABEL}>Name *</label>
          <input type="text" {...register('name')} disabled={isLoading} className={INPUT} />
          {formState.errors.name && (
            <p className="text-red-400 text-xs mt-1">{formState.errors.name.message}</p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>Email</label>
            <input type="email" {...register('email')} disabled={isLoading} className={INPUT} />
            {formState.errors.email && (
              <p className="text-red-400 text-xs mt-1">{formState.errors.email.message}</p>
            )}
          </div>
          <div>
            <label className={LABEL}>Phone</label>
            <input type="text" {...register('phone')} disabled={isLoading} className={INPUT} />
          </div>
        </div>
        <div>
          <label className={LABEL}>Role</label>
          <input
            type="text"
            {...register('role')}
            disabled={isLoading}
            className={INPUT}
            placeholder="e.g. Account Manager"
          />
        </div>
        <div>
          <label className={LABEL}>Notes</label>
          <textarea {...register('notes')} disabled={isLoading} rows={2} className={INPUT} />
        </div>
      </div>
      <div className="px-6 py-4 border-t border-zinc-700 flex justify-end gap-2 bg-zinc-800/50 rounded-b-xl">
        <button
          type="button"
          onClick={onCancel}
          disabled={isLoading}
          className="px-4 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isLoading}
          className="px-4 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
        >
          {isLoading ? 'Creating…' : 'Create Contact'}
        </button>
      </div>
    </form>
  );
}

function CampaignTableRow({
  campaign,
  showCustomer,
  isSelected,
  isFocused,
  onToggle,
  onRowClick,
  onEdit,
  onToggleActive,
}: {
  campaign: Campaign & { customer_name: string };
  showCustomer: boolean;
  isSelected: boolean;
  isFocused: boolean;
  onToggle: (e: React.MouseEvent) => void;
  onRowClick: () => void;
  onEdit: () => void;
  onToggleActive: (active: boolean) => void;
}) {
  return (
    <tr
      onClick={onRowClick}
      onDoubleClick={onEdit}
      title="Double-click to edit"
      className={`cursor-pointer transition-colors ${
        isSelected || isFocused
          ? 'bg-brand-600/20'
          : 'hover:bg-slate-900/50'
      }`}
    >
      <td className="px-4 py-3 border-r border-zinc-800/60" onClick={onToggle}>
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => {}}
          className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-brand-600 focus:ring-brand-500 focus:ring-offset-0 cursor-pointer"
        />
      </td>
      {showCustomer && (
        <td className="px-6 py-3 text-zinc-400">{campaign.customer_name}</td>
      )}
      <td className="px-6 py-3 font-medium text-white">
        {campaign.name}
        <CampaignProblemBadge campaignId={campaign.id} />
      </td>
      <td className="px-6 py-3 text-zinc-300">{campaign.total_plays}</td>
      <td className="px-6 py-3 text-zinc-300">
        {campaign.starts_on} → {campaign.ends_on}
      </td>
      <td className="px-6 py-3 border-r border-zinc-800/60">
        {campaign.active && (() => {
          const today = new Date().toISOString().slice(0, 10);
          if (campaign.starts_on > today) return null;
          if (campaign.starts_on === today) return <span className="text-xs text-zinc-600">Not enough data</span>;
          return <SpotPacingCell campaignId={campaign.id} />;
        })()}
      </td>
      <td className="px-6 py-3" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={campaign.active}
          onChange={(e) => onToggleActive(e.target.checked)}
          className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-brand-600 focus:ring-brand-500 focus:ring-offset-0 cursor-pointer"
        />
      </td>
    </tr>
  );
}

function EditModal({
  target,
  customers,
  campaigns,
  contacts,
  allContacts,
  users,
  onClose,
  onUpdateCustomer,
  onDeleteCustomer,
  onCreateContact,
  onAssociateContact,
  onDissociateContact,
  onSetPrimary,
  onUpdateCampaign,
  onDeleteCampaign,
  onUpdateContact,
  onDeleteContact,
  isUpdating,
  isDeleting,
}: {
  target: { type: 'customer' | 'campaign' | 'contact'; id: number };
  customers: Customer[];
  campaigns: (Campaign & { customer_name: string })[];
  contacts: (Contact & { is_primary: boolean })[];
  allContacts: Contact[];
  users: User[];
  onClose: () => void;
  onUpdateCustomer: (id: number, patch: CustomerPatch) => void;
  onDeleteCustomer: (id: number) => void;
  onCreateContact: (data: ContactCreate) => void;
  onAssociateContact: (customerId: number, contactId: number, isPrimary?: boolean) => void;
  onDissociateContact: (customerId: number, contactId: number) => void;
  onSetPrimary: (customerId: number, contactId: number, isPrimary: boolean) => void;
  onUpdateCampaign: (id: number, patch: CampaignPatch) => void;
  onDeleteCampaign: (id: number) => void;
  onUpdateContact: (id: number, patch: ContactPatch) => void;
  onDeleteContact: (id: number) => void;
  isUpdating: boolean;
  isDeleting: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const getTitle = () => {
    if (target.type === 'customer') {
      const c = customers.find((c) => c.id === target.id);
      return c ? c.name : 'Customer';
    } else if (target.type === 'campaign') {
      const c = campaigns.find((c) => c.id === target.id);
      return c ? c.name : 'Campaign';
    } else {
      const c = contacts.find((c) => c.id === target.id);
      if (c) return c.name;
      const allC = allContacts.find((c) => c.id === target.id);
      return allC ? allC.name : 'Contact';
    }
  };

  const typeLabel =
    target.type === 'customer' ? 'Customer' : target.type === 'campaign' ? 'Campaign' : 'Contact';

  const handleDelete = () => {
    if (target.type === 'customer') onDeleteCustomer(target.id);
    else if (target.type === 'campaign') onDeleteCampaign(target.id);
    else onDeleteContact(target.id);
  };

  const editContact =
    target.type === 'contact'
      ? contacts.find((c) => c.id === target.id) ?? allContacts.find((c) => c.id === target.id)
      : undefined;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-700 flex items-center gap-3">
          <span className="text-xs font-medium text-zinc-400 bg-zinc-800 px-2 py-0.5 rounded">
            {typeLabel}
          </span>
          <h2 className="text-lg font-semibold text-white flex-1 truncate">{getTitle()}</h2>
          <button
            onClick={() => setConfirmDelete(true)}
            title="Delete"
            className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-700 rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 px-6 py-5 overflow-auto">
          {target.type === 'customer' && (
            <CustomerEditForm
              customer={customers.find((c) => c.id === target.id)!}
              contacts={contacts}
              allContacts={allContacts}
              users={users}
              onSubmit={(patch) => onUpdateCustomer(target.id, patch)}
              onCreateContact={onCreateContact}
              onAssociateContact={onAssociateContact}
              onDissociateContact={onDissociateContact}
              onSetPrimary={(contactId, isPrimary) =>
                onSetPrimary(target.id, contactId, isPrimary)
              }
              onDeleteContact={onDeleteContact}
              isLoading={isUpdating}
            />
          )}
          {target.type === 'campaign' && (
            <CampaignEditForm
              campaign={campaigns.find((c) => c.id === target.id)!}
              customers={customers}
              allCampaigns={campaigns}
              onSubmit={(patch) => onUpdateCampaign(target.id, patch)}
              isLoading={isUpdating}
            />
          )}
          {target.type === 'contact' && editContact && (
            <ContactEditForm
              contact={editContact}
              onSubmit={(patch) => onUpdateContact(target.id, patch)}
              isLoading={isUpdating}
            />
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-zinc-700 flex items-center justify-between bg-zinc-800/50 rounded-b-xl">
          {!confirmDelete ? (
            <div className="flex gap-2 ml-auto">
              <button
                onClick={onClose}
                disabled={isUpdating}
                className="px-4 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                form="edit-form"
                disabled={isUpdating}
                className="px-4 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
              >
                {isUpdating ? 'Saving…' : 'Save'}
              </button>
            </div>
          ) : (
            <>
              <p className="text-sm text-zinc-300">
                Delete this {typeLabel.toLowerCase()}?{' '}
                <span className="text-zinc-300">This cannot be undone.</span>
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmDelete(false)}
                  disabled={isDeleting}
                  className="px-4 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="px-4 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
                >
                  {isDeleting ? 'Deleting…' : 'Yes, delete'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider whitespace-nowrap">
        {label}
      </span>
      <div className="flex-1 h-px bg-zinc-700" />
    </div>
  );
}

function PlaceholderSection({ label, description }: { label: string; description: string }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-700 px-4 py-3">
      <p className="text-xs font-medium text-zinc-300">{label}</p>
      <p className="text-xs text-zinc-400 mt-0.5">{description}</p>
    </div>
  );
}

function CustomerEditForm({
  customer,
  contacts,
  allContacts,
  users,
  onSubmit,
  onCreateContact,
  onAssociateContact,
  onDissociateContact,
  onSetPrimary,
  onDeleteContact,
  isLoading,
}: {
  customer: Customer;
  contacts: (Contact & { is_primary: boolean })[];
  allContacts: Contact[];
  users: User[];
  onSubmit: (patch: CustomerPatch) => void;
  onCreateContact: (data: ContactCreate) => void;
  onAssociateContact: (customerId: number, contactId: number, isPrimary?: boolean) => void;
  onDissociateContact: (customerId: number, contactId: number) => void;
  onSetPrimary: (contactId: number, isPrimary: boolean) => void;
  onDeleteContact: (id: number) => void;
  isLoading: boolean;
}) {
  const [addMode, setAddMode] = useState<'none' | 'new' | 'existing'>('none');
  const [confirmDeleteContact, setConfirmDeleteContact] = useState<number | null>(null);
  const associatedIds = new Set(contacts.map((c) => c.id));
  const unassociatedContacts = allContacts.filter((c) => !associatedIds.has(c.id));

  const { register, handleSubmit, formState } = useForm<CustomerPatch>({
    resolver: zodResolver(CustomerPatchSchema),
    defaultValues: {
      name: customer.name,
      email: customer.email || undefined,
      phone: customer.phone || undefined,
      notes: customer.notes || undefined,
      account_manager_id: customer.account_manager_id ?? undefined,
    },
  });

  const {
    register: regContact,
    handleSubmit: handleContactSubmit,
    reset: resetContact,
    formState: contactForm,
  } = useForm<ContactCreate>({
    resolver: zodResolver(ContactCreateSchema),
    defaultValues: { customer_id: customer.id },
  });

  const submitNewContact = (data: ContactCreate) => {
    onCreateContact({ ...data, customer_id: customer.id });
    resetContact({ customer_id: customer.id });
    setAddMode('none');
  };

  return (
    <form id="edit-form" onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      <div className="space-y-4">
        <div>
          <label className={LABEL}>Customer Name *</label>
          <input type="text" {...register('name')} disabled={isLoading} className={INPUT} />
          {formState.errors.name && (
            <p className="text-red-400 text-xs mt-1">{formState.errors.name.message}</p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={LABEL}>Email</label>
            <input type="email" {...register('email')} disabled={isLoading} className={INPUT} />
            {formState.errors.email && (
              <p className="text-red-400 text-xs mt-1">{formState.errors.email.message}</p>
            )}
          </div>
          <div>
            <label className={LABEL}>Phone</label>
            <input type="text" {...register('phone')} disabled={isLoading} className={INPUT} />
          </div>
        </div>
        <div>
          <label className={LABEL}>Account Manager</label>
          <select
            {...register('account_manager_id', { setValueAs: (v) => (v === '' ? null : Number(v)) })}
            disabled={isLoading}
            className={INPUT}
          >
            <option value="">— None —</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.first_name} {u.last_name}
                {u.account_name ? ` (${u.account_name})` : ''}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={LABEL}>Created</label>
          <div className="px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-300">
            {new Date(customer.created_at).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </div>
        </div>
      </div>

      <div>
        <label className={LABEL}>Notes</label>
        <textarea {...register('notes')} disabled={isLoading} rows={2} className={INPUT} />
      </div>

      {/* Contacts */}
      <div className="space-y-2">
        <SectionDivider label="Contacts" />

        {contacts.length === 0 && addMode === 'none' && (
          <p className="text-xs text-zinc-400 py-1">No contacts associated yet.</p>
        )}

        {contacts.map((contact) => (
          <div key={contact.id} className="px-3 py-2.5 bg-zinc-800 rounded-lg">
            {confirmDeleteContact === contact.id ? (
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-300">
                  Delete {contact.name}? This cannot be undone.
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteContact(null)}
                    className="px-2 py-0.5 text-xs bg-zinc-700 hover:bg-zinc-600 text-white rounded transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onDeleteContact(contact.id);
                      setConfirmDeleteContact(null);
                    }}
                    className="px-2 py-0.5 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
                  >
                    Yes, delete
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white truncate">{contact.name}</span>
                    {contact.role && (
                      <span className="text-xs text-zinc-300">{contact.role}</span>
                    )}
                  </div>
                  <div className="flex gap-3 mt-0.5">
                    {contact.email && (
                      <span className="text-xs text-zinc-300">{contact.email}</span>
                    )}
                    {contact.phone && (
                      <span className="text-xs text-zinc-300">{contact.phone}</span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onSetPrimary(contact.id, !contact.is_primary)}
                  title={contact.is_primary ? 'Remove primary' : 'Set as primary'}
                  className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                    contact.is_primary
                      ? 'bg-brand-900/50 text-brand-300 border-brand-700'
                      : 'text-zinc-500 border-zinc-700 hover:text-brand-300 hover:border-brand-700'
                  }`}
                >
                  Primary
                </button>
                <button
                  type="button"
                  onClick={() => onDissociateContact(customer.id, contact.id)}
                  title="Remove association"
                  className="p-1 text-zinc-500 hover:text-amber-400 hover:bg-amber-900/20 rounded transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDeleteContact(contact.id)}
                  title="Delete contact"
                  className="p-1 text-zinc-500 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>
        ))}

        {addMode === 'new' && (
          <div className="border border-zinc-700 rounded-lg p-3 space-y-2 bg-zinc-800/50">
            <p className="text-xs font-medium text-zinc-300">New contact</p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <input
                  {...regContact('name')}
                  placeholder="Name *"
                  className="w-full px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-brand-500"
                />
                {contactForm.errors.name && (
                  <p className="text-red-400 text-xs mt-0.5">{contactForm.errors.name.message}</p>
                )}
              </div>
              <input
                {...regContact('role')}
                placeholder="Role"
                className="w-full px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-brand-500"
              />
              <input
                {...regContact('email')}
                type="email"
                placeholder="Email"
                className="w-full px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-brand-500"
              />
              <input
                {...regContact('phone')}
                placeholder="Phone"
                className="w-full px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-brand-500"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => {
                  setAddMode('none');
                  resetContact({ customer_id: customer.id });
                }}
                className="px-3 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-white rounded transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleContactSubmit(submitNewContact)}
                className="px-3 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-white rounded transition-colors"
              >
                Add
              </button>
            </div>
          </div>
        )}

        {addMode === 'existing' && (
          <div className="border border-zinc-700 rounded-lg p-3 space-y-2 bg-zinc-800/50">
            <p className="text-xs font-medium text-zinc-300">Associate existing contact</p>
            {unassociatedContacts.length === 0 ? (
              <p className="text-xs text-zinc-400">All contacts are already associated.</p>
            ) : (
              <div className="space-y-1 max-h-40 overflow-auto">
                {unassociatedContacts.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      onAssociateContact(customer.id, c.id);
                      setAddMode('none');
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition-colors"
                  >
                    <span className="text-sm text-white">{c.name}</span>
                    {c.role && <span className="text-xs text-zinc-400 ml-2">{c.role}</span>}
                    {c.email && <span className="text-xs text-zinc-500 ml-2">{c.email}</span>}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => setAddMode('none')}
              className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        )}

        {addMode === 'none' && (
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setAddMode('new')}
              className="flex items-center gap-1.5 text-xs text-zinc-300 hover:text-white transition-colors py-1"
            >
              <UserPlus className="w-3.5 h-3.5" />
              New contact
            </button>
            {unassociatedContacts.length > 0 && (
              <button
                type="button"
                onClick={() => setAddMode('existing')}
                className="flex items-center gap-1.5 text-xs text-zinc-300 hover:text-white transition-colors py-1"
              >
                <Plus className="w-3.5 h-3.5" />
                Associate existing
              </button>
            )}
          </div>
        )}
      </div>


      <div className="space-y-2">
        <SectionDivider label="Attachments" />
        <PlaceholderSection
          label="Documents & Files"
          description="Attach contracts, legal documents, and other files here. Coming soon."
        />
      </div>

      <div className="space-y-2">
        <SectionDivider label="History" />
        <PlaceholderSection
          label="Campaign History"
          description="Performance history and past campaigns will appear here. Coming soon."
        />
      </div>
    </form>
  );
}

function CampaignEditForm({
  campaign,
  customers,
  allCampaigns,
  onSubmit,
  isLoading,
}: {
  campaign: Campaign & { customer_name: string };
  customers: Customer[];
  allCampaigns: (Campaign & { customer_name: string })[];
  onSubmit: (patch: CampaignPatch) => void;
  isLoading: boolean;
}) {
  const queryClient = useQueryClient();


  const { data: campaignMedia = [] } = useQuery({
    queryKey: ['campaign-media', campaign.id],
    queryFn: () => fetchCampaignMedia(campaign.id),
  });

  const { data: shows = [] }     = useQuery<Show[]>({ queryKey: ['shows'], queryFn: fetchShows });
  const { data: intervals = [] } = useQuery<BroadcastInterval[]>({ queryKey: ['intervals'], queryFn: fetchIntervals });

  const { control, register, handleSubmit, formState, setValue } = useForm<CampaignPatch>({
    resolver: zodResolver(CampaignPatchSchema),
    defaultValues: {
      name: campaign.name,
      starts_on: campaign.starts_on,
      ends_on: campaign.ends_on,
      total_plays: campaign.total_plays,
      duration_bracket: campaign.duration_bracket,
      max_plays_per_day: campaign.max_plays_per_day ?? undefined,
      min_gap_minutes: campaign.min_gap_minutes ?? undefined,
      pacing_mode: campaign.pacing_mode,
      catch_up_factor: campaign.catch_up_factor ?? undefined,
      allowed_interval_ids: campaign.allowed_interval_ids,
      sweeps_per_month: campaign.sweeps_per_month ?? undefined,
      max_sweeps_per_day: campaign.max_sweeps_per_day ?? undefined,
      interval_id: campaign.interval_id ?? undefined,
      interval_plays_per_day: campaign.interval_plays_per_day ?? undefined,
      show_id: campaign.show_id ?? undefined,
      plays_per_show: campaign.plays_per_show ?? undefined,
      first_in_slot: campaign.first_in_slot,
      first_in_slot_mode: campaign.first_in_slot_mode ?? 'always',
      advertiser_separation_spots: campaign.advertiser_separation_spots,
      competing_exclusions: campaign.competing_exclusions,
      notes: campaign.notes || undefined,
      active: campaign.active,
    },
  });

  const { field: exclusionsField } = useController({ name: 'competing_exclusions', control });
  const { field: allowedField } = useController({ name: 'allowed_interval_ids', control });
  const allFormValues      = useWatch({ control });
  const sweepsPerMonth     = useWatch({ control, name: 'sweeps_per_month' });
  const firstInSlot        = useWatch({ control, name: 'first_in_slot' });
  const selectedShowId     = useWatch({ control, name: 'show_id' });
  const selectedIntervalId = useWatch({ control, name: 'interval_id' });

  // Broadcast Interval and Associated Show are mutually exclusive
  useEffect(() => { if (selectedIntervalId) { setValue('show_id', null); setValue('plays_per_show', null); } }, [selectedIntervalId]);
  useEffect(() => { if (selectedShowId) { setValue('interval_id', null); setValue('interval_plays_per_day', null); } }, [selectedShowId]);
  const watchedStartsOn    = useWatch({ control, name: 'starts_on' }) ?? campaign.starts_on;
  const watchedEndsOn      = useWatch({ control, name: 'ends_on' }) ?? campaign.ends_on;
  const watchedPlays       = useWatch({ control, name: 'total_plays' }) ?? campaign.total_plays;
  const watchedDuration    = useWatch({ control, name: 'duration_bracket' }) ?? campaign.duration_bracket;
  const [mediaError, setMediaError] = useState<string | null>(null);

  // Clear media error whenever clips change (user added/removed a clip)
  useEffect(() => { setMediaError(null); }, [campaignMedia.length]);

  const doSubmit = async (data: CampaignPatch) => {
    const sweepsGoingAway = !data.sweeps_per_month && campaign.sweeps_per_month;

    if (sweepsGoingAway) {
      // sweep-only clips removed; both-tagged clips demoted to spot-only
      const sweepOnly = campaignMedia.filter((m) => m.play_as_sweep && !m.play_as_spot);
      const bothTagged = campaignMedia.filter((m) => m.play_as_sweep && m.play_as_spot);
      if (sweepOnly.length > 0 || bothTagged.length > 0) {
        await Promise.all([
          ...sweepOnly.map((c) => removeCampaignMedia(c.id)),
          ...bothTagged.map((c) => updateCampaignMedia(c.id, { play_as_sweep: false })),
        ]);
        queryClient.invalidateQueries({ queryKey: ['campaign-media', campaign.id] });
      }
    }

    // Effective clip state after cleanup
    const effectiveClips = sweepsGoingAway
      ? campaignMedia.filter((m) => m.play_as_spot)
      : campaignMedia;
    const effectiveSweepClips = sweepsGoingAway
      ? []
      : campaignMedia.filter((m) => m.play_as_sweep);

    const isActive = data.active !== undefined ? data.active : campaign.active;
    if (isActive && effectiveClips.filter((m) => m.play_as_spot).length === 0) {
      setMediaError('Active campaigns must have at least one clip tagged as Spot.');
      return;
    }
    if (data.sweeps_per_month && effectiveSweepClips.length === 0) {
      setMediaError('Sweeps are configured but no clips are tagged as Sweep.');
      return;
    }

    setMediaError(null);
    onSubmit(data);
  };

  return (
    <form id="edit-form" onSubmit={handleSubmit(doSubmit)} className="space-y-5">
      <div>
        <label className={LABEL}>Customer</label>
        <div className="px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-300">
          {campaign.customer_name}
        </div>
      </div>

      <div>
        <label className={LABEL}>Campaign Name *</label>
        <input type="text" {...register('name')} disabled={isLoading} className={INPUT} />
        {formState.errors.name && <p className="text-red-400 text-xs mt-1">{formState.errors.name.message}</p>}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LABEL}>
            Start Date
            <HelpTooltip text="Start date is locked once a campaign is created. Only the end date can be extended." />
          </label>
          <input type="date" {...register('starts_on')} disabled className={INPUT} />
        </div>
        <div>
          <label className={LABEL}>
            End Date *
            <HelpTooltip text="The last date this campaign is eligible to air. No plays are scheduled after this date." />
          </label>
          <input type="date" {...register('ends_on')} min={new Date().toISOString().slice(0, 10)} disabled={isLoading} className={INPUT} />
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Spot Pacing</p>
        <div>
          <label className={LABEL}>
            Duration Bracket *
            <HelpTooltip text="The sold slot length for this campaign. Clips longer than this bracket cannot be attached." />
          </label>
          <select {...register('duration_bracket', { valueAsNumber: true })} disabled={isLoading} className={INPUT}>
            {[15,30,45,60,90].map((s) => (
              <option key={s} value={s} className="bg-zinc-900">{s}s</option>
            ))}
          </select>
          {formState.errors.duration_bracket && <p className="text-red-400 text-xs mt-1">{formState.errors.duration_bracket.message}</p>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>
              Total Plays *
              <HelpTooltip text="Total number of spot airings sold for the whole campaign period (start to end date). Daily pacing is derived automatically and self-corrects; the monthly invoice bills what actually aired." />
            </label>
            <input type="number" {...register('total_plays', { valueAsNumber: true })} disabled={isLoading} className={INPUT} />
            {formState.errors.total_plays && <p className="text-red-400 text-xs mt-1">{formState.errors.total_plays.message}</p>}
          </div>
          <div>
            <label className={LABEL}>
              Max Plays / Day
              <HelpTooltip text="Hard cap on how many times spots can air in a single day. Leave blank for no daily limit." />
            </label>
            <input
              type="number"
              min={1}
              placeholder="No limit"
              {...register('max_plays_per_day', { setValueAs: v => (v === '' || v == null) ? null : Number(v) })}
              disabled={isLoading}
              className={INPUT}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>
              Min Gap Between Plays
              <HelpTooltip text="Minimum minutes between two plays of this campaign — keeps spots from clustering ('not twice in the same hour'). Blank = no gap rule." />
            </label>
            <input type="number" min={1} placeholder="No gap rule" {...register('min_gap_minutes', { setValueAs: v => (v === '' || v == null) ? null : Number(v) })} disabled={isLoading} className={INPUT} />
          </div>
          <div>
            <label className={LABEL}>
              Catch-up Limit (× pace)
              <HelpTooltip text="After missed days, the daily rate may rise up to this multiple of the campaign's original even pace. Blank = station default. Debt that can't fit under the limit surfaces as a shortfall alert instead of being crammed." />
            </label>
            <input type="number" min={1} step={0.5} placeholder="Station default" {...register('catch_up_factor', { setValueAs: v => (v === '' || v == null) ? null : Number(v) })} disabled={isLoading} className={INPUT} />
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Sweep Pacing</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>
              Sweeps / Month
              <HelpTooltip text="Target number of sweep airings per calendar month. Leave blank to disable sweeps for this campaign." />
            </label>
            <input
              type="number"
              min={0}
              placeholder="No sweeps"
              {...register('sweeps_per_month', { setValueAs: v => (v === '' || v == null) ? null : Number(v) })}
              disabled={isLoading}
              className={INPUT}
            />
          </div>
          <div>
            <label className={LABEL}>
              Max Sweeps / Day
              <HelpTooltip text="Hard cap on sweep plays per day. Only relevant when sweeps are configured." />
            </label>
            <input
              type="number"
              min={1}
              placeholder="No limit"
              {...register('max_sweeps_per_day', { setValueAs: v => (v === '' || v == null) ? null : Number(v) })}
              disabled={isLoading || !sweepsPerMonth}
              className={INPUT + (!sweepsPerMonth ? ' opacity-40' : '')}
            />
          </div>
        </div>
      </div>

      <CampaignDeliveryPanel campaignId={campaign.id} />

      <div className="space-y-2">
        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Airing Windows</p>
        <AllowedIntervalsPicker
          intervals={intervals}
          value={allowedField.value ?? null}
          onChange={allowedField.onChange}
          disabled={isLoading}
        />
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Guarantees</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL + (selectedShowId ? ' opacity-40' : '')}>
              Guaranteed Interval
              <HelpTooltip text="Pay-extra guarantee: at least N plays every day inside this named window. A minimum, not a fence — other plays still land anywhere in the allowed airing windows. Mutually exclusive with a show guarantee." />
            </label>
            <select
              {...register('interval_id', { setValueAs: v => v === '' ? null : Number(v) })}
              disabled={isLoading || !!selectedShowId}
              className={INPUT + (selectedShowId ? ' opacity-40' : '')}
            >
              <option value="">No interval</option>
              {intervals.map((iv) => (
                <option key={iv.id} value={iv.id}>{iv.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL + (!selectedIntervalId || selectedShowId ? ' opacity-40' : '')}>
              Guaranteed Plays / Day
              <HelpTooltip text="How many plays are guaranteed inside the selected interval each day. Counts within Total Plays, never on top of it." />
            </label>
            <input
              type="number"
              min={1}
              placeholder="—"
              {...register('interval_plays_per_day', { setValueAs: v => (v === '' || v == null) ? null : Number(v) })}
              disabled={isLoading || !selectedIntervalId || !!selectedShowId}
              className={INPUT + (!selectedIntervalId || selectedShowId ? ' opacity-40' : '')}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL + (selectedIntervalId ? ' opacity-40' : '')}>
              Associated Show
              <HelpTooltip text="Guarantee: at least N plays in every airing of this show. A minimum, not a fence. Mutually exclusive with an interval guarantee." />
            </label>
            <select
              {...register('show_id', { setValueAs: v => v === '' ? null : Number(v) })}
              disabled={isLoading || !!selectedIntervalId}
              className={INPUT + (selectedIntervalId ? ' opacity-40' : '')}
            >
              <option value="">Any show</option>
              {shows.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL + (!selectedShowId || selectedIntervalId ? ' opacity-40' : '')}>
              Guaranteed Plays / Airing
              <HelpTooltip text="How many plays are guaranteed in each airing of the selected show. Counts within Total Plays." />
            </label>
            <input
              type="number"
              min={1}
              placeholder="—"
              {...register('plays_per_show', { setValueAs: v => (v === '' || v == null) ? null : Number(v) })}
              disabled={isLoading || !selectedShowId || !!selectedIntervalId}
              className={INPUT + (!selectedShowId || selectedIntervalId ? ' opacity-40' : '')}
            />
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Placement Constraints</p>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>
              Pacing
              <HelpTooltip text="Even: plays spread across the whole period at a derived daily rate that self-corrects after missed days. ASAP: no daily quota — plays air as fast as caps and airing windows allow (burst campaigns)." />
            </label>
            <select {...register('pacing_mode')} disabled={isLoading} className={INPUT}>
              <option value="even">Even (default)</option>
              <option value="asap">ASAP (burst)</option>
            </select>
          </div>
          <div>
            <label className={LABEL}>
              Intra-break Separation
              <HelpTooltip text="Minimum number of other spots that must air between two plays from the same advertiser within a single commercial break." />
            </label>
            <input type="number" min={0} {...register('advertiser_separation_spots', { valueAsNumber: true })} disabled={isLoading} className={INPUT} />
          </div>
        </div>


        <div className="grid grid-cols-2 gap-3 items-end">
          <div className="flex items-center gap-2 pb-2">
            <input type="checkbox" {...register('first_in_slot')} disabled={isLoading} className="rounded border-zinc-700 text-brand-600 h-4 w-4 flex-shrink-0" />
            <label className="text-sm font-medium text-zinc-300 flex items-center gap-0">
              First in slot
              <HelpTooltip text="This campaign's spot should open the commercial break rather than appear mid-break." />
            </label>
          </div>
          <div>
            <label className={LABEL + (!firstInSlot ? ' opacity-40' : '')}>
              First-in-slot rule
              <HelpTooltip text="Every play: all airings open the break. At least once daily: the scheduler guarantees at least one opening position per day." />
            </label>
            <select
              {...register('first_in_slot_mode', { setValueAs: v => v === '' ? null : v })}
              disabled={isLoading || !firstInSlot}
              className={INPUT + (!firstInSlot ? ' opacity-40' : '')}
            >
              <option value="always">Every play</option>
              <option value="at_least_one">At least once daily</option>
            </select>
          </div>
        </div>

        <div>
          <label className={LABEL}>
            Competing Exclusions
            <HelpTooltip text="Campaigns that cannot air in the same commercial break as this one. Use for direct competitors or exclusivity agreements." />
          </label>
          <CampaignExclusionPicker
            allCampaigns={allCampaigns}
            excludeId={campaign.id}
            value={exclusionsField.value ?? []}
            onChange={exclusionsField.onChange}
            disabled={isLoading}
          />
        </div>
      </div>

      <div className="space-y-3">
        <SectionDivider label="Media" />
        <CampaignMediaSection campaignId={campaign.id} sweepsPerMonth={sweepsPerMonth ?? null} durationBracket={campaign.duration_bracket} />
        {mediaError && (
          <p className="text-red-400 text-xs">{mediaError}</p>
        )}
      </div>

      <div className="space-y-3">
        <SectionDivider label="Billing" />
        <PlaceholderSection label="Campaign Total" description="Price calculation based on spots × rate card. Coming soon." />
      </div>

      <BudgetImpactRow
        startsOn={watchedStartsOn}
        endsOn={watchedEndsOn}
        totalPlays={watchedPlays}
        durationBracket={watchedDuration}
        firstInSlot={firstInSlot ?? false}
      />

      <CampaignValidationPanel raw={{ ...allFormValues, id: campaign.id }} />

      <div>
        <label className={LABEL}>Notes</label>
        <textarea {...register('notes')} disabled={isLoading} rows={2} className={INPUT} />
      </div>

      <div className="flex items-center gap-2">
        <input type="checkbox" {...register('active')} disabled={isLoading} className="rounded border-zinc-700 text-brand-600 h-4 w-4" />
        <label className="text-sm font-medium text-zinc-300 flex items-center gap-0">
          Active
          <HelpTooltip text="Inactive campaigns are excluded from scheduling. At least one media clip must be uploaded before activating." />
        </label>
      </div>
    </form>
  );
}

function ContactEditForm({
  contact,
  onSubmit,
  isLoading,
}: {
  contact: Contact;
  onSubmit: (patch: ContactPatch) => void;
  isLoading: boolean;
}) {
  const { data: associatedCustomers = [] } = useQuery({
    queryKey: ['contact-customers', contact.id],
    queryFn: () => fetchContactCustomers(contact.id),
  });

  const { register, handleSubmit, formState } = useForm<ContactPatch>({
    resolver: zodResolver(ContactPatchSchema),
    defaultValues: {
      name: contact.name,
      email: contact.email || undefined,
      phone: contact.phone || undefined,
      role: contact.role || undefined,
      notes: contact.notes || undefined,
    },
  });

  return (
    <form id="edit-form" onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div>
        <label className={LABEL}>Name *</label>
        <input type="text" {...register('name')} disabled={isLoading} className={INPUT} />
        {formState.errors.name && (
          <p className="text-red-400 text-xs mt-1">{formState.errors.name.message}</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LABEL}>Email</label>
          <input type="email" {...register('email')} disabled={isLoading} className={INPUT} />
          {formState.errors.email && (
            <p className="text-red-400 text-xs mt-1">{formState.errors.email.message}</p>
          )}
        </div>
        <div>
          <label className={LABEL}>Phone</label>
          <input type="text" {...register('phone')} disabled={isLoading} className={INPUT} />
        </div>
      </div>

      <div>
        <label className={LABEL}>Role</label>
        <input
          type="text"
          {...register('role')}
          disabled={isLoading}
          placeholder="e.g. Account Manager"
          className={INPUT}
        />
      </div>

      <div>
        <label className={LABEL}>Notes</label>
        <textarea {...register('notes')} disabled={isLoading} rows={2} className={INPUT} />
      </div>

      {associatedCustomers.length > 0 && (
        <div className="space-y-2">
          <SectionDivider label="Associated Customers" />
          <div className="space-y-1">
            {associatedCustomers.map((c) => (
              <div
                key={c.id}
                className="px-3 py-2 bg-zinc-800 rounded-lg text-sm text-zinc-300"
              >
                {c.name}
              </div>
            ))}
          </div>
          <p className="text-xs text-zinc-500">
            Manage associations from the customer edit form.
          </p>
        </div>
      )}
    </form>
  );
}
