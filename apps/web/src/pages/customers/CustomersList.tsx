import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, useController, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Loader,
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Pencil,
  X,
  UserPlus,
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
} from '@radio/shared';
import { HelpTooltip } from '../../components/HelpTooltip';
import { CampaignMediaSection } from './CampaignMediaSection';
import { MusicCampaignsPage } from './MusicCampaignsPage';
import { INPUT, LABEL } from '../../ui';
import {
  fetchCustomers,
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
  fetchCampaignPacing,
  fetchCampaignMedia,
  removeCampaignMedia,
  updateCampaignMedia,
  fetchUsers,
  fetchShows,
  fetchIntervals,
} from '../../api';

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

function handleShiftClick<T extends number>(
  id: T,
  orderedIds: T[],
  selected: Set<T>,
  setSelected: React.Dispatch<React.SetStateAction<Set<T>>>,
  lastClicked: T | null,
  setLastClicked: (id: T) => void,
  e: React.MouseEvent,
) {
  if (e.shiftKey && lastClicked !== null) {
    const a = orderedIds.indexOf(lastClicked);
    const b = orderedIds.indexOf(id);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    setSelected((prev) => {
      const next = new Set(prev);
      orderedIds.slice(lo, hi + 1).forEach((i) => next.add(i));
      return next;
    });
  } else {
    setSelected((prev) => (prev.size === 1 && prev.has(id) ? new Set<T>() : new Set<T>([id])));
    setLastClicked(id);
  }
}

