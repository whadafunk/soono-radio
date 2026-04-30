import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader, Plus, Trash2, ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';
import {
  Customer,
  CustomerCreate,
  CustomerCreateSchema,
  CustomerPatch,
  Contract,
  ContractCreate,
  ContractCreateSchema,
  ContractPatch,
  Contact,
  ContactCreate,
  ContactCreateSchema,
  ContactPatch,
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
  createContact,
  updateContact,
  deleteContact,
  fetchContractPacing,
} from '../../api';

type SortConfig = { column: string; direction: 'asc' | 'desc' } | null;

export function CustomersList() {
  const queryClient = useQueryClient();
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | null>(null);
  const [isCreatingCustomer, setIsCreatingCustomer] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [activeTab, setActiveTab] = useState<'contracts' | 'contacts'>('contracts');
  const [customerSort, setCustomerSort] = useState<SortConfig>(null);
  const [contractSort, setContractSort] = useState<SortConfig>(null);
  const [contactSort, setContactSort] = useState<SortConfig>(null);

  const { data: rawCustomers = [], isLoading } = useQuery({
    queryKey: ['customers'],
    queryFn: fetchCustomers,
  });

  const { data: contracts = [] } = useQuery({
    queryKey: ['contracts'],
    queryFn: () => fetchContracts(),
  });

  const { data: contacts = [] } = useQuery({
    queryKey: ['contacts'],
    queryFn: () => fetchContacts(),
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
  let customerContracts = selectedCustomerId
    ? contracts.filter((c) => c.customer_id === selectedCustomerId)
    : [];
  let customerContacts = selectedCustomerId
    ? contacts.filter((c) => c.customer_id === selectedCustomerId)
    : [];

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
      setToast({ type: 'success', message: 'Customer created' });
      setTimeout(() => setToast(null), 3000);
    },
    onError: (err) => {
      setToast({ type: 'error', message: (err as Error).message });
      setTimeout(() => setToast(null), 3000);
    },
  });

  const deleteCustomerMutation = useMutation({
    mutationFn: deleteCustomer,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      setSelectedCustomerId(null);
      setToast({ type: 'success', message: 'Customer deleted' });
      setTimeout(() => setToast(null), 3000);
    },
    onError: (err) => {
      setToast({ type: 'error', message: (err as Error).message });
      setTimeout(() => setToast(null), 3000);
    },
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

      {/* TOP: Customers Table (50%) */}
      <div className="flex-1 min-h-0 flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-800/50">
          <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
            Customers ({customers.length})
          </h2>
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
                <th className="px-6 py-2 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider border-r border-zinc-700/50">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {customers.map((customer) => (
                <tr
                  key={customer.id}
                  onClick={() => setSelectedCustomerId(customer.id)}
                  className={`hover:bg-zinc-800/50 cursor-pointer transition-colors ${
                    selectedCustomerId === customer.id
                      ? 'bg-indigo-600/20 border-l-2 border-l-indigo-500'
                      : ''
                  }`}
                >
                  <td className="px-6 py-3 font-medium text-white border-r border-zinc-700/50">{customer.name}</td>
                  <td className="px-6 py-3 text-zinc-400 border-r border-zinc-700/50">{customer.email || '—'}</td>
                  <td className="px-6 py-3 border-r border-zinc-700/50">
                    <span
                      className={`text-xs px-2 py-1 rounded ${
                        customer.active
                          ? 'bg-green-900/30 text-green-300'
                          : 'bg-zinc-800 text-zinc-400'
                      }`}
                    >
                      {customer.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {customers.length === 0 && !isCreatingCustomer && (
            <div className="p-6 text-center text-zinc-400 text-sm">
              No customers. Create one to get started.
            </div>
          )}
        </div>
      </div>

      {/* BOTTOM: Assets for Selected Customer (50%) — Tabbed View */}
      {selectedCustomer ? (
        <div className="flex-1 min-h-0 flex flex-col bg-slate-950 border border-indigo-900/50 rounded-lg overflow-hidden">
          {/* Tab Bar */}
          <div className="flex border-b border-indigo-900/30 bg-slate-900/50">
            <button
              onClick={() => setActiveTab('contracts')}
              className={`px-6 py-3 text-sm font-medium transition-colors ${
                activeTab === 'contracts'
                  ? 'text-white border-b-2 border-indigo-500 bg-slate-950'
                  : 'text-zinc-400 hover:text-zinc-300'
              }`}
            >
              Contracts ({customerContracts.length})
            </button>
            <button
              onClick={() => setActiveTab('contacts')}
              className={`px-6 py-3 text-sm font-medium transition-colors ${
                activeTab === 'contacts'
                  ? 'text-white border-b-2 border-indigo-500 bg-slate-950'
                  : 'text-zinc-400 hover:text-zinc-300'
              }`}
            >
              Contacts ({customerContacts.length})
            </button>
          </div>

          {/* Tab Content */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {activeTab === 'contracts' ? (
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="px-6 py-3 border-b border-zinc-800 flex items-center justify-between bg-zinc-800/30">
                  <button
                    onClick={() => {}}
                    className="flex items-center gap-2 px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs rounded transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                    New Contract
                  </button>
                </div>
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
                          borderColor="border-indigo-900/30"
                        />
                        <SortableHeader
                          label="Plays/mo"
                          column="plays_per_month"
                          isActive={contractSort?.column === 'plays_per_month'}
                          direction={contractSort?.direction}
                          onSort={() => toggleSort('plays_per_month', setContractSort, contractSort)}
                          borderColor="border-indigo-900/30"
                        />
                        <SortableHeader
                          label="Period"
                          column="starts_on"
                          isActive={contractSort?.column === 'starts_on'}
                          direction={contractSort?.direction}
                          onSort={() => toggleSort('starts_on', setContractSort, contractSort)}
                          borderColor="border-indigo-900/30"
                        />
                        <th className="px-6 py-2 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider border-r border-indigo-900/30">
                          Pacing
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800">
                      {customerContracts.map((contract) => (
                        <ContractTableRow key={contract.id} contract={contract} />
                      ))}
                    </tbody>
                  </table>

                  {customerContracts.length === 0 && (
                    <div className="p-4 text-center text-zinc-500 text-xs">
                      No contracts
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="px-6 py-3 border-b border-zinc-800 flex items-center justify-between bg-zinc-800/30">
                  <button
                    onClick={() => {}}
                    className="flex items-center gap-2 px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs rounded transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                    New Contact
                  </button>
                </div>
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
                          borderColor="border-indigo-900/30"
                        />
                        <SortableHeader
                          label="Email"
                          column="email"
                          isActive={contactSort?.column === 'email'}
                          direction={contactSort?.direction}
                          onSort={() => toggleSort('email', setContactSort, contactSort)}
                          borderColor="border-indigo-900/30"
                        />
                        <SortableHeader
                          label="Phone"
                          column="phone"
                          isActive={contactSort?.column === 'phone'}
                          direction={contactSort?.direction}
                          onSort={() => toggleSort('phone', setContactSort, contactSort)}
                          borderColor="border-indigo-900/30"
                        />
                        <SortableHeader
                          label="Role"
                          column="role"
                          isActive={contactSort?.column === 'role'}
                          direction={contactSort?.direction}
                          onSort={() => toggleSort('role', setContactSort, contactSort)}
                          borderColor="border-indigo-900/30"
                        />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800">
                      {customerContacts.map((contact) => (
                        <tr key={contact.id} className="hover:bg-slate-900/50">
                          <td className="px-6 py-2 font-medium text-white border-r border-indigo-900/30">{contact.name}</td>
                          <td className="px-6 py-2 text-zinc-400 border-r border-indigo-900/30">{contact.email || '—'}</td>
                          <td className="px-6 py-2 text-zinc-400 border-r border-indigo-900/30">{contact.phone || '—'}</td>
                          <td className="px-6 py-2 text-zinc-400 border-r border-indigo-900/30">
                            <span className="text-xs px-2 py-0.5 bg-slate-800 rounded">
                              {contact.role || 'General'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {customerContacts.length === 0 && (
                    <div className="p-4 text-center text-zinc-500 text-xs">
                      No contacts
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center bg-zinc-900 border border-zinc-800 rounded-lg text-center">
          <p className="text-zinc-500 text-sm">Select a customer to view contracts and contacts</p>
        </div>
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
  borderColor = 'border-zinc-700/50',
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

function ContractTableRow({ contract }: { contract: Contract & { customer_name: string } }) {
  const { data: pacing } = useQuery({
    queryKey: ['contract-pacing', contract.id],
    queryFn: () => fetchContractPacing(contract.id),
  });

  return (
    <tr className="hover:bg-slate-900/50">
      <td className="px-6 py-2 font-medium text-white border-r border-indigo-900/30">{contract.name}</td>
      <td className="px-6 py-2 text-zinc-400 border-r border-indigo-900/30">{contract.plays_per_month}</td>
      <td className="px-6 py-2 text-zinc-400 text-xs border-r border-indigo-900/30">
        {contract.starts_on} → {contract.ends_on}
      </td>
      <td className="px-6 py-2 border-r border-indigo-900/30">
        {pacing && (
          <div className="flex items-center gap-2">
            <div className="text-xs font-medium text-white">{pacing.pct}%</div>
            <span
              className={`text-xs ${pacing.on_track ? 'text-green-400' : 'text-amber-400'}`}
            >
              {pacing.on_track ? '✓' : '⚠'}
            </span>
          </div>
        )}
      </td>
    </tr>
  );
}
