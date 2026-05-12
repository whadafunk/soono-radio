import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
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
} from 'lucide-react';
import {
  User,
  UserCreate,
  UserCreateSchema,
  UserPatch,
  UserPatchSchema,
} from '@radio/shared';
import { fetchUsers, createUser, updateUser, deleteUsers } from '../../api';

type SortConfig = { column: string; direction: 'asc' | 'desc' } | null;
type Toast = { type: 'success' | 'error'; message: string } | null;

const INPUT =
  'w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50';
const LABEL = 'block text-xs font-medium text-zinc-300 mb-1';

function sortRows<T extends object>(rows: T[], sort: SortConfig): T[] {
  if (!sort) return rows;
  return [...rows].sort((a, b) => {
    let aVal: unknown = a[sort.column as keyof T];
    let bVal: unknown = b[sort.column as keyof T];
    if (aVal == null) aVal = '';
    if (bVal == null) bVal = '';
    if (typeof aVal === 'string') aVal = aVal.toLowerCase();
    if (typeof bVal === 'string') bVal = bVal.toLowerCase();
    const cmp =
      (aVal as string) < (bVal as string) ? -1 : (aVal as string) > (bVal as string) ? 1 : 0;
    return sort.direction === 'asc' ? cmp : -cmp;
  });
}

function SortIcon({ column, sort }: { column: string; sort: SortConfig }) {
  if (!sort || sort.column !== column) return <ChevronsUpDown size={12} className="text-zinc-500" />;
  return sort.direction === 'asc' ? (
    <ChevronUp size={12} className="text-indigo-400" />
  ) : (
    <ChevronDown size={12} className="text-indigo-400" />
  );
}