export function CustomersList() {
  const queryClient = useQueryClient();

  const [focusedCustomerId, setFocusedCustomerId] = useState<number | null>(null);
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<Set<number>>(new Set());
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<Set<number>>(new Set());
  const [selectedContactIds, setSelectedContactIds] = useState<Set<number>>(new Set());
  const [lastClickedCustomerId, setLastClickedCustomerId] = useState<number | null>(null);
  const [lastClickedCampaignId, setLastClickedCampaignId] = useState<number | null>(null);
  const [lastClickedContactId, setLastClickedContactId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<'campaigns' | 'contacts' | 'music-campaigns'>('campaigns');
  const [editTarget, setEditTarget] = useState<{
    type: 'customer' | 'campaign' | 'contact';
    id: number;
  } | null>(null);
  const [isCreatingCustomer, setIsCreatingCustomer] = useState(false);
  const [isCreatingCampaign, setIsCreatingCampaign] = useState(false);
  const [isCreatingContact, setIsCreatingContact] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [customerSort, setCustomerSort] = useState<SortConfig>(null);
  const [campaignSort, setCampaignSort] = useState<SortConfig>(null);
  const [contactSort, setContactSort] = useState<SortConfig>(null);
  const [confirmDeleteCustomers, setConfirmDeleteCustomers] = useState(false);

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  };

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

  const handleCustomerClick = (id: number, orderedIds: number[], e: React.MouseEvent) => {
    if (e.shiftKey) {
      handleShiftClick(
        id,
        orderedIds,
        selectedCustomerIds,
        setSelectedCustomerIds,
        lastClickedCustomerId,
        setLastClickedCustomerId,
        e,
      );
    } else {
      const isOnlySelected = selectedCustomerIds.size === 1 && selectedCustomerIds.has(id);
      if (isOnlySelected) {
        setSelectedCustomerIds(new Set());
        setFocusedCustomerId(null);
        setLastClickedCustomerId(null);
      } else {
        setSelectedCustomerIds(new Set([id]));
        setFocusedCustomerId(id);
        setLastClickedCustomerId(id);
      }
    }
  };

  const clearCustomerFocus = () => {
    setFocusedCustomerId(null);
    setSelectedCustomerIds(new Set());
    setLastClickedCustomerId(null);
  };

  const canEditCustomer = selectedCustomerIds.size === 1;
  const canDeleteCustomer = selectedCustomerIds.size > 0;
  const editCustomerId = canEditCustomer ? [...selectedCustomerIds][0] : null;

  const canEditCampaign = selectedCampaignIds.size === 1;
  const canDeleteCampaign = selectedCampaignIds.size > 0;
  const editCampaignId = canEditCampaign ? [...selectedCampaignIds][0] : null;

  const canEditContact = selectedContactIds.size === 1;
  const canDeleteContact = selectedContactIds.size > 0;
  const editContactId = canEditContact ? [...selectedContactIds][0] : null;

  const selectedCustomersHaveCampaigns = [...selectedCustomerIds].some((cid) =>
    allCampaigns.some((c) => c.customer_id === cid),
  );

  const createCustomerMutation = useMutation({
    mutationFn: createCustomer,
    onSuccess: (newCustomer) => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      setIsCreatingCustomer(false);
      setFocusedCustomerId(newCustomer.id);
      setSelectedCustomerIds(new Set([newCustomer.id]));
      showToast('success', 'Customer created');
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  const updateCustomerMutation = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: CustomerPatch }) => updateCustomer(id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      setEditTarget(null);
      showToast('success', 'Customer updated');
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  const deleteCustomersMutation = useMutation({
    mutationFn: (ids: number[]) => deleteCustomers(ids),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-all-with-customers'] });
      setSelectedCustomerIds(new Set());
      setFocusedCustomerId(null);
      setLastClickedCustomerId(null);
      setConfirmDeleteCustomers(false);
      showToast('success', 'Customer(s) deleted');
    },
    onError: (err) => showToast('error', (err as Error).message),
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
      showToast('success', 'Customer deleted');
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  const updateCampaignMutation = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: CampaignPatch }) => updateCampaign(id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      setEditTarget(null);
      showToast('success', 'Campaign updated');
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  const deleteCampaignsMutation = useMutation({
    mutationFn: (ids: number[]) => deleteCampaigns(ids),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      setSelectedCampaignIds(new Set());
      setLastClickedCampaignId(null);
      showToast('success', 'Campaign(s) deleted');
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  const deleteCampaignMutation = useMutation({
    mutationFn: deleteCampaign,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      setEditTarget(null);
      showToast('success', 'Campaign deleted');
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  const createCampaignMutation = useMutation({
    mutationFn: createCampaign,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      setIsCreatingCampaign(false);
      showToast('success', 'Campaign created');
    },
    onError: (err) => showToast('error', (err as Error).message),
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
      showToast('success', 'Contact added');
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  const deleteContactsMutation = useMutation({
    mutationFn: (ids: number[]) => deleteContacts(ids),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-all'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-all-with-customers'] });
      setSelectedContactIds(new Set());
      setLastClickedContactId(null);
      showToast('success', 'Contact(s) deleted');
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  const associateContactMutation = useMutation({
    mutationFn: ({ customerId, contactId, isPrimary }: { customerId: number; contactId: number; isPrimary?: boolean }) =>
      associateContact(customerId, contactId, isPrimary),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-all-with-customers'] });
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  const dissociateContactMutation = useMutation({
    mutationFn: ({ customerId, contactId }: { customerId: number; contactId: number }) =>
      dissociateContact(customerId, contactId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-all-with-customers'] });
    },
    onError: (err) => showToast('error', (err as Error).message),
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
    onError: (err) => showToast('error', (err as Error).message),
  });

  const updateContactMutation = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: ContactPatch }) => updateContact(id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-all-with-customers'] });
      setEditTarget(null);
      showToast('success', 'Contact updated');
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  const deleteContactMutation = useMutation({
    mutationFn: deleteContact,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-all'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-all-with-customers'] });
      setEditTarget(null);
      showToast('success', 'Contact deleted');
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  const handleDeleteCustomers = () => {
    if (selectedCustomersHaveCampaigns) {
      setConfirmDeleteCustomers(true);
    } else {
      deleteCustomersMutation.mutate([...selectedCustomerIds]);
    }
  };

  const handleDeleteCampaigns = () => {
    deleteCampaignsMutation.mutate([...selectedCampaignIds]);
  };

  const handleDeleteContacts = () => {
    deleteContactsMutation.mutate([...selectedContactIds]);
  };

  const orderedCustomerIds = customers.map((c) => c.id);
  const orderedCampaignIds = displayedCampaigns.map((c) => c.id);
  const orderedContactIds = (displayedContacts as Array<{ id: number }>).map((c) => c.id);

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader className="w-8 h-8 animate-spin text-indigo-500" />
      </div>
    );

  const focusedCustomerName = focusedCustomerId
    ? customers.find((c) => c.id === focusedCustomerId)?.name
    : null;

  return (
    <div className="space-y-2 h-full flex flex-col">
      {toast && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-lg ${
            toast.type === 'success'
              ? 'bg-green-900/20 border border-green-800 text-green-300'
              : 'bg-red-900/20 border border-red-800 text-red-300'
          }`}
        >
          <p>{toast.message}</p>
        </div>
      )}

      {/* Bulk customer delete confirm dialog */}
      {confirmDeleteCustomers && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-md p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm text-zinc-100 font-medium">
              Delete {selectedCustomerIds.size} customer{selectedCustomerIds.size > 1 ? 's' : ''}?
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
                onClick={() => deleteCustomersMutation.mutate([...selectedCustomerIds])}
                disabled={deleteCustomersMutation.isPending}
                className="px-4 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
              >
                {deleteCustomersMutation.isPending ? 'Deleting…' : 'Yes, delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TOP: Customers Table */}
      <div className="flex-1 min-h-0 flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-zinc-800 flex items-center gap-2 bg-zinc-800/50">
          <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider flex-1">
            Customers ({customers.length})
          </h2>
          <button
            onClick={() => setIsCreatingCustomer(true)}
            className="flex items-center gap-2 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            New
          </button>
          <button
            onClick={() => {
              if (editCustomerId) setEditTarget({ type: 'customer', id: editCustomerId });
            }}
            disabled={!canEditCustomer}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg transition-colors ${
              canEditCustomer
                ? 'text-zinc-300 hover:text-white bg-zinc-700 hover:bg-zinc-600'
                : 'text-zinc-600 bg-zinc-800 cursor-not-allowed'
            }`}
          >
            <Pencil className="w-3 h-3" />
            Edit
          </button>
          <button
            onClick={handleDeleteCustomers}
            disabled={!canDeleteCustomer || deleteCustomersMutation.isPending}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg transition-colors ${
              canDeleteCustomer
                ? 'text-red-400 hover:bg-red-900/20 bg-zinc-700'
                : 'text-zinc-600 bg-zinc-800 cursor-not-allowed'
            }`}
          >
            <Trash2 className="w-3 h-3" />
            {selectedCustomerIds.size > 1 ? `Delete (${selectedCustomerIds.size})` : 'Delete'}
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-800 sticky top-0">
              <tr>
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
                <th className="px-6 py-2 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {customers.map((customer) => (
                <tr
                  key={customer.id}
                  onClick={(e) => handleCustomerClick(customer.id, orderedCustomerIds, e)}
                  onDoubleClick={() => setEditTarget({ type: 'customer', id: customer.id })}
                  title="Double-click to edit"
                  className={`cursor-pointer transition-colors ${
                    selectedCustomerIds.has(customer.id)
                      ? 'bg-indigo-600/20 border-l-2 border-l-indigo-500'
                      : 'hover:bg-zinc-800/50'
                  }`}
                >
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
      <div className="flex-1 min-h-0 flex flex-col bg-slate-950 border border-indigo-900/50 rounded-lg overflow-hidden">
        {/* Tab bar + filter chip */}
        <div className="flex items-center border-b border-indigo-900/30 bg-slate-900/50">
          <button
            onClick={() => setActiveTab('campaigns')}
            className={`px-6 py-3 text-sm font-medium transition-colors ${
              activeTab === 'campaigns'
                ? 'text-white border-b-2 border-indigo-500 bg-slate-950'
                : 'text-zinc-300 hover:text-white'
            }`}
          >
            Campaigns ({displayedCampaigns.length})
          </button>
          <button
            onClick={() => setActiveTab('contacts')}
            className={`px-6 py-3 text-sm font-medium transition-colors ${
              activeTab === 'contacts'
                ? 'text-white border-b-2 border-indigo-500 bg-slate-950'
                : 'text-zinc-300 hover:text-white'
            }`}
          >
            Contacts ({displayedContacts.length})
          </button>
          <button
            onClick={() => setActiveTab('music-campaigns')}
            className={`px-6 py-3 text-sm font-medium transition-colors ${
              activeTab === 'music-campaigns'
                ? 'text-white border-b-2 border-indigo-500 bg-slate-950'
                : 'text-zinc-300 hover:text-white'
            }`}
          >
            Music Campaigns
          </button>
          <div className="flex-1" />
          {focusedCustomerId && focusedCustomerName && (
            <div className="mr-3 flex items-center gap-1.5 px-2.5 py-1 bg-indigo-900/30 border border-indigo-700/50 rounded-lg text-xs text-indigo-300">
              <span>
                {focusedCustomerName}
                {selectedCustomerIds.size > 1 && (
                  <span className="ml-1 text-indigo-400">+{selectedCustomerIds.size - 1} more</span>
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
              <div className="px-6 py-3 border-b border-zinc-800 flex items-center gap-2 bg-zinc-800/30">
                <div className="flex-1" />
                <button
                  onClick={() => {
                    if (focusedCustomerId) setIsCreatingCampaign(true);
                  }}
                  disabled={!focusedCustomerId}
                  className={`flex items-center gap-2 px-3 py-1 text-xs rounded transition-colors ${
                    focusedCustomerId
                      ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                      : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
                  }`}
                >
                  <Plus className="w-3 h-3" />
                  New Campaign
                </button>
                <button
                  onClick={() => {
                    if (editCampaignId) setEditTarget({ type: 'campaign', id: editCampaignId });
                  }}
                  disabled={!canEditCampaign}
                  className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg transition-colors ${
                    canEditCampaign
                      ? 'text-zinc-300 hover:text-white bg-zinc-700 hover:bg-zinc-600'
                      : 'text-zinc-600 bg-zinc-800 cursor-not-allowed'
                  }`}
                >
                  <Pencil className="w-3 h-3" />
                  Edit
                </button>
                <button
                  onClick={handleDeleteCampaigns}
                  disabled={!canDeleteCampaign || deleteCampaignsMutation.isPending}
                  className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg transition-colors ${
                    canDeleteCampaign
                      ? 'text-red-400 hover:bg-red-900/20 bg-zinc-700'
                      : 'text-zinc-600 bg-zinc-800 cursor-not-allowed'
                  }`}
                >
                  <Trash2 className="w-3 h-3" />
                  {selectedCampaignIds.size > 1
                    ? `Delete (${selectedCampaignIds.size})`
                    : 'Delete'}
                </button>
              </div>
              <div className="flex-1 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="bg-zinc-800 sticky top-0">
                    <tr>
                      {!focusedCustomerId && (
                        <th className="px-6 py-2 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider border-r border-indigo-800">
                          Customer
                        </th>
                      )}
                      <SortableHeader
                        label="Name"
                        column="name"
                        isActive={campaignSort?.column === 'name'}
                        direction={campaignSort?.direction}
                        onSort={() => toggleSort('name', setCampaignSort, campaignSort)}
                        borderColor="border-indigo-800"
                      />
                      <SortableHeader
                        label="Plays/mo"
                        column="plays_per_month"
                        isActive={campaignSort?.column === 'plays_per_month'}
                        direction={campaignSort?.direction}
                        onSort={() =>
                          toggleSort('plays_per_month', setCampaignSort, campaignSort)
                        }
                        borderColor="border-indigo-800"
                      />
                      <SortableHeader
                        label="Period"
                        column="starts_on"
                        isActive={campaignSort?.column === 'starts_on'}
                        direction={campaignSort?.direction}
                        onSort={() => toggleSort('starts_on', setCampaignSort, campaignSort)}
                        borderColor="border-indigo-800"
                      />
                      <th className="px-6 py-2 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider">
                        Pacing
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
                        onClick={(e) =>
                          handleShiftClick(
                            campaign.id,
                            orderedCampaignIds,
                            selectedCampaignIds,
                            setSelectedCampaignIds,
                            lastClickedCampaignId,
                            setLastClickedCampaignId,
                            e,
                          )
                        }
                        onEdit={() => setEditTarget({ type: 'campaign', id: campaign.id })}
                      />
                    ))}
                  </tbody>
                </table>

                {displayedCampaigns.length === 0 && (
                  <div className="p-4 text-center text-zinc-300 text-xs">No campaigns</div>
                )}
              </div>
            </div>
          ) : activeTab === 'contacts' ? (
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="px-6 py-3 border-b border-zinc-800 flex items-center gap-2 bg-zinc-800/30">
                <div className="flex-1" />
                <button
                  onClick={() => {
                    if (focusedCustomerId) setIsCreatingContact(true);
                  }}
                  disabled={!focusedCustomerId}
                  className={`flex items-center gap-2 px-3 py-1 text-xs rounded transition-colors ${
                    focusedCustomerId
                      ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                      : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
                  }`}
                >
                  <Plus className="w-3 h-3" />
                  New Contact
                </button>
                <button
                  onClick={() => {
                    if (editContactId) setEditTarget({ type: 'contact', id: editContactId });
                  }}
                  disabled={!canEditContact}
                  className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg transition-colors ${
                    canEditContact
                      ? 'text-zinc-300 hover:text-white bg-zinc-700 hover:bg-zinc-600'
                      : 'text-zinc-600 bg-zinc-800 cursor-not-allowed'
                  }`}
                >
                  <Pencil className="w-3 h-3" />
                  Edit
                </button>
                <button
                  onClick={handleDeleteContacts}
                  disabled={!canDeleteContact || deleteContactsMutation.isPending}
                  className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg transition-colors ${
                    canDeleteContact
                      ? 'text-red-400 hover:bg-red-900/20 bg-zinc-700'
                      : 'text-zinc-600 bg-zinc-800 cursor-not-allowed'
                  }`}
                >
                  <Trash2 className="w-3 h-3" />
                  {selectedContactIds.size > 1
                    ? `Delete (${selectedContactIds.size})`
                    : 'Delete'}
                </button>
              </div>
              <div className="flex-1 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="bg-zinc-800 sticky top-0">
                    <tr>
                      {!focusedCustomerId && (
                        <th className="px-6 py-2 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider border-r border-indigo-800">
                          Customer(s)
                        </th>
                      )}
                      <SortableHeader
                        label="Name"
                        column="name"
                        isActive={contactSort?.column === 'name'}
                        direction={contactSort?.direction}
                        onSort={() => toggleSort('name', setContactSort, contactSort)}
                        borderColor="border-indigo-800"
                      />
                      <SortableHeader
                        label="Email"
                        column="email"
                        isActive={contactSort?.column === 'email'}
                        direction={contactSort?.direction}
                        onSort={() => toggleSort('email', setContactSort, contactSort)}
                        borderColor="border-indigo-800"
                      />
                      <SortableHeader
                        label="Phone"
                        column="phone"
                        isActive={contactSort?.column === 'phone'}
                        direction={contactSort?.direction}
                        onSort={() => toggleSort('phone', setContactSort, contactSort)}
                        borderColor="border-indigo-800"
                      />
                      <SortableHeader
                        label="Role"
                        column="role"
                        isActive={contactSort?.column === 'role'}
                        direction={contactSort?.direction}
                        onSort={() => toggleSort('role', setContactSort, contactSort)}
                        borderColor="border-indigo-800"
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
                          onClick={(e) =>
                            handleShiftClick(
                              contact.id,
                              orderedContactIds,
                              selectedContactIds,
                              setSelectedContactIds,
                              lastClickedContactId,
                              setLastClickedContactId,
                              e,
                            )
                          }
                          onDoubleClick={() =>
                            setEditTarget({ type: 'contact', id: contact.id })
                          }
                          title="Double-click to edit"
                          className={`cursor-pointer transition-colors ${
                            selectedContactIds.has(contact.id)
                              ? 'bg-indigo-600/20 border-l-2 border-l-indigo-500'
                              : 'hover:bg-slate-900/50'
                          }`}
                        >
                          {!focusedCustomerId && (
                            <td className="px-6 py-2 text-zinc-400">
                              {withCustomers.customer_names?.join(', ') || '—'}
                            </td>
                          )}
                          <td className="px-6 py-2 font-medium text-white">{contact.name}</td>
                          <td className="px-6 py-2 text-zinc-300">{contact.email || '—'}</td>
                          <td className="px-6 py-2 text-zinc-300">{contact.phone || '—'}</td>
                          <td className="px-6 py-2 text-zinc-300">
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
                  <div className="p-4 text-center text-zinc-300 text-xs">No contacts</div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-auto p-4">
              <MusicCampaignsPage />
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
  borderColor = 'border-zinc-600',
}: {
  label: string;
  column: string;
  isActive: boolean;
  direction?: 'asc' | 'desc';
  onSort: () => void;
  borderColor?: string;
}) {
  return (
    <th
      onClick={onSort}
      className={`px-6 py-2 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider cursor-pointer hover:text-white select-none transition-colors border-r ${borderColor}`}
    >
      <div className="flex items-center gap-1">
        {label}
        {isActive ? (
          direction === 'asc' ? (
            <ChevronUp className="w-3 h-3" />
          ) : (
            <ChevronDown className="w-3 h-3" />
          )
        ) : (
          <ChevronsUpDown className="w-3 h-3 opacity-30" />
        )}
      </div>
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
          className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
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

  const { control, register, handleSubmit, formState } = useForm<CampaignCreate>({
    resolver: zodResolver(CampaignCreateSchema),
    defaultValues: {
      customer_id: defaultCustomerId,
      plays_per_month: 30,
      advertiser_separation_spots: 1,
      competing_exclusions: [],
      priority: 'hard',
      first_in_slot: false,
      first_in_slot_mode: 'always',
      show_id: null,
      plays_per_show: null,
    },
  });

  const { field: exclusionsField } = useController({ name: 'competing_exclusions', control });
  const firstInSlot    = useWatch({ control, name: 'first_in_slot' });
  const selectedShowId = useWatch({ control, name: 'show_id' });
  const selectedIntervalId = useWatch({ control, name: 'interval_id' });

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
            <input type="date" {...register('starts_on')} disabled={isLoading} className={INPUT} />
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
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>
                Plays / Month *
                <HelpTooltip text="Target number of spot airings per calendar month. The scheduler distributes plays evenly across broadcast days to hit this number." />
              </label>
              <input type="number" min={1} {...register('plays_per_month', { valueAsNumber: true })} disabled={isLoading} className={INPUT} />
              {formState.errors.plays_per_month && <p className="text-red-400 text-xs mt-1">{formState.errors.plays_per_month.message}</p>}
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
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Interval</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>
                Broadcast Interval
                <HelpTooltip text="Guaranteed time bracket for this campaign. The scheduler will ensure plays fall within this named time window." />
              </label>
              <select
                {...register('interval_id', { setValueAs: v => v === '' ? null : Number(v) })}
                disabled={isLoading}
                className={INPUT}
              >
                <option value="">No interval</option>
                {intervals.map((iv) => (
                  <option key={iv.id} value={iv.id}>{iv.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL + (!selectedIntervalId ? ' opacity-40' : '')}>
                Plays / Week (interval)
                <HelpTooltip text="How many times this campaign must air within the selected interval per week." />
              </label>
              <input
                type="number"
                min={1}
                placeholder="—"
                {...register('interval_plays_per_week', { setValueAs: v => (v === '' || v == null) ? null : Number(v) })}
                disabled={isLoading || !selectedIntervalId}
                className={INPUT + (!selectedIntervalId ? ' opacity-40' : '')}
              />
            </div>
          </div>
        </div>

        <div className="pt-1 space-y-3">
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Placement</p>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>
                Priority
                <HelpTooltip text="Hard: the scheduler must hit the monthly play target, bumping best-effort campaigns when there isn't room. Best Effort: plays are distributed opportunistically." />
              </label>
              <select {...register('priority')} disabled={isLoading} className={INPUT}>
                <option value="best_effort">Best Effort</option>
                <option value="hard">Hard</option>
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

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>
                Associated Show
                <HelpTooltip text="When set, this campaign is targeted for airings during this show's time slots." />
              </label>
              <select
                {...register('show_id', { setValueAs: v => v === '' ? null : Number(v) })}
                disabled={isLoading}
                className={INPUT}
              >
                <option value="">Any show</option>
                {shows.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL + (!selectedShowId ? ' opacity-40' : '')}>
                Plays per Show
                <HelpTooltip text="Target number of spot airings per show occurrence. Works alongside the monthly target." />
              </label>
              <input
                type="number"
                min={1}
                placeholder="—"
                {...register('plays_per_show', { setValueAs: v => (v === '' || v == null) ? null : Number(v) })}
                disabled={isLoading || !selectedShowId}
                className={INPUT + (!selectedShowId ? ' opacity-40' : '')}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 items-end">
            <div className="flex items-center gap-2 pb-2">
              <input type="checkbox" {...register('first_in_slot')} disabled={isLoading} className="rounded border-zinc-700 text-indigo-600 h-4 w-4 flex-shrink-0" />
              <label className="text-sm font-medium text-zinc-300 flex items-center gap-0">
                First in slot
                <HelpTooltip text="This campaign's spot should open the commercial break rather than appear mid-break." />
              </label>
            </div>
            <div>
              <label className={LABEL + (!firstInSlot ? ' opacity-40' : '')}>
                First-in-slot rule
                <HelpTooltip text="Every play: all airings open the break. At least once daily: the scheduler guarantees at least one opening position per day. Once daily + shared: one opening per day guaranteed; when multiple campaigns compete for the first slot, they share it across days." />
              </label>
              <select
                {...register('first_in_slot_mode', { setValueAs: v => v === '' ? null : v })}
                disabled={isLoading || !firstInSlot}
                className={INPUT + (!firstInSlot ? ' opacity-40' : '')}
              >
                <option value="always">Every play</option>
                <option value="at_least_one">At least once daily</option>
                <option value="at_least_one_shared">Once daily + shared</option>
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
      </div>
      <div className="px-6 py-4 border-t border-zinc-700 flex justify-end gap-2 bg-zinc-800/50 rounded-b-xl">
        <button type="button" onClick={onCancel} disabled={isLoading} className="px-4 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white text-sm rounded-lg transition-colors disabled:opacity-50">
          Cancel
        </button>
        <button type="submit" disabled={isLoading} className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-lg transition-colors disabled:opacity-50">
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
          className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
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
  onClick,
  onEdit,
}: {
  campaign: Campaign & { customer_name: string };
  showCustomer: boolean;
  isSelected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onEdit: () => void;
}) {
  const { data: pacing } = useQuery({
    queryKey: ['campaign-pacing', campaign.id],
    queryFn: () => fetchCampaignPacing(campaign.id),
  });

  return (
    <tr
      onClick={onClick}
      onDoubleClick={onEdit}
      title="Double-click to edit"
      className={`cursor-pointer transition-colors ${
        isSelected
          ? 'bg-indigo-600/20 border-l-2 border-l-indigo-500'
          : 'hover:bg-slate-900/50'
      }`}
    >
      {showCustomer && (
        <td className="px-6 py-2 text-zinc-400">{campaign.customer_name}</td>
      )}
      <td className="px-6 py-2 font-medium text-white">{campaign.name}</td>
      <td className="px-6 py-2 text-zinc-300">{campaign.plays_per_month}</td>
      <td className="px-6 py-2 text-zinc-300 text-xs">
        {campaign.starts_on} → {campaign.ends_on}
      </td>
      <td className="px-6 py-2">
        {pacing && (
          <div className="flex items-center gap-2">
            <div className="text-xs font-medium text-white">{pacing.pct}%</div>
            <span className={`text-xs ${pacing.on_track ? 'text-green-400' : 'text-amber-400'}`}>
              {pacing.on_track ? '✓' : '⚠'}
            </span>
          </div>
        )}
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
                className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
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
                      ? 'bg-indigo-900/50 text-indigo-300 border-indigo-700'
                      : 'text-zinc-500 border-zinc-700 hover:text-indigo-300 hover:border-indigo-700'
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
                  className="w-full px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
                />
                {contactForm.errors.name && (
                  <p className="text-red-400 text-xs mt-0.5">{contactForm.errors.name.message}</p>
                )}
              </div>
              <input
                {...regContact('role')}
                placeholder="Role"
                className="w-full px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
              />
              <input
                {...regContact('email')}
                type="email"
                placeholder="Email"
                className="w-full px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
              />
              <input
                {...regContact('phone')}
                placeholder="Phone"
                className="w-full px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
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
                className="px-3 py-1 text-xs bg-indigo-600 hover:bg-indigo-700 text-white rounded transition-colors"
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

  const { data: pacing } = useQuery({
    queryKey: ['campaign-pacing', campaign.id],
    queryFn: () => fetchCampaignPacing(campaign.id),
  });

  const { data: campaignMedia = [] } = useQuery({
    queryKey: ['campaign-media', campaign.id],
    queryFn: () => fetchCampaignMedia(campaign.id),
  });

  const { data: shows = [] }     = useQuery<Show[]>({ queryKey: ['shows'], queryFn: fetchShows });
  const { data: intervals = [] } = useQuery<BroadcastInterval[]>({ queryKey: ['intervals'], queryFn: fetchIntervals });

  const { control, register, handleSubmit, formState } = useForm<CampaignPatch>({
    resolver: zodResolver(CampaignPatchSchema),
    defaultValues: {
      name: campaign.name,
      starts_on: campaign.starts_on,
      ends_on: campaign.ends_on,
      plays_per_month: campaign.plays_per_month,
      max_plays_per_day: campaign.max_plays_per_day ?? undefined,
      sweeps_per_month: campaign.sweeps_per_month ?? undefined,
      max_sweeps_per_day: campaign.max_sweeps_per_day ?? undefined,
      interval_id: campaign.interval_id ?? undefined,
      interval_plays_per_week: campaign.interval_plays_per_week ?? undefined,
      priority: campaign.priority,
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
  const sweepsPerMonth     = useWatch({ control, name: 'sweeps_per_month' });
  const firstInSlot        = useWatch({ control, name: 'first_in_slot' });
  const selectedShowId     = useWatch({ control, name: 'show_id' });
  const selectedIntervalId = useWatch({ control, name: 'interval_id' });
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
            Start Date *
            <HelpTooltip text="The first date this campaign is eligible to air." />
          </label>
          <input type="date" {...register('starts_on')} disabled={isLoading} className={INPUT} />
        </div>
        <div>
          <label className={LABEL}>
            End Date *
            <HelpTooltip text="The last date this campaign is eligible to air. No plays are scheduled after this date." />
          </label>
          <input type="date" {...register('ends_on')} disabled={isLoading} className={INPUT} />
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Spot Pacing</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>
              Plays / Month *
              <HelpTooltip text="Target number of spot airings per calendar month. The scheduler distributes plays evenly across broadcast days to hit this number." />
            </label>
            <input type="number" {...register('plays_per_month', { valueAsNumber: true })} disabled={isLoading} className={INPUT} />
            {formState.errors.plays_per_month && <p className="text-red-400 text-xs mt-1">{formState.errors.plays_per_month.message}</p>}
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

      {pacing && (
        <div className="space-y-1">
          <label className={LABEL}>Pacing this month</label>
          <div className="flex items-center gap-3">
            <div className="flex-1 bg-zinc-700 rounded-full h-2">
              <div className={`h-2 rounded-full ${pacing.on_track ? 'bg-green-500' : 'bg-amber-500'}`} style={{ width: `${Math.min(pacing.pct, 100)}%` }} />
            </div>
            <span className="text-xs text-zinc-300 whitespace-nowrap">{pacing.plays_this_month} / {pacing.target} ({pacing.pct}%)</span>
            <span className={`text-xs ${pacing.on_track ? 'text-green-400' : 'text-amber-400'}`}>{pacing.on_track ? 'On track' : 'Behind'}</span>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Interval</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>
              Broadcast Interval
              <HelpTooltip text="Guaranteed time bracket for this campaign. The scheduler will ensure plays fall within this named time window." />
            </label>
            <select
              {...register('interval_id', { setValueAs: v => v === '' ? null : Number(v) })}
              disabled={isLoading}
              className={INPUT}
            >
              <option value="">No interval</option>
              {intervals.map((iv) => (
                <option key={iv.id} value={iv.id}>{iv.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL + (!selectedIntervalId ? ' opacity-40' : '')}>
              Plays / Week (interval)
              <HelpTooltip text="How many times this campaign must air within the selected interval per week." />
            </label>
            <input
              type="number"
              min={1}
              placeholder="—"
              {...register('interval_plays_per_week', { setValueAs: v => (v === '' || v == null) ? null : Number(v) })}
              disabled={isLoading || !selectedIntervalId}
              className={INPUT + (!selectedIntervalId ? ' opacity-40' : '')}
            />
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Placement</p>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>
              Priority
              <HelpTooltip text="Hard: the scheduler must hit the monthly play target, bumping best-effort campaigns when there isn't room. Best Effort: plays are distributed opportunistically." />
            </label>
            <select {...register('priority')} disabled={isLoading} className={INPUT}>
              <option value="best_effort">Best Effort</option>
              <option value="hard">Hard</option>
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

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>
              Associated Show
              <HelpTooltip text="When set, this campaign is targeted for airings during this show's time slots." />
            </label>
            <select
              {...register('show_id', { setValueAs: v => v === '' ? null : Number(v) })}
              disabled={isLoading}
              className={INPUT}
            >
              <option value="">Any show</option>
              {shows.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL + (!selectedShowId ? ' opacity-40' : '')}>
              Plays per Show
              <HelpTooltip text="Target number of spot airings per show occurrence. Works alongside the monthly target." />
            </label>
            <input
              type="number"
              min={1}
              placeholder="—"
              {...register('plays_per_show', { setValueAs: v => (v === '' || v == null) ? null : Number(v) })}
              disabled={isLoading || !selectedShowId}
              className={INPUT + (!selectedShowId ? ' opacity-40' : '')}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 items-end">
          <div className="flex items-center gap-2 pb-2">
            <input type="checkbox" {...register('first_in_slot')} disabled={isLoading} className="rounded border-zinc-700 text-indigo-600 h-4 w-4 flex-shrink-0" />
            <label className="text-sm font-medium text-zinc-300 flex items-center gap-0">
              First in slot
              <HelpTooltip text="This campaign's spot should open the commercial break rather than appear mid-break." />
            </label>
          </div>
          <div>
            <label className={LABEL + (!firstInSlot ? ' opacity-40' : '')}>
              First-in-slot rule
              <HelpTooltip text="Every play: all airings open the break. At least once daily: the scheduler guarantees at least one opening position per day. Once daily + shared: one opening per day guaranteed; when multiple campaigns compete for the first slot, they share it across days." />
            </label>
            <select
              {...register('first_in_slot_mode', { setValueAs: v => v === '' ? null : v })}
              disabled={isLoading || !firstInSlot}
              className={INPUT + (!firstInSlot ? ' opacity-40' : '')}
            >
              <option value="always">Every play</option>
              <option value="at_least_one">At least once daily</option>
              <option value="at_least_one_shared">Once daily + shared</option>
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
        <CampaignMediaSection campaignId={campaign.id} sweepsPerMonth={sweepsPerMonth ?? null} />
        {mediaError && (
          <p className="text-red-400 text-xs">{mediaError}</p>
        )}
      </div>

      <div className="space-y-3">
        <SectionDivider label="Billing" />
        <PlaceholderSection label="Campaign Total" description="Price calculation based on spots × rate card. Coming soon." />
      </div>

      <div>
        <label className={LABEL}>Notes</label>
        <textarea {...register('notes')} disabled={isLoading} rows={2} className={INPUT} />
      </div>

      <div className="flex items-center gap-2">
        <input type="checkbox" {...register('active')} disabled={isLoading} className="rounded border-zinc-700 text-indigo-600 h-4 w-4" />
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
