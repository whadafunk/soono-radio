import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { IcecastConfig, IcecastConfigSchema } from '@radio/shared';
import {
  fetchIcecastConfig,
  updateIcecastConfig,
  saveRawXml,
  restartIcecast,
  fetchCertificates,
} from '../../api';
import { Loader, Check, AlertCircle, Code, Settings2 } from 'lucide-react';
import { RawXmlEditor } from '../../components/RawXmlEditor';
import { BasicSettingsSection } from './icecast-sections/BasicSettingsSection';
import { GlobalSecuritySection } from './icecast-sections/GlobalSecuritySection';
import { ListenSocketsSection } from './icecast-sections/ListenSocketsSection';
import { MountPointsSection } from './icecast-sections/MountPointsSection';
import { LimitsSection } from './icecast-sections/LimitsSection';
import { RelaySection } from './icecast-sections/RelaySection';
import { LoggingSection } from './icecast-sections/LoggingSection';

export function IcecastSettings() {
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [showRawXml, setShowRawXml] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);

  const { data: config, isLoading, error } = useQuery({
    queryKey: ['icecast-config'],
    queryFn: fetchIcecastConfig,
  });

  const { data: certsData } = useQuery({
    queryKey: ['certificates'],
    queryFn: fetchCertificates,
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
        <Loader className="w-8 h-8 animate-spin text-indigo-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 text-red-300">
        <p>Failed to load Icecast settings</p>
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
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className={`flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg transition-colors border ${
              showAdvanced
                ? 'bg-indigo-600/20 border-indigo-600 text-indigo-300'
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

      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-8">
        <BasicSettingsSection register={register} errors={errors} />

        {showAdvanced && <LimitsSection register={register} />}

        <GlobalSecuritySection control={control} register={register} certsData={certsData} />
        <ListenSocketsSection control={control} register={register} />
        <MountPointsSection control={control} register={register} />

        {showAdvanced && <RelaySection control={control} register={register} />}
        {showAdvanced && <LoggingSection register={register} />}

        <div className="flex gap-4">
          <button
            type="submit"
            disabled={mutation.isPending || isRestarting}
            className="flex items-center gap-2 px-6 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
