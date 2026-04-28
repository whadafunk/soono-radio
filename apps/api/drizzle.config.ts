import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    // Local file used only by drizzle-kit for diffing/inspection.
    // Runtime path lives in src/db/index.ts (data/radio.db at repo root).
    url: 'file:../../data/radio.db',
  },
} satisfies Config;
