import { z } from 'zod';

export const IntegrationsConfigSchema = z.object({
  acoustid_api_key: z.string().default(''),
  acoustid_min_score: z.number().min(0).max(1).default(0.65),
  acoustid_min_gap: z.number().min(0).max(1).default(0.10),
  audio_analysis_enabled: z.boolean().default(true),
});
export type IntegrationsConfig = z.infer<typeof IntegrationsConfigSchema>;
