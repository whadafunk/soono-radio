import { UseFormRegister } from 'react-hook-form';
import { IcecastConfig } from '@soono/shared';
import { HelpTooltip } from '../../../components/HelpTooltip';
import { CollapsibleSection } from '../../../components/CollapsibleSection';

interface Props {
  register: UseFormRegister<IcecastConfig>;
}

export function MountPointsSection({ register }: Props) {
  return (
    <CollapsibleSection
      title="Mount Point"
      helpText="The stream path listeners connect to."
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1 flex items-center">
              Mount Name <span className="text-red-400 ml-0.5">*</span>
              <HelpTooltip text="URL path for the stream, e.g. /stream, /radio, /live. This is used by both listeners (to tune in) and the Mix Engine (to push audio) — changing it requires a Mix Engine restart to take effect." />
            </label>
            <input
              {...register('mount.name')}
              className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white focus:outline-none focus:border-brand-500"
              placeholder="/stream"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1 flex items-center">
              Max Listeners
              <HelpTooltip text="-1 means unlimited. Set a limit based on your bandwidth." />
            </label>
            <input
              {...register('mount.max_listeners', { valueAsNumber: true })}
              type="number"
              className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white focus:outline-none focus:border-brand-500"
              placeholder="-1 (unlimited)"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1 flex items-center">
            Intro Clip
            <HelpTooltip text="Optional audio file played to each listener on connection, before they hear the live stream. Path is relative to Icecast's webroot — e.g. /intro.mp3 maps to the web/ directory inside the container." />
          </label>
          <input
            {...register('mount.intro')}
            className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white focus:outline-none focus:border-brand-500"
            placeholder="(none)"
          />
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
                {...register('mount.stream_name')}
                className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white focus:outline-none focus:border-brand-500"
                placeholder="My Awesome Radio"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1">Description</label>
              <textarea
                {...register('mount.stream_description')}
                rows={2}
                className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white focus:outline-none focus:border-brand-500"
                placeholder="What plays on this stream"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-1">Genre</label>
                <input
                  {...register('mount.genre')}
                  className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white focus:outline-none focus:border-brand-500"
                  placeholder="Various"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-1">Stream URL</label>
                <input
                  {...register('mount.stream_url')}
                  className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white focus:outline-none focus:border-brand-500"
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
                  {...register('mount.type')}
                  className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white focus:outline-none focus:border-brand-500"
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
                  {...register('mount.bitrate', {
                    setValueAs: (v) => (v === '' || v == null ? undefined : Number(v)),
                  })}
                  className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white focus:outline-none focus:border-brand-500"
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
                {...register('mount.public')}
                type="checkbox"
                className="w-4 h-4 rounded bg-zinc-700 border-zinc-600 text-brand-600 focus:ring-brand-500 focus:ring-offset-0"
              />
              List on public Icecast directories (YP)
              <HelpTooltip text="If enabled, this stream is announced to Icecast Yellow Pages directories like dir.xiph.org." />
            </label>
          </div>
        </div>
      </div>
    </CollapsibleSection>
  );
}
