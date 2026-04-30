import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader, Plus, Trash2, ChevronDown } from 'lucide-react';
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

export function CustomersList() {
  const queryClient = useQueryClient();
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | null>(null);
  const [isCreatingCustomer, setIsCreatingCustomer] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const { data: customers = [], isLoading } = useQuery({
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

  const selectedCustomer = customers.find((c) => c.id === selectedCustomerId);
  const customerContracts = selectedCustomerId
    ? contracts.filter((c) => c.customer_id === selectedCustomerId)
    : [];
  const customerContacts = selectedCustomerId
    ? contacts.filter((c) => c.customer_id === selectedCustomerId)
    : [];

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
                <th className="px-6 py-2 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider">
                  Name
                </th>
                <th className="px-6 py-2 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider">
                  Email
                </th>
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
                  className={`hover:bg-zinc-800/50 cursor-pointer transition-colors ${
                    selectedCustomerId === customer.id
                      ? 'bg-indigo-600/20 border-l-2 border-l-indigo-500'
                      : ''
                  }`}
                >
                  <td className="px-6 py-3 font-medium text-white">{customer.name}</td>
                  <td className="px-6 py-3 text-zinc-400">{customer.email || '—'}</td>
                  <td className="px-6 py-3">
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

      {/* BOTTOM: Assets for Selected Customer (50%) */}
      {selectedCustomer ? (
        <div className="flex-1 min-h-0 flex flex-col space-y-4 overflow-hidden">
          {/* Contracts Table */}
          <div className="flex-1 min-h-0 flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            <div className="px-6 py-3 border-b border-zinc-800 flex items-center justify-between bg-zinc-800/50">
              <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
                Contracts ({customerContracts.length})
              </h3>
              <button
                onClick={() => {}}
                className="flex items-center gap-2 px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs rounded transition-colors"
              >
                <Plus className="w-3 h-3" />
                New
              </button>
            </div>

            <div className="flex-1 overflow-auto">
              <table className="w-full text-xs">
                <thead className="bg-zinc-800 sticky top-0">
                  <tr>
                    <th className="px-6 py-2 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider">
                      Name
                    </th>
                    <th className="px-6 py-2 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider">
                      Plays/mo
                    </th>
                    <th className="px-6 py-2 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider">
                      Period
                    </th>
                    <th className="px-6 py-2 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider">
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

          {/* Contacts Table */}
          <div className="flex-1 min-h-0 flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            <div className="px-6 py-3 border-b border-zinc-800 flex items-center justify-between bg-zinc-800/50">
              <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
                Contacts ({customerContacts.length})
              </h3>
              <button
                onClick={() => {}}
                className="flex items-center gap-2 px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs rounded transition-colors"
              >
                <Plus className="w-3 h-3" />
                New
              </button>
            </div>

            <div className="flex-1 overflow-auto">
              <table className="w-full text-xs">
                <thead className="bg-zinc-800 sticky top-0">
                  <tr>
                    <th className="px-6 py-2 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider">
                      Name
                    </th>
                    <th className="px-6 py-2 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider">
                      Email
                    </th>
                    <th className="px-6 py-2 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider">
                      Phone
                    </th>
                    <th className="px-6 py-2 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider">
                      Role
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {customerContacts.map((contact) => (
                    <tr key={contact.id} className="hover:bg-zinc-800/50">
                      <td className="px-6 py-2 font-medium text-white">{contact.name}</td>
                      <td className="px-6 py-2 text-zinc-400">{contact.email || '—'}</td>
                      <td className="px-6 py-2 text-zinc-400">{contact.phone || '—'}</td>
                      <td className="px-6 py-2 text-zinc-400">
                        <span className="text-xs px-2 py-0.5 bg-zinc-800 rounded">
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
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center bg-zinc-900 border border-zinc-800 rounded-lg text-center">
          <p className="text-zinc-500 text-sm">Select a customer to view contracts and contacts</p>
        </div>
      )}
    </div>
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
    <tr className="hover:bg-zinc-800/50">
      <td className="px-6 py-2 font-medium text-white">{contract.name}</td>
      <td className="px-6 py-2 text-zinc-400">{contract.plays_per_month}</td>
      <td className="px-6 py-2 text-zinc-400 text-xs">
        {contract.starts_on} → {contract.ends_on}
      </td>
      <td className="px-6 py-2">
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
