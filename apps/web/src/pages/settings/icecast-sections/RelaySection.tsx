import { Control, UseFormRegister, Controller } from 'react-hook-form';
import { IcecastConfig } from '@soono/shared';
import { PasswordInput } from '../../../components/PasswordInput';
import { CollapsibleSection } from '../../../components/CollapsibleSection';

interface Props {
  control: Control<IcecastConfig>;
  register: UseFormRegister<IcecastConfig>;
}

export function RelaySection({ control, register }: Props) {
  return (
    <CollapsibleSection title="Relay">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2">Relay Password</label>
          <Controller
            name="relay.relay_password"
            control={control}
            render={({ field }) => (
              <PasswordInput value={field.value} onChange={field.onChange} />
            )}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2">Relay Servers</label>
          <textarea
            {...register('relay.relay_servers')}
            rows={3}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500 font-mono text-sm"
            placeholder="server1.example.com:8000&#10;server2.example.com:8000"
          />
          <p className="text-zinc-500 text-xs mt-1">One server per line</p>
        </div>
      </div>
    </CollapsibleSection>
  );
}
