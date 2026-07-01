import { create } from 'zustand';

export interface ActiveUpload {
  uid: string;
  filename: string;
  size: number;
  loaded: number;
  status: 'uploading' | 'queued' | 'failed';
  error?: string;
  jobId?: string;
}

interface UploadStore {
  active: ActiveUpload[];
  batchJobIds: Set<string>;
  setActive: (updater: ActiveUpload[] | ((prev: ActiveUpload[]) => ActiveUpload[])) => void;
  setBatchJobIds: (ids: Set<string>) => void;
}

// Lives outside any page component so in-flight/queued uploads (and the
// current batch's progress-bar scope) survive navigating away from the
// Upload tab and back — the upload request itself already keeps running in
// the background regardless, but the local tracking state used to reset to
// empty on remount since it was plain component state.
export const useUploadStore = create<UploadStore>((set) => ({
  active: [],
  batchJobIds: new Set(),
  setActive: (updater) =>
    set((state) => ({
      active: typeof updater === 'function' ? updater(state.active) : updater,
    })),
  setBatchJobIds: (ids) => set({ batchJobIds: ids }),
}));