function ToastBanner({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  if (!toast) return null;
  return (
    <div
      className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg text-sm font-medium ${
        toast.type === 'success'
          ? 'bg-emerald-600 text-white'
          : 'bg-red-600 text-white'
      }`}
    >
      {toast.message}
      <button onClick={onClose} className="ml-1 opacity-70 hover:opacity-100">
        <X size={14} />
      </button>
    </div>
  );
}

function UserForm({
  defaultValues,
  onSubmit,
  onCancel,
  isLoading,
  submitLabel,
}: {
  defaultValues?: Partial<UserCreate>;
  onSubmit: (data: UserCreate) => void;
  onCancel: () => void;
  isLoading: boolean;
  submitLabel: string;
}) {
  const { register, handleSubmit, formState } = useForm<UserCreate>({
    resolver: zodResolver(UserCreateSchema),
    defaultValues: {
      first_name: '',
      last_name: '',
      account_name: '',
      email: null,
      title: null,
      ...defaultValues,
    },
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <div className="px-6 py-5 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={LABEL}>First Name *</label>
            <input
              type="text"
              {...register('first_name')}
              disabled={isLoading}
              className={INPUT}
              placeholder="Jane"
            />
            {formState.errors.first_name && (
              <p className="text-red-400 text-xs mt-1">{formState.errors.first_name.message}</p>
            )}
          </div>
          <div>
            <label className={LABEL}>Last Name *</label>
            <input
              type="text"
              {...register('last_name')}
              disabled={isLoading}
              className={INPUT}
              placeholder="Smith"
            />
            {formState.errors.last_name && (
              <p className="text-red-400 text-xs mt-1">{formState.errors.last_name.message}</p>
            )}
          </div>
        </div>
        <div>
          <label className={LABEL}>Account Name *</label>
          <input
            type="text"
            {...register('account_name')}
            disabled={isLoading}
            className={INPUT}
            placeholder="jsmith"
          />
          {formState.errors.account_name && (
            <p className="text-red-400 text-xs mt-1">{formState.errors.account_name.message}</p>
          )}
        </div>
        <div>
          <label className={LABEL}>Email Address</label>
          <input
            type="email"
            {...register('email')}
            disabled={isLoading}
            className={INPUT}
            placeholder="jane@example.com"
          />
          {formState.errors.email && (
            <p className="text-red-400 text-xs mt-1">{formState.errors.email.message}</p>
          )}
        </div>
        <div>
          <label className={LABEL}>Title</label>
          <input
            type="text"
            {...register('title')}
            disabled={isLoading}
            className={INPUT}
            placeholder="Station Manager"
          />
        </div>
      </div>
      <div className="px-6 py-4 border-t border-zinc-700 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={isLoading}
          className="px-4 py-2 text-sm text-zinc-300 hover:text-white disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isLoading}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg disabled:opacity-50 flex items-center gap-2"
        >
          {isLoading && <Loader size={14} className="animate-spin" />}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

export function UsersSettings() {
  const queryClient = useQueryClient();
  const [sort, setSort] = useState<SortConfig>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [lastClicked, setLastClicked] = useState<number | null>(null);
  const [creatingUser, setCreatingUser] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [toast, setToast] = useState<Toast>(null);

  function showToast(type: 'success' | 'error', message: string) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3500);
  }

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: fetchUsers,
  });

  const createMutation = useMutation({
    mutationFn: createUser,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setCreatingUser(false);
      showToast('success', 'User created');
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: UserPatch }) => updateUser(id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setEditingUser(null);
      showToast('success', 'User updated');
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: number[]) => deleteUsers(ids),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setSelected(new Set());
      showToast('success', 'Users deleted');
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  function toggleSort(column: string) {
    setSort((prev) =>
      prev?.column === column
        ? { column, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: 'asc' },
    );
  }

  function handleRowClick(id: number, e: React.MouseEvent) {
    if (e.shiftKey && lastClicked !== null) {
      const ordered = sorted.map((u) => u.id);
      const a = ordered.indexOf(lastClicked);
      const b = ordered.indexOf(id);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      setSelected((prev) => {
        const next = new Set(prev);
        ordered.slice(lo, hi + 1).forEach((i) => next.add(i));
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setLastClicked(id);
    }
  }

  function handleDeleteSelected() {
    if (selected.size === 0) return;
    if (!window.confirm(`Delete ${selected.size} user${selected.size > 1 ? 's' : ''}?`)) return;
    bulkDeleteMutation.mutate([...selected]);
  }

  function handleEditSelected() {
    if (selected.size !== 1) return;
    const [id] = [...selected];
    const user = users.find((u) => u.id === id) ?? null;
    setEditingUser(user);
  }

  const sorted = sortRows(users, sort);
  const allSelected = sorted.length > 0 && sorted.every((u) => selected.has(u.id));

  const COLS: { key: string; label: string }[] = [
    { key: 'first_name', label: 'First Name' },
    { key: 'last_name', label: 'Last Name' },
    { key: 'account_name', label: 'Account Name' },
    { key: 'email', label: 'Email Address' },
    { key: 'title', label: 'Title' },
  ];

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Users</h1>
          <p className="text-zinc-400 text-sm mt-1">Manage app users and access.</p>
        </div>
        <div className="flex items-center gap-2">
          {selected.size === 1 && (
            <button
              onClick={handleEditSelected}
              className="flex items-center gap-2 px-3 py-2 bg-zinc-700 hover:bg-zinc-600 text-white text-sm font-medium rounded-lg"
            >
              <Pencil size={14} />
              Edit
            </button>
          )}
          {selected.size > 0 && (
            <button
              onClick={handleDeleteSelected}
              disabled={bulkDeleteMutation.isPending}
              className="flex items-center gap-2 px-3 py-2 bg-red-700 hover:bg-red-600 text-white text-sm font-medium rounded-lg disabled:opacity-50"
            >
              <Trash2 size={14} />
              Delete ({selected.size})
            </button>
          )}
          <button
            onClick={() => setCreatingUser(true)}
            className="flex items-center gap-2 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg"
          >
            <Plus size={14} />
            New User
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center h-48 text-zinc-400">
            <Loader size={20} className="animate-spin mr-2" />
            Loading…
          </div>
        ) : users.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-zinc-500">
            <p className="text-sm">No users yet.</p>
            <button
              onClick={() => setCreatingUser(true)}
              className="mt-3 text-indigo-400 hover:text-indigo-300 text-sm"
            >
              Add the first user
            </button>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800">
                <th className="w-10 px-4 py-3 text-left">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() =>
                      setSelected(
                        allSelected ? new Set() : new Set(sorted.map((u) => u.id)),
                      )
                    }
                    className="accent-indigo-500"
                  />
                </th>
                {COLS.map(({ key, label }) => (
                  <th
                    key={key}
                    onClick={() => toggleSort(key)}
                    className="px-4 py-3 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider cursor-pointer select-none hover:text-white"
                  >
                    <span className="flex items-center gap-1">
                      {label}
                      <SortIcon column={key} sort={sort} />
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((user) => (
                <tr
                  key={user.id}
                  onClick={(e) => handleRowClick(user.id, e)}
                  onDoubleClick={() => setEditingUser(user)}
                  className={`border-b border-zinc-800 last:border-0 cursor-pointer transition-colors ${
                    selected.has(user.id)
                      ? 'bg-indigo-950/40'
                      : 'hover:bg-zinc-800/50'
                  }`}
                >
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(user.id)}
                      onChange={() => {}}
                      className="accent-indigo-500 pointer-events-none"
                    />
                  </td>
                  <td className="px-4 py-3 text-white font-medium">{user.first_name}</td>
                  <td className="px-4 py-3 text-white">{user.last_name}</td>
                  <td className="px-4 py-3 text-zinc-300">{user.account_name ?? '—'}</td>
                  <td className="px-4 py-3 text-zinc-300">{user.email ?? '—'}</td>
                  <td className="px-4 py-3 text-zinc-300">{user.title ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Create modal */}
      {creatingUser && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-lg shadow-2xl">
            <div className="px-6 py-4 border-b border-zinc-700 flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">New User</h2>
              <button
                onClick={() => setCreatingUser(false)}
                className="text-zinc-400 hover:text-white"
              >
                <X size={16} />
              </button>
            </div>
            <UserForm
              onSubmit={(data) => createMutation.mutate(data)}
              onCancel={() => setCreatingUser(false)}
              isLoading={createMutation.isPending}
              submitLabel={createMutation.isPending ? 'Creating…' : 'Create User'}
            />
          </div>
        </div>
      )}

      {/* Edit modal */}
      {editingUser && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-lg shadow-2xl">
            <div className="px-6 py-4 border-b border-zinc-700 flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">
                Edit User
              </h2>
              <button
                onClick={() => setEditingUser(null)}
                className="text-zinc-400 hover:text-white"
              >
                <X size={16} />
              </button>
            </div>
            <UserForm
              defaultValues={{
                first_name: editingUser.first_name,
                last_name: editingUser.last_name,
                account_name: editingUser.account_name ?? '',
                email: editingUser.email ?? undefined,
                title: editingUser.title ?? undefined,
              }}
              onSubmit={(data) =>
                updateMutation.mutate({ id: editingUser.id, patch: data })
              }
              onCancel={() => setEditingUser(null)}
              isLoading={updateMutation.isPending}
              submitLabel={updateMutation.isPending ? 'Saving…' : 'Save Changes'}
            />
          </div>
        </div>
      )}

      <ToastBanner toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
