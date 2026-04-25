import { useQuery, useMutation } from '@tanstack/react-query';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { IcecastConfig, IcecastConfigSchema } from '@radio/shared';
import { fetchIcecastConfig, updateIcecastConfig, saveRawXml, restartIcecast, fetchCertificates } from '../../api';
import { Loader, Check, AlertCircle, Plus, Trash2, ChevronDown } from 'lucide-react';
import { HelpTooltip } from '../../components/HelpTooltip';
import { RawXmlEditor } from '../../components/RawXmlEditor';
import { PasswordInput } from '../../components/PasswordInput';
import { useState } from 'react';

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

  const { register, handleSubmit, control, formState: { errors }, reset } = useForm<IcecastConfig>({
    resolver: zodResolver(IcecastConfigSchema),
    values: config,
  });

  const { fields: mountFields, append, remove } = useFieldArray({
    control,
    name: 'mounts',
  });

  const {
    fields: socketFields,
    append: appendSocket,
    remove: removeSocket,
  } = useFieldArray({
    control,
    name: 'network.listen_sockets',
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
        message: `✓ Icecast restarted successfully! Uptime: ${result.uptime}s`
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
      <div>
        <h1 className="text-3xl font-bold text-white">Icecast Settings</h1>
        <p className="text-zinc-400 mt-2">Configure your streaming server</p>
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
        {/* Basic Settings */}
        <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-white mb-4">Basic Settings</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                Hostname
                <HelpTooltip text="The domain or IP address where listeners connect. Used for YP directory and stream information." />
              </label>
              <input
                {...register('server.hostname')}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
                placeholder="radio.example.com"
              />
              {errors.server?.hostname && <p className="text-red-400 text-xs mt-1">{errors.server.hostname.message}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                Location
                <HelpTooltip text="Geographic location of your server. Published in stream metadata and YP directory." />
              </label>
              <input
                {...register('server.location')}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
                placeholder="New York, USA"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                Admin Email
                <HelpTooltip text="Contact email for server notifications and administrative purposes." />
              </label>
              <input
                {...register('server.admin')}
                type="email"
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
              />
              {errors.server?.admin && <p className="text-red-400 text-xs mt-1">{errors.server.admin.message}</p>}
            </div>
          </div>
        </section>

        {/* Listen Sockets */}
        <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white flex items-center">
              Listen Sockets
              <HelpTooltip text="Ports Icecast listens on. Add multiple to serve HTTP and HTTPS, or to bind to different interfaces." />
            </h2>
            <button
              type="button"
              onClick={() => appendSocket({ port: 8000, bind_address: '0.0.0.0' })}
              className="flex items-center gap-2 px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add Socket
            </button>
          </div>
          <div className="space-y-4">
            {socketFields.map((field, idx) => (
              <div key={field.id} className="bg-zinc-800 rounded-lg p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-zinc-300 mb-1 flex items-center">
                        Port
                        <HelpTooltip text="TCP port to listen on. Defaults: 8000 HTTP, 8443 HTTPS." />
                      </label>
                      <input
                        {...register(`network.listen_sockets.${idx}.port`, { valueAsNumber: true })}
                        type="number"
                        className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-zinc-300 mb-1 flex items-center">
                        Bind Address
                        <HelpTooltip text="0.0.0.0 listens on all interfaces. Auto-detection of host IPs is coming later." />
                      </label>
                      <select
                        {...register(`network.listen_sockets.${idx}.bind_address`)}
                        className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white focus:outline-none focus:border-indigo-500"
                      >
                        <option value="0.0.0.0">0.0.0.0 (all interfaces)</option>
                      </select>
                    </div>
                    <label className="flex items-center gap-2 text-sm text-zinc-300">
                      <input
                        {...register(`network.listen_sockets.${idx}.ssl`)}
                        type="checkbox"
                        className="w-4 h-4 rounded bg-zinc-700 border-zinc-600 text-indigo-600 focus:ring-indigo-500 focus:ring-offset-0"
                      />
                      SSL/TLS (HTTPS)
                      <HelpTooltip text="Serve HTTPS on this port. Requires a certificate configured in the Certificates tab." />
                    </label>
                    <label className="flex items-center gap-2 text-sm text-zinc-300">
                      <input
                        {...register(`network.listen_sockets.${idx}.shoutcast_compat`)}
                        type="checkbox"
                        className="w-4 h-4 rounded bg-zinc-700 border-zinc-600 text-indigo-600 focus:ring-indigo-500 focus:ring-offset-0"
                      />
                      SHOUTcast compatible
                      <HelpTooltip text="Accept SHOUTcast clients on this port. Older broadcasters connect on port + 1 for sources." />
                    </label>
                  </div>
                  {socketFields.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeSocket(idx)}
                      className="p-2 text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded transition-colors"
                    >
                      <Trash2 className="w-5 h-5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* SSL Certificate */}
        <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center">
            SSL Certificate
            <HelpTooltip text="Pick an uploaded certificate to use for SSL listen sockets. Manage certificates in the Certificates tab." />
          </h2>
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-2">Certificate</label>
            <Controller
              name="ssl.certificate_path"
              control={control}
              render={({ field }) => {
                const currentName = field.value
                  ? field.value.split('/').pop() || ''
                  : '';
                return (
                  <select
                    value={currentName}
                    onChange={(e) => {
                      const name = e.target.value;
                      field.onChange(name ? `/etc/icecast2/certs/${name}` : null);
                    }}
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">— None (SSL sockets will fail) —</option>
                    {certsData?.certificates.map((cert) => (
                      <option key={cert.name} value={cert.name}>
                        {cert.name}
                      </option>
                    ))}
                  </select>
                );
              }}
            />
            {certsData && certsData.certificates.length === 0 && (
              <p className="text-xs text-zinc-500 mt-2">
                No certificates uploaded yet. Go to the Certificates tab to upload one.
              </p>
            )}
            <p className="text-xs text-zinc-500 mt-2">
              The selected file's container path is written to{' '}
              <code className="bg-zinc-800 px-1.5 py-0.5 rounded text-xs">&lt;ssl-certificate&gt;</code>{' '}
              in the Icecast config.
            </p>
          </div>
        </section>

        {/* Mount Points */}
        <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white flex items-center">
              Mount Points
              <HelpTooltip text="Stream paths that broadcasters connect to. Each mount can have its own password and listener limit." />
            </h2>
            <button
              type="button"
              onClick={() => append({ name: '/new', max_listeners: -1, public: false })}
              className="flex items-center gap-2 px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add Mount
            </button>
          </div>
          <div className="space-y-6">
            {mountFields.map((field, idx) => (
              <div key={field.id} className="bg-zinc-800 rounded-lg p-4 space-y-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1 space-y-3">
                    <div>
                      <label className="block text-sm font-medium text-zinc-300 mb-1 flex items-center">
                        Mount Name
                        <HelpTooltip text="URL path for this stream, e.g., /stream, /dj-alice, /mobile" />
                      </label>
                      <input
                        {...register(`mounts.${idx}.name`)}
                        className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white focus:outline-none focus:border-indigo-500"
                        placeholder="/stream"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-zinc-300 mb-1 flex items-center">
                          Max Listeners
                          <HelpTooltip text="-1 means unlimited. Set a limit based on your bandwidth." />
                        </label>
                        <input
                          {...register(`mounts.${idx}.max_listeners`, { valueAsNumber: true })}
                          type="number"
                          className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white focus:outline-none focus:border-indigo-500"
                          placeholder="-1 (unlimited)"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-zinc-300 mb-1 flex items-center">
                          Source Password
                          <HelpTooltip text="Optional. If set, broadcasters must use this password to stream to this mount (overrides the global source password)." />
                        </label>
                        <Controller
                          name={`mounts.${idx}.password`}
                          control={control}
                          render={({ field }) => (
                            <PasswordInput
                              value={field.value || ''}
                              onChange={field.onChange}
                              className="bg-zinc-700 border-zinc-600"
                              placeholder="(uses global password)"
                            />
                          )}
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-zinc-300 mb-1 flex items-center">
                          Fallback Mount
                          <HelpTooltip text="If this mount is unavailable, redirect listeners to this fallback mount." />
                        </label>
                        <input
                          {...register(`mounts.${idx}.fallback_mount`)}
                          className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white focus:outline-none focus:border-indigo-500"
                          placeholder="(optional)"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-zinc-300 mb-1 flex items-center">
                          SHOUTcast Mount Alias
                          <HelpTooltip text="Alias for SHOUTcast clients. Lets older SHOUTcast broadcasters connect on the SHOUTcast source port and route to this mount." />
                        </label>
                        <input
                          {...register(`mounts.${idx}.shoutcast_mount`)}
                          className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white focus:outline-none focus:border-indigo-500"
                          placeholder="(optional)"
                        />
                      </div>
                    </div>

                    <div className="pt-3 border-t border-zinc-700">
                      <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center">
                        Public Metadata
                        <HelpTooltip text="Stream info shown to listeners and YP directories. All optional." />
                      </h3>
                      <div className="space-y-3">
                        <div>
                          <label className="block text-sm font-medium text-zinc-300 mb-1">Stream Name</label>
                          <input
                            {...register(`mounts.${idx}.stream_name`)}
                            className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white focus:outline-none focus:border-indigo-500"
                            placeholder="My Awesome Radio"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-zinc-300 mb-1">Description</label>
                          <textarea
                            {...register(`mounts.${idx}.stream_description`)}
                            rows={2}
                            className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white focus:outline-none focus:border-indigo-500"
                            placeholder="What plays on this stream"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-sm font-medium text-zinc-300 mb-1">Genre</label>
                            <input
                              {...register(`mounts.${idx}.genre`)}
                              className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white focus:outline-none focus:border-indigo-500"
                              placeholder="Various"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-zinc-300 mb-1">Stream URL</label>
                            <input
                              {...register(`mounts.${idx}.stream_url`)}
                              className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white focus:outline-none focus:border-indigo-500"
                              placeholder="https://your-station.example.com"
                            />
                          </div>
                        </div>
                        <div className="grid grid-cols-3 gap-3">
                          <div>
                            <label className="block text-sm font-medium text-zinc-300 mb-1 flex items-center">
                              Bitrate
                              <HelpTooltip text="Stream bitrate in kbps. Hint for listeners; doesn't enforce." />
                            </label>
                            <input
                              {...register(`mounts.${idx}.bitrate`, { valueAsNumber: true, setValueAs: (v) => (v === '' || isNaN(v) ? undefined : Number(v)) })}
                              type="number"
                              className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white focus:outline-none focus:border-indigo-500"
                              placeholder="128"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-zinc-300 mb-1 flex items-center">
                              Type
                              <HelpTooltip text="Content type, e.g., audio/mpeg, application/ogg" />
                            </label>
                            <input
                              {...register(`mounts.${idx}.type`)}
                              className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white focus:outline-none focus:border-indigo-500"
                              placeholder="audio/mpeg"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-zinc-300 mb-1 flex items-center">
                              Subtype
                              <HelpTooltip text="Codec subtype, e.g., mp3, ogg" />
                            </label>
                            <input
                              {...register(`mounts.${idx}.subtype`)}
                              className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white focus:outline-none focus:border-indigo-500"
                              placeholder="mp3"
                            />
                          </div>
                        </div>
                        <label className="flex items-center gap-2 text-sm text-zinc-300">
                          <input
                            {...register(`mounts.${idx}.public`)}
                            type="checkbox"
                            className="w-4 h-4 rounded bg-zinc-700 border-zinc-600 text-indigo-600 focus:ring-indigo-500 focus:ring-offset-0"
                          />
                          List on public Icecast directories (YP)
                          <HelpTooltip text="If enabled, this stream is announced to Icecast Yellow Pages directories like dir.xiph.org." />
                        </label>
                      </div>
                    </div>
                  </div>
                  {mountFields.length > 1 && (
                    <button
                      type="button"
                      onClick={() => remove(idx)}
                      className="ml-4 p-2 text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded transition-colors"
                    >
                      <Trash2 className="w-5 h-5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Authentication */}
        <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-white mb-4">Authentication</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                Source Password
                <HelpTooltip text="Password broadcasters (e.g., BUTT client) use to stream audio to Icecast. This is the authentication for source connections." />
              </label>
              <Controller
                name="authentication.source_password"
                control={control}
                render={({ field }) => (
                  <PasswordInput
                    value={field.value}
                    onChange={field.onChange}
                  />
                )}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                  Admin Username
                  <HelpTooltip text="Username for accessing the Icecast web admin panel." />
                </label>
                <input
                  {...register('authentication.admin_user')}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                  Admin Password
                  <HelpTooltip text="Password for accessing the Icecast web admin panel." />
                </label>
                <Controller
                  name="authentication.admin_password"
                  control={control}
                  render={({ field }) => (
                    <PasswordInput
                      value={field.value}
                      onChange={field.onChange}
                    />
                  )}
                />
              </div>
            </div>
          </div>
        </section>

        {/* Limits */}
        <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-white mb-4">Limits</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                Max Sources
                <HelpTooltip text="Maximum number of broadcasters that can stream simultaneously. Set to 1-2 for solo shows, higher for multi-host setups." />
              </label>
              <input
                {...register('limits.max_sources', { valueAsNumber: true })}
                type="number"
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                Max Clients
                <HelpTooltip text="Maximum number of listeners across all mounts. Depends on your bandwidth." />
              </label>
              <input
                {...register('limits.max_clients', { valueAsNumber: true })}
                type="number"
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                Queue Size (bytes)
                <HelpTooltip text="Audio buffer size. Increase if experiencing audio dropouts, decrease to reduce memory usage." />
              </label>
              <input
                {...register('limits.max_queue_size', { valueAsNumber: true })}
                type="number"
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                Burst Size (bytes)
                <HelpTooltip text="Initial burst of data sent to new listeners for faster startup." />
              </label>
              <input
                {...register('limits.burst_size', { valueAsNumber: true })}
                type="number"
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>
        </section>

        {/* Relay */}
        <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-white mb-4">Relay</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-2">Relay Password</label>
              <Controller
                name="relay.relay_password"
                control={control}
                render={({ field }) => (
                  <PasswordInput
                    value={field.value}
                    onChange={field.onChange}
                  />
                )}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-2">Relay Servers</label>
              <textarea
                {...register('relay.relay_servers')}
                rows={3}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500 font-mono text-sm"
                placeholder="server1.example.com:8000&#10;server2.example.com:8000"
              />
              <p className="text-zinc-500 text-xs mt-1">One server per line</p>
            </div>
          </div>
        </section>

        {/* Logging */}
        <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-white mb-4">Logging</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-2">Log Level</label>
              <select
                {...register('logging.loglevel')}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
              >
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-2">Log Size (bytes, optional)</label>
              <input
                {...register('logging.logsize', { valueAsNumber: true })}
                type="number"
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
                placeholder="Leave empty for no limit"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-2">Access Log Path</label>
              <input
                {...register('logging.access_log')}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500 opacity-75 cursor-not-allowed"
                disabled
              />
              <p className="text-zinc-500 text-xs mt-1">Display only</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-2">Error Log Path</label>
              <input
                {...register('logging.error_log')}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500 opacity-75 cursor-not-allowed"
                disabled
              />
              <p className="text-zinc-500 text-xs mt-1">Display only</p>
            </div>
          </div>
        </section>

        {/* Advanced Section */}
        <section className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="w-full px-6 py-4 flex items-center justify-between hover:bg-zinc-800 transition-colors"
          >
            <h2 className="text-lg font-semibold text-white">Advanced</h2>
            <ChevronDown
              className={`w-5 h-5 text-zinc-400 transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
            />
          </button>

          {showAdvanced && (
            <div className="border-t border-zinc-800 p-6 space-y-4">
              <p className="text-sm text-zinc-400">
                Edit the raw Icecast XML configuration file directly. Use this for advanced configuration options not covered by the form above.
              </p>
              <button
                type="button"
                onClick={() => setShowRawXml(true)}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors"
              >
                Edit Raw XML
              </button>
            </div>
          )}
        </section>

        {/* Submit Button */}
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

      {/* Raw XML Editor Modal */}
      <RawXmlEditor
        isOpen={showRawXml}
        onClose={() => setShowRawXml(false)}
        onSave={async (xml) => {
          await saveRawXml(xml);
          // Refresh the config
          const newConfig = await fetchIcecastConfig();
          reset(newConfig);
        }}
      />
    </div>
  );
}
