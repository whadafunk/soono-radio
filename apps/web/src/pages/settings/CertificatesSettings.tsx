import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader, Upload, Trash2, FileLock, AlertCircle, Check } from 'lucide-react';
import {
  fetchCertificates,
  uploadCertificate,
  deleteCertificate,
  CertificateInfo,
} from '../../api';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function CertificatesSettings() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['certificates'],
    queryFn: fetchCertificates,
  });

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  };

  const uploadMutation = useMutation({
    mutationFn: uploadCertificate,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['certificates'] });
      showToast('success', `Uploaded ${result.name}`);
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    onError: (err) => {
      showToast('error', (err as Error).message);
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteCertificate,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['certificates'] });
      showToast('success', 'Certificate deleted');
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadMutation.mutate(file);
  };

  const handleDelete = (cert: CertificateInfo) => {
    if (confirm(`Delete certificate "${cert.name}"? This can't be undone.`)) {
      deleteMutation.mutate(cert.name);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-3xl font-bold text-white">Certificates</h1>
        <p className="text-zinc-400 mt-2">
          Upload TLS certificates for HTTPS streaming. Icecast requires a single PEM file
          containing both the certificate and the private key.
        </p>
      </div>

      {toast && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-lg ${
            toast.type === 'success'
              ? 'bg-green-900/20 border border-green-800 text-green-300'
              : 'bg-red-900/20 border border-red-800 text-red-300'
          }`}
        >
          {toast.type === 'success' ? <Check className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
          <p>{toast.message}</p>
        </div>
      )}

      <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-white mb-2">Upload Certificate</h2>
        <p className="text-sm text-zinc-400 mb-4">
          Combined PEM file (certificate + private key). Stored in{' '}
          <code className="text-zinc-300 bg-zinc-800 px-1.5 py-0.5 rounded text-xs">
            {data?.dir || 'icecast/certs/'}
          </code>{' '}
          with restrictive permissions.
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pem,.crt,.key"
          onChange={handleFile}
          disabled={uploadMutation.isPending}
          className="block w-full text-sm text-zinc-300 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-indigo-600 file:text-white hover:file:bg-indigo-700 file:cursor-pointer disabled:opacity-50"
        />
        {uploadMutation.isPending && (
          <p className="text-sm text-zinc-400 mt-3 flex items-center gap-2">
            <Loader className="w-4 h-4 animate-spin" />
            Uploading...
          </p>
        )}
      </section>

      <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Installed Certificates</h2>

        {isLoading && (
          <div className="flex items-center gap-2 text-zinc-400">
            <Loader className="w-4 h-4 animate-spin" />
            Loading...
          </div>
        )}

        {error && (
          <p className="text-red-400 text-sm">Failed to load certificates: {(error as Error).message}</p>
        )}

        {data && data.certificates.length === 0 && (
          <p className="text-zinc-500 text-sm italic">No certificates uploaded yet.</p>
        )}

        {data && data.certificates.length > 0 && (
          <ul className="space-y-2">
            {data.certificates.map((cert) => (
              <li
                key={cert.name}
                className="flex items-center justify-between bg-zinc-800 rounded-lg px-4 py-3"
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <FileLock className="w-5 h-5 text-indigo-400 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-white font-mono text-sm truncate">{cert.name}</p>
                    <p className="text-xs text-zinc-500">
                      {formatSize(cert.size)} · uploaded {formatDate(cert.modified)}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(cert)}
                  disabled={deleteMutation.isPending}
                  className="ml-4 p-2 text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded transition-colors disabled:opacity-50"
                  title="Delete certificate"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-white mb-2">Using a Certificate</h2>
        <ol className="text-sm text-zinc-400 space-y-2 list-decimal list-inside">
          <li>Upload a combined PEM file above.</li>
          <li>
            Go to the <span className="text-zinc-200 font-medium">Icecast</span> tab → Listen Sockets,
            and check <span className="text-zinc-200 font-medium">SSL/TLS</span> on a socket (e.g., port 8443).
          </li>
          <li>
            Set the certificate path in your Icecast config (the path to your uploaded cert in{' '}
            <code className="text-zinc-300 bg-zinc-800 px-1.5 py-0.5 rounded text-xs">/etc/icecast2/certs/</code>{' '}
            inside the container). UI for this is coming next.
          </li>
          <li>Save & Restart Icecast.</li>
        </ol>
        <p className="text-xs text-zinc-500 mt-4 flex items-start gap-2">
          <Upload className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          For now, certificates are uploaded but not yet wired into the Icecast config from the UI —
          that's the last piece of this phase.
        </p>
      </section>
    </div>
  );
}
