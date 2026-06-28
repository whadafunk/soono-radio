import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { IcecastConfig, IcecastConfigSchema } from '@soono/shared';
import {
  fetchIcecastConfig,
  updateIcecastConfig,
  saveRawXml,
  restartIcecast,
  fetchCertificates,
} from '../../api';
import { Loader, Check, AlertCircle, Code, Settings2, ExternalLink } from 'lucide-react';
import { RawXmlEditor } from '../../components/RawXmlEditor';
import { BasicSettingsSection } from './icecast-sections/BasicSettingsSection';
import { GlobalSecuritySection } from './icecast-sections/GlobalSecuritySection';
import { ListenSocketsSection } from './icecast-sections/ListenSocketsSection';
import { MountPointsSection } from './icecast-sections/MountPointsSection';
import { LimitsSection } from './icecast-sections/LimitsSection';
import { RelaySection } from './icecast-sections/RelaySection';
import { LoggingSection } from './icecast-sections/LoggingSection';

function collectErrorPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  const paths: string[] = [];
  for (const [key, val] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (val && typeof val === 'object' && 'message' in val) {
      paths.push(path);
    } else if (val && typeof val === 'object') {
      paths.push(...collectErrorPaths(val as Record<string, unknown>, path));
    }
  }
  return paths;
}

function getIcecastBaseUrl(config: IcecastConfig): string {
  const nonSslSocket = config.network.listen_sockets.find((s) => !s.ssl);
  const port = nonSslSocket?.port ?? config.network.listen_sockets[0]?.port ?? 8000;
  return `http://${config.server.hostname}:${port}`;
}

export function IcecastSettings() {
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [showRawXml, setShowRawXml] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);

  const { data: config, isLoading, error } = useQuery({
    queryKey: ['icecast-config'],
    queryFn: fetchIcecastConfig,
    staleTime: 60_000,
  });

  const { data: certsData } = useQuery({
    queryKey: ['certificates'],
    queryFn: fetchCertificates,
    staleTime: 60_000,
  });

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
    reset,
  } = useForm<IcecastConfig>({
    resolver: zodResolver(IcecastConfigSchema),
    values: config,
  });

  const mutation = useMutation({
    mutationFn: async (data: IcecastConfig) => {
      await updateIcecastConfig(data);
      setIsRestarting(true);
      setToast({ type: 'success', message: 'Settings saved. Restarting Icecast...' });
      const result = await restartIcecast();
      setIsRestarting(false);
      setToast({
        type: 'success',
        message: `✓ Icecast restarted successfully! Uptime: ${result.uptime}s`,
      });
      setTimeout(() => setToast(null), 5000);
    },
    onError: (err) => {
      setIsRestarting(false);
      setToast({ type: 'error', message: `✗ Error: ${(err as Error).message}` });
      setTimeout(() => setToast(null), 5000);
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader className="w-8 h-8 animate-spin text-brand-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 text-red-300 space-y-1">
        <p className="font-medium">Failed to load Icecast settings</p>
        <p className="text-sm text-red-400">{(error as Error).message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-white">Streaming Engine</h1>
          <p className="text-zinc-400 mt-2">Icecast — distributes the audio to listeners</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {config && (
            <>
              <a
                href={`${getIcecastBaseUrl(config)}/status.xsl`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-3 py-2 text-sm font-medium bg-zinc-900 border border-zinc-800 text-zinc-300 hover:bg-zinc-800 rounded-lg transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                Status
              </a>
              <a
                href={`${getIcecastBaseUrl(config)}/admin/stats.xsl`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-3 py-2 text-sm font-medium bg-zinc-900 border border-zinc-800 text-zinc-300 hover:bg-zinc-800 rounded-lg transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                Admin
              </a>
            </>
          )}
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className={`flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg transition-colors border ${
              showAdvanced
                ? 'bg-brand-600/20 border-brand-600 text-brand-300'
                : 'bg-zinc-900 border-zinc-800 text-zinc-300 hover:bg-zinc-800'
            }`}
          >
            <Settings2 className="w-4 h-4" />
            Advanced
          </button>
          <button
            type="button"
            onClick={() => setShowRawXml(true)}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium bg-zinc-900 border border-zinc-800 text-zinc-300 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <Code className="w-4 h-4" />
            Raw XML
          </button>
        </div>
      </div>

      {toast && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-lg ${
            toast.type === 'success'
              ? 'bg-green-900/20 border border-green-800 text-green-300'
              : 'bg-red-900/20 border border-red-800 text-red-300'
          }`}
        >
          {toast.type === 'success' ? (
            <Check className="w-5 h-5" />
          ) : (
            <AlertCircle className="w-5 h-5" />
          )}
          <p>{toast.message}</p>
        </div>
      )}

      <form
        onSubmit={handleSubmit(
          (data) => mutation.mutate(data),
          (formErrors) => {
            const paths = collectErrorPaths(formErrors).join(', ');
            setToast({ type: 'error', message: `Validation failed — check these fields: ${paths}` });
          },
        )}
        className="space-y-8"
      >
        <BasicSettingsSection register={register} errors={errors} />

        {showAdvanced && <LimitsSection register={register} />}

        <GlobalSecuritySection control={control} register={register} certsData={certsData} />
        <ListenSocketsSection control={control} register={register} />
        <MountPointsSection register={register} />

        {showAdvanced && <RelaySection control={control} register={register} />}
        {showAdvanced && <LoggingSection register={register} />}

        <div className="flex gap-4">
          <button
            type="submit"
            disabled={mutation.isPending || isRestarting}
            className="flex items-center gap-2 px-6 py-2 bg-zinc-700 hover:bg-zinc-600 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {mutation.isPending || isRestarting ? (
              <>
                <Loader className="w-4 h-4 animate-spin" />
                {isRestarting ? 'Restarting...' : 'Saving...'}
              </>
            ) : (
              'Save & Restart'
            )}
          </button>
          <button
            type="button"
            onClick={() => reset()}
            disabled={mutation.isPending || isRestarting}
            className="px-6 py-2 bg-zinc-800 hover:bg-zinc-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Reset
          </button>
        </div>
      </form>

      <RawXmlEditor
        isOpen={showRawXml}
        onClose={() => setShowRawXml(false)}
        onSave={async (xml) => {
          await saveRawXml(xml);
          const newConfig = await fetchIcecastConfig();
          reset(newConfig);
        }}
      />
    </div>
  );
}
