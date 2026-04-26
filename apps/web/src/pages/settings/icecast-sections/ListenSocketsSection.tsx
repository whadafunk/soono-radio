import { Control, UseFormRegister, useFieldArray } from 'react-hook-form';
import { IcecastConfig } from '@radio/shared';
import { Plus, Trash2 } from 'lucide-react';
import { HelpTooltip } from '../../../components/HelpTooltip';
import { CollapsibleSection } from '../../../components/CollapsibleSection';

interface Props {
  control: Control<IcecastConfig>;
  register: UseFormRegister<IcecastConfig>;
}

export function ListenSocketsSection({ control, register }: Props) {
  const { fields, append, remove } = useFieldArray({
    control,
    name: 'network.listen_sockets',
  });

  const addButton = (
    <button
      type="button"
      onClick={() => append({ port: 8000, bind_address: '0.0.0.0' })}
      className="flex items-center gap-2 px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded transition-colors"
    >
      <Plus className="w-4 h-4" />
      Add Socket
    </button>
  );

  return (
    <CollapsibleSection
      title="Listen Sockets"
      helpText="Ports Icecast listens on. Each socket serves everything — listener streams, the web admin (/admin/*), and the webroot — over the same port. To separate admin from streams, put a reverse proxy in front of Icecast. Add multiple sockets to serve HTTP + HTTPS, or to bind to different interfaces."
      headerExtra={addButton}
    >
      <div className="space-y-4">
        {fields.map((field, idx) => (
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
                  <HelpTooltip text="Serve HTTPS on this port. Requires a certificate uploaded on the Certificates page and selected in Global Security." />
                </label>
                <label className="flex items-center gap-2 text-sm text-zinc-300">
                  <input
                    {...register(`network.listen_sockets.${idx}.shoutcast_compat`)}
                    type="checkbox"
                    className="w-4 h-4 rounded bg-zinc-700 border-zinc-600 text-indigo-600 focus:ring-indigo-500 focus:ring-offset-0"
                  />
                  SHOUTcast compatible
                  <HelpTooltip text="Marks this listen-socket so it accepts the legacy SHOUTcast source handshake." />
                </label>
              </div>
              {fields.length > 1 && (
                <button
                  type="button"
                  onClick={() => remove(idx)}
                  className="p-2 text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded transition-colors"
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
