import { Control, UseFormRegister, Controller } from 'react-hook-form';
import { IcecastConfig } from '@radio/shared';
import { HelpTooltip } from '../../../components/HelpTooltip';
import { PasswordInput } from '../../../components/PasswordInput';
import { CollapsibleSection } from '../../../components/CollapsibleSection';
import { CertificateInfo } from '../../../api';

interface Props {
  control: Control<IcecastConfig>;
  register: UseFormRegister<IcecastConfig>;
  certsData: { certificates: CertificateInfo[] } | undefined;
}

export function GlobalSecuritySection({ control, register, certsData }: Props) {
  return (
    <CollapsibleSection title="Global Security">
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
              <PasswordInput value={field.value} onChange={field.onChange} />
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
                <PasswordInput value={field.value} onChange={field.onChange} />
              )}
            />
          </div>
        </div>

        <div className="pt-4 border-t border-zinc-800">
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
            SSL Certificate
            <HelpTooltip text="Pick an uploaded certificate to use for SSL listen sockets. Manage certificates in the Certificates page (sidebar)." />
          </label>
          <Controller
            name="ssl.certificate_path"
            control={control}
            render={({ field }) => {
              const currentName = field.value ? field.value.split('/').pop() || '' : '';
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
              No certificates uploaded yet. Go to the Certificates page (sidebar) to upload one.
            </p>
          )}
        </div>
      </div>
    </CollapsibleSection>
  );
}
