import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { join } from 'path';
import * as schema from './schema.js';

const DB_PATH =
  process.env.RADIO_DB_PATH || join(process.cwd(), '..', '..', 'data', 'radio.db');

const MIGRATIONS_FOLDER =
  process.env.RADIO_DB_MIGRATIONS ||
  join(process.cwd(), 'drizzle');

const client = createClient({ url: `file:${DB_PATH}` });

export const db = drizzle(client, { schema });

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

export { schema };
