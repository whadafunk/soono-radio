import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader, Trash2, FileLock, AlertCircle, Check, ChevronDown, Wand2, Eye, X } from 'lucide-react';
import {
  fetchCertificates,
  fetchCertificateDetails,
  uploadCertificate,
  deleteCertificate,
  generateCertificate,
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

  const [showGenerator, setShowGenerator] = useState(false);
  const [genCommonName, setGenCommonName] = useState('');
  const [genValidityDays, setGenValidityDays] = useState(365);
  const [genAltNames, setGenAltNames] = useState('');
  const [genFilename, setGenFilename] = useState('');
  const [genCity, setGenCity] = useState('');
  const [genCountry, setGenCountry] = useState('');
  const [viewingCert, setViewingCert] = useState<string | null>(null);

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

  const generateMutation = useMutation({
    mutationFn: generateCertificate,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['certificates'] });
      showToast('success', `Generated ${result.name}`);
      setGenCommonName('');
      setGenAltNames('');
      setGenFilename('');
      setGenCity('');
      setGenCountry('');
      setGenValidityDays(365);
      setShowGenerator(false);
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  const handleGenerate = () => {
    const altNames = genAltNames
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    generateMutation.mutate({
      commonName: genCommonName.trim(),
      validityDays: genValidityDays,
      altNames: altNames.length > 0 ? altNames : undefined,
      filename: genFilename.trim() || undefined,
      city: genCity.trim() || undefined,
      country: genCountry.trim() || undefined,
    });
  };

  const detailsQuery = useQuery({
    queryKey: ['certificate-details', viewingCert],
    queryFn: () => fetchCertificateDetails(viewingCert!),
    enabled: !!viewingCert,
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
            {data?.dir || 'data/certs/'}
          </code>{' '}
          with restrictive permissions.
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pem,.crt,.key"
          onChange={handleFile}
          disabled={uploadMutation.isPending}
          className="block w-full text-sm text-zinc-300 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-brand-600 file:text-white hover:file:bg-brand-700 file:cursor-pointer disabled:opacity-50"
        />
        {uploadMutation.isPending && (
          <p className="text-sm text-zinc-400 mt-3 flex items-center gap-2">
            <Loader className="w-4 h-4 animate-spin" />
            Uploading...
          </p>
        )}
      </section>

      <section className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => setShowGenerator(!showGenerator)}
          className="w-full px-6 py-4 flex items-center justify-between hover:bg-zinc-800 transition-colors"
        >
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Wand2 className="w-5 h-5 text-brand-400" />
            Generate Self-Signed Certificate
          </h2>
          <ChevronDown
            className={`w-5 h-5 text-zinc-400 transition-transform ${showGenerator ? 'rotate-180' : ''}`}
          />
        </button>

        {showGenerator && (
          <div className="border-t border-zinc-800 p-6 space-y-4">
            <p className="text-sm text-zinc-400">
              Useful for development or internal-only deployments. Browsers will show a security
              warning since the cert isn't signed by a public authority.
            </p>

            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1">
                Common Name (CN) <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={genCommonName}
                onChange={(e) => setGenCommonName(e.target.value)}
                placeholder="e.g. localhost or radio.example.com"
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
              />
              <p className="text-xs text-zinc-500 mt-1">
                The primary hostname this certificate is for. Browsers match against this and the alternative names below.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-1">
                  Validity (days)
                </label>
                <input
                  type="number"
                  value={genValidityDays}
                  onChange={(e) => setGenValidityDays(Number(e.target.value) || 365)}
                  min={1}
                  max={36500}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-1">
                  Filename (optional)
                </label>
                <input
                  type="text"
                  value={genFilename}
                  onChange={(e) => setGenFilename(e.target.value)}
                  placeholder="(derived from CN)"
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-1">
                  City (L) <span className="text-zinc-500 text-xs">(optional)</span>
                </label>
                <input
                  type="text"
                  value={genCity}
                  onChange={(e) => setGenCity(e.target.value)}
                  placeholder="e.g. Slobozia"
                  maxLength={64}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-1">
                  Country (C) <span className="text-zinc-500 text-xs">(optional)</span>
                </label>
                <input
                  type="text"
                  value={genCountry}
                  onChange={(e) => setGenCountry(e.target.value.toUpperCase())}
                  placeholder="e.g. RO"
                  maxLength={2}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500 uppercase"
                />
                <p className="text-xs text-zinc-500 mt-1">2-letter ISO 3166 code</p>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1">
                Subject Alternative Names (optional)
              </label>
              <input
                type="text"
                value={genAltNames}
                onChange={(e) => setGenAltNames(e.target.value)}
                placeholder="e.g. *.example.com, 192.168.1.10, localhost"
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
              />
              <p className="text-xs text-zinc-500 mt-1">
                Comma-separated list of additional hostnames or IPs. IPv4 addresses are auto-detected and tagged as IP entries; everything else is treated as a DNS name.
              </p>
            </div>

            <button
              type="button"
              onClick={handleGenerate}
              disabled={!genCommonName.trim() || generateMutation.isPending}
              className="flex items-center gap-2 px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {generateMutation.isPending ? (
                <>
                  <Loader className="w-4 h-4 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Wand2 className="w-4 h-4" />
                  Generate
                </>
              )}
            </button>
          </div>
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
                  <FileLock className="w-5 h-5 text-brand-400 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-white font-mono text-sm truncate">{cert.name}</p>
                    <p className="text-xs text-zinc-500">
                      {formatSize(cert.size)} · uploaded {formatDate(cert.modified)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1 ml-4">
                  <button
                    onClick={() => setViewingCert(cert.name)}
                    className="p-2 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 rounded transition-colors"
                    title="View certificate details"
                  >
                    <Eye className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(cert)}
                    disabled={deleteMutation.isPending}
                    className="p-2 text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded transition-colors disabled:opacity-50"
                    title="Delete certificate"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-white mb-2">Using a Certificate</h2>
        <ol className="text-sm text-zinc-400 space-y-2 list-decimal list-inside">
          <li>Upload or generate a combined PEM file above.</li>
          <li>
            Go to <span className="text-zinc-200 font-medium">Settings → Icecast → Listen Sockets</span>,
            check <span className="text-zinc-200 font-medium">SSL/TLS</span> on a socket (e.g., port 8443).
          </li>
          <li>
            In <span className="text-zinc-200 font-medium">Global Security</span>, pick this certificate
            from the SSL Certificate dropdown.
          </li>
          <li>Save &amp; Restart Icecast.</li>
        </ol>
      </section>

      {viewingCert && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg w-[95vw] h-[95vh] max-w-5xl flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-zinc-800 flex-shrink-0">
              <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                <FileLock className="w-5 h-5 text-brand-400" />
                <span className="font-mono">{viewingCert}</span>
              </h2>
              <button
                onClick={() => setViewingCert(null)}
                className="p-1 text-zinc-400 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-6 min-h-0">
              {detailsQuery.isLoading && (
                <div className="flex items-center gap-2 text-zinc-400">
                  <Loader className="w-4 h-4 animate-spin" />
                  Loading certificate details...
                </div>
              )}
              {detailsQuery.error && (
                <p className="text-red-400 text-sm">
                  Failed to load: {(detailsQuery.error as Error).message}
                </p>
              )}
              {detailsQuery.data && (
                <pre className="bg-zinc-950 border border-zinc-800 rounded p-4 text-xs text-zinc-200 font-mono whitespace-pre overflow-auto">
                  {detailsQuery.data.text}
                </pre>
              )}
            </div>
            <div className="p-6 border-t border-zinc-800 flex-shrink-0">
              <button
                onClick={() => setViewingCert(null)}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white font-medium rounded-lg transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
