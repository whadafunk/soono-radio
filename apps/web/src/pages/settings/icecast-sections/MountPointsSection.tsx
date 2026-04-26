import { Control, UseFormRegister, Controller, useFieldArray } from 'react-hook-form';
import { IcecastConfig } from '@radio/shared';
import { Plus, Trash2 } from 'lucide-react';
import { HelpTooltip } from '../../../components/HelpTooltip';
import { PasswordInput } from '../../../components/PasswordInput';
import { CollapsibleSection } from '../../../components/CollapsibleSection';

interface Props {
  control: Control<IcecastConfig>;
  register: UseFormRegister<IcecastConfig>;
}

export function MountPointsSection({ control, register }: Props) {
  const { fields, append, remove } = useFieldArray({
    control,
    name: 'mounts',
  });

  const addButton = (
    <button
      type="button"
      onClick={() => append({ name: '/new', max_listeners: -1, public: false })}
      className="flex items-center gap-2 px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded transition-colors"
    >
      <Plus className="w-4 h-4" />
      Add Mount
    </button>
  );

  return (
    <CollapsibleSection
      title="Mount Points"
      helpText="Stream paths that broadcasters connect to. Each mount can have its own password and listener limit."
      headerExtra={addButton}
    >
      <div className="space-y-6">
        {fields.map((field, idx) => (
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
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-zinc-300 mb-1 flex items-center">
                          Type
                          <HelpTooltip text="Content-type announced to listeners. Leave (none) to skip the metadata; players will still work, they just won't know the codec until they read the stream." />
                        </label>
                        <select
                          {...register(`mounts.${idx}.type`)}
                          className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white focus:outline-none focus:border-indigo-500"
                        >
                          <option value="">(none)</option>
                          <option value="audio/mpeg">audio/mpeg (MP3)</option>
                          <option value="audio/aac">audio/aac</option>
                          <option value="audio/aacp">audio/aacp (AAC+)</option>
                          <option value="application/ogg">application/ogg</option>
                          <option value="audio/ogg">audio/ogg</option>
                          <option value="audio/opus">audio/opus</option>
                          <option value="audio/flac">audio/flac</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-zinc-300 mb-1 flex items-center">
                          Bitrate
                          <HelpTooltip text="Stream bitrate in kbps. Pure metadata for listeners — doesn't enforce anything." />
                        </label>
                        <select
                          {...register(`mounts.${idx}.bitrate`, {
                            setValueAs: (v) => (v === '' || v == null ? undefined : Number(v)),
                          })}
                          className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white focus:outline-none focus:border-indigo-500"
                        >
                          <option value="">(none)</option>
                          <option value="32">32 kbps</option>
                          <option value="64">64 kbps</option>
                          <option value="96">96 kbps</option>
                          <option value="128">128 kbps</option>
                          <option value="160">160 kbps</option>
                          <option value="192">192 kbps</option>
                          <option value="256">256 kbps</option>
                          <option value="320">320 kbps</option>
                        </select>
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
              {fields.length > 1 && (
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
    </CollapsibleSection>
  );
}
