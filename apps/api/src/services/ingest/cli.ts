/**
 * CLI driver for the ingest pipeline. Lets us exercise Phase 2 without an
 * HTTP layer. Usage:
 *
 *   pnpm --filter @soono/api exec tsx src/services/ingest/cli.ts <file> --category music
 *
 * Copies the input file to data/incoming/<jobId>, creates an ingest_jobs
 * row, runs the worker synchronously, and prints the outcome.
 */
import { copyFile, stat } from 'fs/promises';
import { basename } from 'path';
import { db, runMigrations } from '../../db/index.js';
import { ingestJobs, MEDIA_CATEGORIES } from '../../db/schema.js';
import type { MediaCategory } from '../../db/schema.js';
import { runIngestJob } from './worker.js';
import { ensureDirs, stagingPathFor } from './paths.js';
import { eq } from 'drizzle-orm';
import { media } from '../../db/schema.js';

function newJobId(): string {
  // Lightweight ULID-ish: epoch millis (base36) + random. Good enough for
  // file names and FK purposes; we don't need lexicographic sortability
  // beyond "newer is bigger".
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help')) {
    console.log('Usage: cli.ts <file> [--category <music|jingle|ad|intro|promo|voice|bed|recording>]');
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const inputPath = argv[0];
  const categoryArg = argv.includes('--category') ? argv[argv.indexOf('--category') + 1] : 'music';
  if (!MEDIA_CATEGORIES.includes(categoryArg as MediaCategory)) {
    console.error(`Invalid category: ${categoryArg}. Must be one of: ${MEDIA_CATEGORIES.join(', ')}`);
    process.exit(2);
  }
  const category = categoryArg as MediaCategory;

  const fileStat = await stat(inputPath);

  await runMigrations();
  await ensureDirs();

  const jobId = newJobId();
  const stagingPath = stagingPathFor(jobId);
  await copyFile(inputPath, stagingPath);

  await db.insert(ingestJobs).values({
    id: jobId,
    status: 'queued',
    uploaded_filename: basename(inputPath),
    uploaded_size_bytes: fileStat.size,
    staging_path: stagingPath,
    category,
  });

  console.log(`[ingest] job ${jobId} queued for ${basename(inputPath)} (${fileStat.size} bytes, category=${category})`);

  const outcome = await runIngestJob(jobId);
  console.log(`[ingest] outcome:`, outcome);

  if (outcome.status === 'completed' && outcome.mediaId !== null) {
    const rows = await db.select().from(media).where(eq(media.id, outcome.mediaId)).limit(1);
    const row = rows[0];
    if (row) {
      console.log('[ingest] media row:');
      console.log(JSON.stringify(row, null, 2));
    }
  }

  process.exit(outcome.status === 'completed' ? 0 : 1);
}

main().catch((err) => {
  console.error('[ingest] fatal:', err);
  process.exit(1);
});
