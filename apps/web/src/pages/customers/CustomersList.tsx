import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader, Plus, Trash2, ChevronDown, ChevronUp, ChevronsUpDown, Pencil, X, UserPlus } from 'lucide-react';
import {
  Customer,
  CustomerCreate,
  CustomerCreateSchema,
  CustomerPatch,
  CustomerPatchSchema,
  Contract,
  ContractCreate,
  ContractCreateSchema,
  ContractPatch,
  ContractPatchSchema,
  Contact,
  ContactCreate,
  ContactCreateSchema,
  ContactPatch,
  ContactPatchSchema,
  INTERVAL_OPTIONS,
  INDUSTRY_OPTIONS,
} from '@radio/shared';
import {
  fetchCustomers,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  fetchContracts,
  createContract,
  updateContract,
  deleteContract,
  fetchContacts,
  fetchAllContacts,
  createContact,
  updateContact,
  deleteContact,
  associateContact,
  dissociateContact,
  setContactPrimary,
  fetchContractPacing,
} from '../../api';

type SortConfig = { column: string; direction: 'asc' | 'desc' } | null;

const INPUT = 'w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50';
const LABEL = 'block text-xs font-medium text-zinc-300 mb-1';

export function CustomersList() {
  const queryClient = useQueryClient();
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | null>(null);
  const [isCreatingCustomer, setIsCreatingCustomer] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [activeTab, setActiveTab] = useState<'contracts' | 'contacts'>('contracts');
  const [customerSort, setCustomerSort] = useState<SortConfig>(null);
  const [contractSort, setContractSort] = useState<SortConfig>(null);
  const [contactSort, setContactSort] = useState<SortConfig>(null);
  const [editTarget, setEditTarget] = useState<{
    type: 'customer' | 'contract' | 'contact';
    id: number;
  } | null>(null);
  const [isCreatingContract, setIsCreatingContract] = useState(false);
  const [isCreatingContact, setIsCreatingContact] = useState(false);

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  };

  const { data: rawCustomers = [], isLoading } = useQuery({
    queryKey: ['customers'],
    queryFn: fetchCustomers,
  });

  const { data: contracts = [] } = useQuery({
    queryKey: ['contracts'],
    queryFn: () => fetchContracts(),
  });

  const { data: contacts = [] } = useQuery({
    queryKey: ['contacts', selectedCustomerId],
    queryFn: () => fetchContacts(selectedCustomerId ?? undefined),
    enabled: !!selectedCustomerId,
  });

  const { data: allContacts = [] } = useQuery({
    queryKey: ['contacts-all'],
    queryFn: fetchAllContacts,
  });

  let customers = [...rawCustomers];
  if (customerSort) {
    customers.sort((a, b) => {
      let aVal: any = a[customerSort.column as keyof typeof a];
      let bVal: any = b[customerSort.column as keyof typeof b];
      if (typeof aVal === 'string') aVal = aVal.toLowerCase();
      if (typeof bVal === 'string') bVal = bVal.toLowerCase();
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return customerSort.direction === 'asc' ? cmp : -cmp;
    });
  }

  const selectedCustomer = customers.find((c) => c.id === selectedCustomerId);

  const isCustomerActive = (customerId: number) =>
    contracts.some((c) => c.customer_id === customerId && c.active);
  let customerContracts = selectedCustomerId
    ? contracts.filter((c) => c.customer_id === selectedCustomerId)
    : [];
  let customerContacts = contacts; // already filtered by selectedCustomerId in the query

  if (contractSort) {
    customerContracts = [...customerContracts].sort((a, b) => {
      let aVal: any = a[contractSort.column as keyof typeof a];
      let bVal: any = b[contractSort.column as keyof typeof b];
      if (typeof aVal === 'string') aVal = aVal.toLowerCase();
      if (typeof bVal === 'string') bVal = bVal.toLowerCase();
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return contractSort.direction === 'asc' ? cmp : -cmp;
    });
  }

  if (contactSort) {
    customerContacts = [...customerContacts].sort((a, b) => {
      let aVal: any = a[contactSort.column as keyof typeof a];
      let bVal: any = b[contactSort.column as keyof typeof b];
      if (typeof aVal === 'string') aVal = aVal.toLowerCase();
      if (typeof bVal === 'string') bVal = bVal.toLowerCase();
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return contactSort.direction === 'asc' ? cmp : -cmp;
    });
  }

  const toggleSort = (column: string, setSortFn: (s: SortConfig) => void, currentSort: SortConfig) => {
    if (currentSort?.column === column) {
      setSortFn(currentSort.direction === 'asc' ? { column, direction: 'desc' } : null);
    } else {
      setSortFn({ column, direction: 'asc' });
    }
  };

  const createCustomerMutation = useMutation({
    mutationFn: createCustomer,
    onSuccess: (newCustomer) => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      setIsCreatingCustomer(false);
      setSelectedCustomerId(newCustomer.id);
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

  const deleteCustomerMutation = useMutation({
    mutationFn: deleteCustomer,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      setSelectedCustomerId(null);
      setEditTarget(null);
      showToast('success', 'Customer deleted');
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  const updateContractMutation = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: ContractPatch }) => updateContract(id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
      setEditTarget(null);
      showToast('success', 'Contract updated');
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  const deleteContractMutation = useMutation({
    mutationFn: deleteContract,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
      setEditTarget(null);
      showToast('success', 'Contract deleted');
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  const createContractMutation = useMutation({
    mutationFn: createContract,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
      setIsCreatingContract(false);
      showToast('success', 'Contract created');
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  const createContactMutation = useMutation({
    mutationFn: createContact,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['contacts-all'] });
      setIsCreatingContact(false);
      showToast('success', 'Contact added');
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  const associateContactMutation = useMutation({
    mutationFn: ({ contactId, isPrimary }: { contactId: number; isPrimary?: boolean }) =>
      associateContact(selectedCustomerId!, contactId, isPrimary),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['contacts'] }),
    onError: (err) => showToast('error', (err as Error).message),
  });

  const dissociateContactMutation = useMutation({
    mutationFn: (contactId: number) => dissociateContact(selectedCustomerId!, contactId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['contacts'] }),
    onError: (err) => showToast('error', (err as Error).message),
  });

  const setPrimaryMutation = useMutation({
    mutationFn: ({ customerId, contactId, isPrimary }: { customerId: number; contactId: number; isPrimary: boolean }) =>
      setContactPrimary(customerId, contactId, isPrimary),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['contacts'] }),
    onError: (err) => showToast('error', (err as Error).message),
  });

  const updateContactMutation = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: ContactPatch }) => updateContact(id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      setEditTarget(null);
      showToast('success', 'Contact updated');
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  const deleteContactMutation = useMutation({
    mutationFn: deleteContact,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      setEditTarget(null);
      showToast('success', 'Contact deleted');
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader className="w-8 h-8 animate-spin text-indigo-500" />
      </div>
    );

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

      {/* TOP: Customers Table */}
      <div className="flex-1 min-h-0 flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-zinc-800 flex items-center gap-2 bg-zinc-800/50">
          <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider flex-1">
            Customers ({customers.length})
          </h2>
          {selectedCustomerId && (
            <>
              <button
                onClick={() => setEditTarget({ type: 'customer', id: selectedCustomerId })}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-zinc-300 hover:text-white bg-zinc-700 hover:bg-zinc-600 rounded-lg transition-colors"
              >
                <Pencil className="w-3 h-3" />
                Edit
              </button>
              <button
                onClick={() => deleteCustomerMutation.mutate(selectedCustomerId)}
                disabled={deleteCustomerMutation.isPending}
                className="p-1.5 text-zinc-400 hover:text-red-400 hover:bg-red-900/20 rounded-lg transition-colors disabled:opacity-50"
                title="Delete customer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </>
          )}
          <button
            onClick={() => setIsCreatingCustomer(true)}
            className="flex items-center gap-2 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            New
          </button>
        </div>

        {isCreatingCustomer && (
          <div className="px-6 py-3 border-b border-zinc-800 bg-zinc-800/30">
            <CreateCustomerForm
              onSubmit={(data) => createCustomerMutation.mutate(data)}
              onCancel={() => setIsCreatingCustomer(false)}
              isLoading={createCustomerMutation.isPending}
            />
          </div>
        )}

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
                  onClick={() => setSelectedCustomerId(customer.id)}
                  onDoubleClick={() => setEditTarget({ type: 'customer', id: customer.id })}
                  title="Double-click to edit"
                  className={`hover:bg-zinc-800/50 cursor-pointer transition-colors ${
                    selectedCustomerId === customer.id
                      ? 'bg-indigo-600/20 border-l-2 border-l-indigo-500'
                      : ''
                  }`}
                >
                  <td className="px-6 py-3 font-medium text-white">{customer.name}</td>
                  <td className="px-6 py-3 text-zinc-300">{customer.email || '—'}</td>
                  <td className="px-6 py-3">
                    {isCustomerActive(customer.id) ? (
                      <span className="text-xs px-2 py-1 rounded bg-green-900/30 text-green-300">Active</span>
                    ) : (
                      <span className="text-xs px-2 py-1 rounded bg-zinc-800 text-zinc-400">No active contracts</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {customers.length === 0 && !isCreatingCustomer && (
            <div className="p-6 text-center text-zinc-300 text-sm">
              No customers. Create one to get started.
            </div>
          )}
        </div>
      </div>

      {/* BOTTOM: Assets for Selected Customer — Tabbed View */}
      {selectedCustomer ? (
        <div className="flex-1 min-h-0 flex flex-col bg-slate-950 border border-indigo-900/50 rounded-lg overflow-hidden">
          <div className="flex border-b border-indigo-900/30 bg-slate-900/50">
            <button
              onClick={() => setActiveTab('contracts')}
              className={`px-6 py-3 text-sm font-medium transition-colors ${
                activeTab === 'contracts'
                  ? 'text-white border-b-2 border-indigo-500 bg-slate-950'
                  : 'text-zinc-300 hover:text-white'
              }`}
            >
              Contracts ({customerContracts.length})
            </button>
            <button
              onClick={() => setActiveTab('contacts')}
              className={`px-6 py-3 text-sm font-medium transition-colors ${
                activeTab === 'contacts'
                  ? 'text-white border-b-2 border-indigo-500 bg-slate-950'
                  : 'text-zinc-300 hover:text-white'
              }`}
            >
              Contacts ({customerContacts.length})
            </button>
          </div>

          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {activeTab === 'contracts' ? (
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="px-6 py-3 border-b border-zinc-800 flex items-center justify-end bg-zinc-800/30">
                  <button
                    onClick={() => { setIsCreatingContract(true); setIsCreatingContact(false); }}
                    className="flex items-center gap-2 px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs rounded transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                    New Contract
                  </button>
                </div>
                {isCreatingContract && selectedCustomerId && (
                  <div className="px-6 py-3 border-b border-zinc-800 bg-zinc-800/30">
                    <CreateContractForm
                      customerId={selectedCustomerId}
                      onSubmit={(data) => createContractMutation.mutate(data)}
                      onCancel={() => setIsCreatingContract(false)}
                      isLoading={createContractMutation.isPending}
                    />
                  </div>
                )}
                <div className="flex-1 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-zinc-800 sticky top-0">
                      <tr>
                        <SortableHeader
                          label="Name"
                          column="name"
                          isActive={contractSort?.column === 'name'}
                          direction={contractSort?.direction}
                          onSort={() => toggleSort('name', setContractSort, contractSort)}
                          borderColor="border-indigo-800"
                        />
                        <SortableHeader
                          label="Plays/mo"
                          column="plays_per_month"
                          isActive={contractSort?.column === 'plays_per_month'}
                          direction={contractSort?.direction}
                          onSort={() => toggleSort('plays_per_month', setContractSort, contractSort)}
                          borderColor="border-indigo-800"
                        />
                        <SortableHeader
                          label="Period"
                          column="starts_on"
                          isActive={contractSort?.column === 'starts_on'}
                          direction={contractSort?.direction}
                          onSort={() => toggleSort('starts_on', setContractSort, contractSort)}
                          borderColor="border-indigo-800"
                        />
                        <th className="px-6 py-2 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider">
                          Pacing
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800">
                      {customerContracts.map((contract) => (
                        <ContractTableRow
                          key={contract.id}
                          contract={contract}
                          onEdit={() => setEditTarget({ type: 'contract', id: contract.id })}
                        />
                      ))}
                    </tbody>
                  </table>

                  {customerContracts.length === 0 && (
                    <div className="p-4 text-center text-zinc-300 text-xs">No contracts</div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="px-6 py-3 border-b border-zinc-800 flex items-center justify-end bg-zinc-800/30">
                  <button
                    onClick={() => { setIsCreatingContact(true); setIsCreatingContract(false); }}
                    className="flex items-center gap-2 px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs rounded transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                    New Contact
                  </button>
                </div>
                {isCreatingContact && selectedCustomerId && (
                  <div className="px-6 py-3 border-b border-zinc-800 bg-zinc-800/30">
                    <CreateContactForm
                      customerId={selectedCustomerId}
                      onSubmit={(data) => createContactMutation.mutate(data)}
                      onCancel={() => setIsCreatingContact(false)}
                      isLoading={createContactMutation.isPending}
                    />
                  </div>
                )}
                <div className="flex-1 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-zinc-800 sticky top-0">
                      <tr>
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
                      {customerContacts.map((contact) => (
                        <tr
                          key={contact.id}
                          onDoubleClick={() => setEditTarget({ type: 'contact', id: contact.id })}
                          title="Double-click to edit"
                          className="hover:bg-slate-900/50 cursor-pointer"
                        >
                          <td className="px-6 py-2 font-medium text-white">{contact.name}</td>
                          <td className="px-6 py-2 text-zinc-300">{contact.email || '—'}</td>
                          <td className="px-6 py-2 text-zinc-300">{contact.phone || '—'}</td>
                          <td className="px-6 py-2 text-zinc-300">
                            <span className="text-xs px-2 py-0.5 bg-slate-800 rounded">
                              {contact.role || 'General'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {customerContacts.length === 0 && (
                    <div className="p-4 text-center text-zinc-300 text-xs">No contacts</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center bg-zinc-900 border border-zinc-800 rounded-lg text-center">
          <p className="text-zinc-400 text-sm">Select a customer to view contracts and contacts</p>
        </div>
      )}

      {/* Edit Modal */}
      {editTarget && (
        <EditModal
          target={editTarget}
          customers={customers}
          contracts={contracts}
          contacts={contacts}
          allContacts={allContacts}
          onClose={() => setEditTarget(null)}
          onEditContact={(id) => setEditTarget({ type: 'contact', id })}
          onUpdateCustomer={(id, patch) => updateCustomerMutation.mutate({ id, patch })}
          onDeleteCustomer={(id) => deleteCustomerMutation.mutate(id)}
          onCreateContact={(data) => createContactMutation.mutate(data)}
          onAssociateContact={(contactId, isPrimary) =>
            associateContactMutation.mutate({ contactId, isPrimary })
          }
          onDissociateContact={(contactId) => dissociateContactMutation.mutate(contactId)}
          onSetPrimary={(customerId, contactId, isPrimary) =>
            setPrimaryMutation.mutate({ customerId, contactId, isPrimary })
          }
          onUpdateContract={(id, patch) => updateContractMutation.mutate({ id, patch })}
          onDeleteContract={(id) => deleteContractMutation.mutate(id)}
          onUpdateContact={(id, patch) => updateContactMutation.mutate({ id, patch })}
          onDeleteContact={(id) => deleteContactMutation.mutate(id)}
          isUpdating={
            updateCustomerMutation.isPending ||
            updateContractMutation.isPending ||
            updateContactMutation.isPending
          }
          isDeleting={
            deleteCustomerMutation.isPending ||
            deleteContractMutation.isPending ||
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

function CreateCustomerForm({
  onSubmit,
  onCancel,
  isLoading,
}: {
  onSubmit: (data: CustomerCreate) => void;
  onCancel: () => void;
  isLoading: boolean;
}) {
  const { register, handleSubmit, formState } = useForm<CustomerCreate>({
    resolver: zodResolver(CustomerCreateSchema),
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        <div>
          <input
            type="text"
            {...register('name')}
            placeholder="Customer name *"
            className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
          />
          {formState.errors.name && (
            <p className="text-red-400 text-xs mt-0.5">{formState.errors.name.message}</p>
          )}
        </div>
        <input
          type="email"
          {...register('email')}
          placeholder="Email"
          className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isLoading}
            className="flex-1 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-white text-xs rounded transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isLoading}
            className="flex-1 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs rounded transition-colors disabled:opacity-50"
          >
            Create
          </button>
        </div>
      </div>
    </form>
  );
}

function ContractTableRow({
  contract,
  onEdit,
}: {
  contract: Contract & { customer_name: string };
  onEdit: () => void;
}) {
  const { data: pacing } = useQuery({
    queryKey: ['contract-pacing', contract.id],
    queryFn: () => fetchContractPacing(contract.id),
  });

  return (
    <tr onDoubleClick={onEdit} title="Double-click to edit" className="hover:bg-slate-900/50 cursor-pointer">
      <td className="px-6 py-2 font-medium text-white">{contract.name}</td>
      <td className="px-6 py-2 text-zinc-300">{contract.plays_per_month}</td>
      <td className="px-6 py-2 text-zinc-300 text-xs">
        {contract.starts_on} → {contract.ends_on}
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
  contracts,
  contacts,
  allContacts,
  onClose,
  onEditContact,
  onUpdateCustomer,
  onDeleteCustomer,
  onCreateContact,
  onAssociateContact,
  onDissociateContact,
  onSetPrimary,
  onUpdateContract,
  onDeleteContract,
  onUpdateContact,
  onDeleteContact,
  isUpdating,
  isDeleting,
}: {
  target: { type: 'customer' | 'contract' | 'contact'; id: number };
  customers: Customer[];
  contracts: (Contract & { customer_name: string })[];
  contacts: (Contact & { is_primary: boolean })[];
  allContacts: Contact[];
  onClose: () => void;
  onEditContact: (id: number) => void;
  onUpdateCustomer: (id: number, patch: CustomerPatch) => void;
  onDeleteCustomer: (id: number) => void;
  onCreateContact: (data: ContactCreate) => void;
  onAssociateContact: (contactId: number, isPrimary?: boolean) => void;
  onDissociateContact: (contactId: number) => void;
  onSetPrimary: (customerId: number, contactId: number, isPrimary: boolean) => void;
  onUpdateContract: (id: number, patch: ContractPatch) => void;
  onDeleteContract: (id: number) => void;
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
    } else if (target.type === 'contract') {
      const c = contracts.find((c) => c.id === target.id);
      return c ? c.name : 'Contract';
    } else {
      const c = contacts.find((c) => c.id === target.id);
      return c ? c.name : 'Contact';
    }
  };

  const typeLabel =
    target.type === 'customer' ? 'Customer' :
    target.type === 'contract' ? 'Contract' : 'Contact';

  const handleDelete = () => {
    if (target.type === 'customer') onDeleteCustomer(target.id);
    else if (target.type === 'contract') onDeleteContract(target.id);
    else onDeleteContact(target.id);
  };

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
              onSubmit={(patch) => onUpdateCustomer(target.id, patch)}
              onCreateContact={onCreateContact}
              onAssociateContact={onAssociateContact}
              onDissociateContact={onDissociateContact}
              onSetPrimary={(contactId, isPrimary) => onSetPrimary(target.id, contactId, isPrimary)}
              onDeleteContact={onDeleteContact}
              isLoading={isUpdating}
            />
          )}
          {target.type === 'contract' && (
            <ContractEditForm
              contract={contracts.find((c) => c.id === target.id)!}
              onSubmit={(patch) => onUpdateContract(target.id, patch)}
              isLoading={isUpdating}
            />
          )}
          {target.type === 'contact' && (
            <ContactEditForm
              contact={contacts.find((c) => c.id === target.id)!}
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
                Delete this {typeLabel.toLowerCase()}? <span className="text-zinc-300">This cannot be undone.</span>
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
  onSubmit: (patch: CustomerPatch) => void;
  onCreateContact: (data: ContactCreate) => void;
  onAssociateContact: (contactId: number, isPrimary?: boolean) => void;
  onDissociateContact: (contactId: number) => void;
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
    defaultValues: { name: customer.name, notes: customer.notes || undefined },
  });

  const { register: regContact, handleSubmit: handleContactSubmit, reset: resetContact, formState: contactForm } =
    useForm<ContactCreate>({
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
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <label className={LABEL}>Customer Name *</label>
          <input type="text" {...register('name')} disabled={isLoading} className={INPUT} />
          {formState.errors.name && (
            <p className="text-red-400 text-xs mt-1">{formState.errors.name.message}</p>
          )}
        </div>
        <div>
          <label className={LABEL}>Created</label>
          <div className="px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-300">
            {customer.created_at.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
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
                <span className="text-xs text-zinc-300">Delete {contact.name}? This cannot be undone.</span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setConfirmDeleteContact(null)} className="px-2 py-0.5 text-xs bg-zinc-700 hover:bg-zinc-600 text-white rounded transition-colors">Cancel</button>
                  <button type="button" onClick={() => { onDeleteContact(contact.id); setConfirmDeleteContact(null); }} className="px-2 py-0.5 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition-colors">Yes, delete</button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white truncate">{contact.name}</span>
                    {contact.role && <span className="text-xs text-zinc-300">{contact.role}</span>}
                  </div>
                  <div className="flex gap-3 mt-0.5">
                    {contact.email && <span className="text-xs text-zinc-300">{contact.email}</span>}
                    {contact.phone && <span className="text-xs text-zinc-300">{contact.phone}</span>}
                  </div>
                </div>
                {/* Primary toggle */}
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
                {/* Deassociate */}
                <button
                  type="button"
                  onClick={() => onDissociateContact(contact.id)}
                  title="Remove association"
                  className="p-1 text-zinc-500 hover:text-amber-400 hover:bg-amber-900/20 rounded transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
                {/* Delete */}
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

        {/* Add new contact inline form */}
        {addMode === 'new' && (
          <div className="border border-zinc-700 rounded-lg p-3 space-y-2 bg-zinc-800/50">
            <p className="text-xs font-medium text-zinc-300">New contact</p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <input {...regContact('name')} placeholder="Name *" className="w-full px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500" />
                {contactForm.errors.name && <p className="text-red-400 text-xs mt-0.5">{contactForm.errors.name.message}</p>}
              </div>
              <input {...regContact('role')} placeholder="Role" className="w-full px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500" />
              <input {...regContact('email')} type="email" placeholder="Email" className="w-full px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500" />
              <input {...regContact('phone')} placeholder="Phone" className="w-full px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500" />
            </div>
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => { setAddMode('none'); resetContact({ customer_id: customer.id }); }} className="px-3 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-white rounded transition-colors">Cancel</button>
              <button type="button" onClick={handleContactSubmit(submitNewContact)} className="px-3 py-1 text-xs bg-indigo-600 hover:bg-indigo-700 text-white rounded transition-colors">Add</button>
            </div>
          </div>
        )}

        {/* Associate existing contact picker */}
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
                    onClick={() => { onAssociateContact(c.id); setAddMode('none'); }}
                    className="w-full text-left px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition-colors"
                  >
                    <span className="text-sm text-white">{c.name}</span>
                    {c.role && <span className="text-xs text-zinc-400 ml-2">{c.role}</span>}
                    {c.email && <span className="text-xs text-zinc-500 ml-2">{c.email}</span>}
                  </button>
                ))}
              </div>
            )}
            <button type="button" onClick={() => setAddMode('none')} className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors">Cancel</button>
          </div>
        )}

        {/* Action buttons */}
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
        <SectionDivider label="Account Manager" />
        <PlaceholderSection label="Account Manager" description="Assign one of your team members as account manager. Coming soon." />
      </div>

      <div className="space-y-2">
        <SectionDivider label="Attachments" />
        <PlaceholderSection label="Documents & Files" description="Attach contracts, legal documents, and other files here. Coming soon." />
      </div>

      <div className="space-y-2">
        <SectionDivider label="History" />
        <PlaceholderSection label="Campaign History" description="Performance history and past campaigns will appear here. Coming soon." />
      </div>
    </form>
  );
}

function ContractEditForm({
  contract,
  onSubmit,
  isLoading,
}: {
  contract: Contract & { customer_name: string };
  onSubmit: (patch: ContractPatch) => void;
  isLoading: boolean;
}) {
  const { register, handleSubmit, formState } = useForm<ContractPatch>({
    resolver: zodResolver(ContractPatchSchema),
    defaultValues: {
      name: contract.name,
      starts_on: contract.starts_on,
      ends_on: contract.ends_on,
      plays_per_month: contract.plays_per_month,
      priority: contract.priority,
      interval: contract.interval ?? undefined,
      industry: contract.industry ?? undefined,
      first_slot: contract.first_slot ?? false,
      notes: contract.notes || undefined,
      active: contract.active,
    },
  });

  return (
    <form id="edit-form" onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      {/* Basic info */}
      <div>
        <label className={LABEL}>Contract Name *</label>
        <input type="text" {...register('name')} disabled={isLoading} className={INPUT} />
        {formState.errors.name && (
          <p className="text-red-400 text-xs mt-1">{formState.errors.name.message}</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LABEL}>Start Date *</label>
          <input type="date" {...register('starts_on')} disabled={isLoading} className={INPUT} />
        </div>
        <div>
          <label className={LABEL}>End Date *</label>
          <input type="date" {...register('ends_on')} disabled={isLoading} className={INPUT} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LABEL}>Plays / Month *</label>
          <input
            type="number"
            {...register('plays_per_month', { valueAsNumber: true })}
            disabled={isLoading}
            className={INPUT}
          />
          {formState.errors.plays_per_month && (
            <p className="text-red-400 text-xs mt-1">{formState.errors.plays_per_month.message}</p>
          )}
        </div>
        <div>
          <label className={LABEL}>Priority</label>
          <select {...register('priority')} disabled={isLoading} className={INPUT}>
            <option value="soft">Soft</option>
            <option value="standard">Standard</option>
            <option value="hard">Hard</option>
          </select>
        </div>
      </div>

      {/* Scheduling */}
      <div className="space-y-3">
        <SectionDivider label="Scheduling" />

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>Interval</label>
            <select {...register('interval')} disabled={isLoading} className={INPUT}>
              <option value="">— Any —</option>
              {INTERVAL_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v === 'prime' ? 'Prime Time' : v === 'regular' ? 'Regular' : 'Night'}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL}>Industry</label>
            <select {...register('industry')} disabled={isLoading} className={INPUT}>
              <option value="">— None —</option>
              <option value="retail">Retail</option>
              <option value="automotive">Automotive</option>
              <option value="food_beverage">Food & Beverage</option>
              <option value="healthcare">Healthcare</option>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            {...register('first_slot')}
            disabled={isLoading}
            className="rounded border-zinc-700 text-indigo-600 h-4 w-4"
          />
          <label className="text-sm font-medium text-zinc-300">First slot in interval</label>
          <span className="text-xs text-zinc-300">— spot plays first in the break</span>
        </div>
      </div>

      {/* Placeholders */}
      <div className="space-y-3">
        <SectionDivider label="Assignment" />

        <div>
          <label className={LABEL}>Show</label>
          <input
            type="text"
            disabled
            placeholder="Show assignment — coming soon"
            className={INPUT + ' cursor-not-allowed'}
          />
        </div>

        <div>
          <label className={LABEL}>Associated Elements</label>
          <input
            type="text"
            disabled
            placeholder="Full commercial, short jingle — coming soon"
            className={INPUT + ' cursor-not-allowed'}
          />
        </div>
      </div>

      <div>
        <label className={LABEL}>Notes</label>
        <textarea {...register('notes')} disabled={isLoading} rows={2} className={INPUT} />
      </div>

      <div className="flex items-center gap-2">
        <input type="checkbox" {...register('active')} disabled={isLoading} className="rounded border-zinc-700 text-indigo-600 h-4 w-4" />
        <label className="text-sm font-medium text-zinc-300">Active</label>
      </div>
    </form>
  );
}

function CreateContractForm({
  customerId,
  onSubmit,
  onCancel,
  isLoading,
}: {
  customerId: number;
  onSubmit: (data: ContractCreate) => void;
  onCancel: () => void;
  isLoading: boolean;
}) {
  const { register, handleSubmit, formState } = useForm<ContractCreate>({
    resolver: zodResolver(ContractCreateSchema),
    defaultValues: {
      customer_id: customerId,
      plays_per_month: 30,
      separation_minutes: 90,
      advertiser_separation_min: 30,
      priority: 'standard',
    },
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-2">
      <div className="grid grid-cols-4 gap-2">
        <div className="col-span-2">
          <input
            type="text"
            {...register('name')}
            placeholder="Contract name *"
            className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
          />
          {formState.errors.name && (
            <p className="text-red-400 text-xs mt-0.5">{formState.errors.name.message}</p>
          )}
        </div>
        <input
          type="date"
          {...register('starts_on')}
          title="Start date"
          className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
        />
        <input
          type="date"
          {...register('ends_on')}
          title="End date"
          className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
        />
      </div>
      <div className="grid grid-cols-4 gap-2">
        <div>
          <input
            type="number"
            {...register('plays_per_month', { valueAsNumber: true })}
            placeholder="Plays/month *"
            className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
          />
          {formState.errors.plays_per_month && (
            <p className="text-red-400 text-xs mt-0.5">{formState.errors.plays_per_month.message}</p>
          )}
        </div>
        <select
          {...register('priority')}
          className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
        >
          <option value="soft">Soft</option>
          <option value="standard">Standard</option>
          <option value="hard">Hard</option>
        </select>
        <div className="col-span-2 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isLoading}
            className="flex-1 px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white text-xs rounded transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isLoading}
            className="flex-1 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs rounded transition-colors disabled:opacity-50"
          >
            {isLoading ? 'Creating…' : 'Create'}
          </button>
        </div>
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
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-2">
      <div className="grid grid-cols-4 gap-2">
        <div>
          <input
            type="text"
            {...register('name')}
            placeholder="Name *"
            className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
          />
          {formState.errors.name && (
            <p className="text-red-400 text-xs mt-0.5">{formState.errors.name.message}</p>
          )}
        </div>
        <input
          type="text"
          {...register('role')}
          placeholder="Role"
          className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
        />
        <input
          type="email"
          {...register('email')}
          placeholder="Email"
          className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isLoading}
            className="flex-1 px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white text-xs rounded transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isLoading}
            className="flex-1 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs rounded transition-colors disabled:opacity-50"
          >
            {isLoading ? 'Creating…' : 'Create'}
          </button>
        </div>
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
        <input type="text" {...register('role')} disabled={isLoading} placeholder="e.g. Account Manager" className={INPUT} />
      </div>

      <div>
        <label className={LABEL}>Notes</label>
        <textarea {...register('notes')} disabled={isLoading} rows={2} className={INPUT} />
      </div>
    </form>
  );
}
