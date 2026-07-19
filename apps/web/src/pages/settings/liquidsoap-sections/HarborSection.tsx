import { Control, UseFormRegister, Controller, FieldErrors, useWatch } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { LiquidsoapConfig } from '@soono/shared';
import { HelpTooltip } from '../../../components/HelpTooltip';
import { PasswordInput } from '../../../components/PasswordInput';
import { CollapsibleSection } from '../../../components/CollapsibleSection';
import { fetchCertificates } from '../../../api';

interface Props {
  control: Control<LiquidsoapConfig>;
  register: UseFormRegister<LiquidsoapConfig>;
  errors: FieldErrors<LiquidsoapConfig>;
}

export function HarborSection({ control, register, errors }: Props) {
  const harborEnabled = useWatch({ control, name: 'harbor.enabled' }) ?? false;
  const tlsEnabled = useWatch({ control, name: 'harbor.tls.enabled' }) ?? false;
  const { data: certsData } = useQuery({
    queryKey: ['certificates'],
    queryFn: fetchCertificates,
    enabled: tlsEnabled,
  });

  return (
    <CollapsibleSection title="Live Input (Harbor)">
      <div className="space-y-4">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            {...register('harbor.enabled')}
            className="w-4 h-4 rounded border-zinc-700 bg-zinc-800 text-brand-600 focus:ring-brand-500"
          />
          <span className="text-sm font-medium text-zinc-200">Accept live broadcasts</span>
          <HelpTooltip text="When enabled, broadcasters (e.g., BUTT) can connect directly to the Mix Engine's harbor. What happens next depends on Live Input Mode below." />
        </label>

        {harborEnabled && (
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
              Live Input Mode
              <HelpTooltip text="Take Over: automation is fully silent while a live source is connected (today's default behavior). Mix with Segment Audio: both play simultaneously, automation ducked under the live source — see Ducking below." />
            </label>
            <select
              {...register('harbor.live_mode')}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
            >
              <option value="takeover">Take Over</option>
              <option value="mix">Mix with Segment Audio</option>
            </select>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
              Harbor Port
              <HelpTooltip text="TCP port broadcasters connect to. Default 8005. Must not collide with the Streaming Engine (8000)." />
            </label>
            <input
              type="number"
              {...register('harbor.port', { valueAsNumber: true })}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
              Mount Name
              <HelpTooltip text="The mount name broadcasters point at. Just the name (no leading slash) — e.g., 'live'." />
            </label>
            <input
              {...register('harbor.mount_name')}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
              placeholder="live"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
            Harbor Password
            <HelpTooltip text="Password broadcasters use to authenticate against the Mix Engine's harbor. Independent from the Streaming Engine's source password." />
          </label>
          <Controller
            name="harbor.password"
            control={control}
            render={({ field }) => (
              <PasswordInput value={field.value} onChange={field.onChange} />
            )}
          />
          {errors.harbor?.password && (
            <p className="text-red-400 text-xs mt-1">{errors.harbor.password.message}</p>
          )}
        </div>

        <div className="pt-4 border-t border-zinc-800 space-y-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              {...register('harbor.tls.enabled')}
              className="w-4 h-4 rounded border-zinc-700 bg-zinc-800 text-brand-600 focus:ring-brand-500"
            />
            <span className="text-sm font-medium text-zinc-200">Encrypt harbor with TLS</span>
            <HelpTooltip text="When the DJ broadcasts from over the internet, encrypt the audio in transit. Needs a certificate uploaded to the Certificates page." />
          </label>

          {tlsEnabled && (
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                Certificate
                <HelpTooltip text="PEM file containing both the certificate and the private key. Uploaded via the Certificates page." />
              </label>
              <Controller
                name="harbor.tls.certificate_path"
                control={control}
                render={({ field }) => {
                  const currentName = field.value ? field.value.split('/').pop() || '' : '';
                  return (
                    <select
                      value={currentName}
                      onChange={(e) =>
                        field.onChange(
                          e.target.value ? `/etc/liquidsoap/certs/${e.target.value}` : null,
                        )
                      }
                      className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
                    >
                      <option value="">— None (TLS will fail to start) —</option>
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
                  No certificates uploaded yet. Upload one from the Certificates page in the sidebar.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </CollapsibleSection>
  );
}
