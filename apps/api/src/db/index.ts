import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { join } from 'path';
import { fileURLToPath } from 'url';
import * as schema from './schema.js';

const DB_PATH =
  process.env.RADIO_DB_PATH || join(process.cwd(), '..', '..', 'data', 'radio.db');

// Resolve relative to this file so the path is correct whether running from
// src/ (tsx dev) or dist/ (compiled production) — both are two levels below
// the api root where the drizzle/ folder lives.
const MIGRATIONS_FOLDER =
  process.env.RADIO_DB_MIGRATIONS ||
  fileURLToPath(new URL('../../drizzle', import.meta.url));

const client = createClient({ url: `file:${DB_PATH}` });

export const db = drizzle(client, { schema });

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

export { schema };
