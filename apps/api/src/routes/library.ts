import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { createWriteStream } from 'fs';
import { rename, stat, unlink } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { basename, join } from 'path';
import { db } from '../db/index.js';
import { ingestJobs, MEDIA_CATEGORIES } from '../db/schema.js';
import type { MediaCategory } from '../db/schema.js';
import { ensureDirs, STAGING_DIR, stagingPathFor } from '../services/ingest/paths.js';
import { ingestQueue } from '../services/ingest/queue.js';

function newJobId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function isMediaCategory(value: string): value is MediaCategory {
  return (MEDIA_CATEGORIES as readonly string[]).includes(value);
}

interface UploadedJob {
  job_id: string;
  filename: string;
  size_bytes: number;
}

export async function libraryRoutes(fastify: FastifyInstance) {
  fastify.post('/library/upload', async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.status(400).send({ error: 'multipart/form-data required' });
    }

    await ensureDirs();

    let category: MediaCategory | null = null;
    const created: UploadedJob[] = [];
    // Track temp files written before category arrives so we can rename them
    // once we have it (or unlink on failure).
    const pending: Array<{ tempPath: string; filename: string; size: number }> = [];

    try {
      for await (const part of request.parts()) {
        if (part.type === 'field') {
          if (part.fieldname === 'category' && typeof part.value === 'string') {
            if (!isMediaCategory(part.value)) {
              return reply.status(400).send({
                error: `Invalid category. Must be one of: ${MEDIA_CATEGORIES.join(', ')}`,
              });
            }
            category = part.value;
          }
          continue;
        }

        // It's a file part. Stream it to a temp filename inside STAGING_DIR.
        const tempName = `pending-${newJobId()}`;
        const tempPath = join(STAGING_DIR, tempName);
        const filename = basename(part.filename || tempName);

        await pipeline(part.file, createWriteStream(tempPath));

        if (part.file.truncated) {
          await safeUnlink(tempPath);
          return reply.status(413).send({
            error: `File ${filename} exceeded the size limit`,
          });
        }

        const fileStat = await stat(tempPath);
        pending.push({ tempPath, filename, size: fileStat.size });
      }

      if (!category) {
        // Wipe staged files; we won't be able to use them without a category.
        await Promise.all(pending.map((p) => safeUnlink(p.tempPath)));
        return reply.status(400).send({ error: 'category field is required' });
      }

      if (pending.length === 0) {
        return reply.status(400).send({ error: 'No files uploaded' });
      }

      // Rename each temp file to its final staging path under the new job id,
      // then insert the ingest_jobs row.
      for (const p of pending) {
        const jobId = newJobId();
        const finalPath = stagingPathFor(jobId);
        await rename(p.tempPath, finalPath);

        await db.insert(ingestJobs).values({
          id: jobId,
          status: 'queued',
          uploaded_filename: p.filename,
          uploaded_size_bytes: p.size,
          staging_path: finalPath,
          category,
        });

        created.push({ job_id: jobId, filename: p.filename, size_bytes: p.size });
      }

      // Wake the worker. It picks up jobs serially; this is fire-and-forget.
      ingestQueue.signal();

      return reply.status(202).send({ jobs: created });
    } catch (err) {
      // Best-effort cleanup of any temp files we wrote before the throw.
      await Promise.all(pending.map((p) => safeUnlink(p.tempPath)));
      throw err;
    }
  });

  fastify.get<{ Params: { id: string } }>('/library/ingest/:id', async (request, reply) => {
    const { id } = request.params;
    const rows = await db.select().from(ingestJobs).where(eq(ingestJobs.id, id)).limit(1);
    const row = rows[0];
    if (!row) {
      return reply.status(404).send({ error: 'Ingest job not found' });
    }
    return reply.send(row);
  });

  fastify.get('/library/ingest', async (_request, reply) => {
    // Return the most-recent jobs (cap to keep responses bounded).
    const rows = await db
      .select()
      .from(ingestJobs)
      .orderBy(ingestJobs.created_at)
      .limit(200);
    // Reverse so newest comes first without a separate desc() in case
    // we want to keep this query simple.
    return reply.send({ jobs: rows.reverse() });
  });
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}
