import { FastifyInstance } from 'fastify';
import { readdir, readFile, writeFile, unlink, mkdir, stat } from 'fs/promises';
import { join, basename } from 'path';

const CERTS_DIR =
  process.env.ICECAST_CERTS_DIR ||
  join(process.cwd(), '..', '..', 'icecast', 'certs');

const PEM_CERT_RE = /-----BEGIN CERTIFICATE-----/;
const PEM_KEY_RE = /-----BEGIN (RSA |EC |ENCRYPTED |)PRIVATE KEY-----/;

async function ensureCertsDir() {
  try {
    await mkdir(CERTS_DIR, { recursive: true });
  } catch {
    // directory exists
  }
}

function safeFilename(name: string): string {
  // Strip path separators and parent refs; only allow [A-Za-z0-9._-]
  const cleaned = basename(name).replace(/[^A-Za-z0-9._-]/g, '_');
  if (!cleaned || cleaned.startsWith('.')) {
    throw new Error('Invalid filename');
  }
  return cleaned;
}

export async function certificateRoutes(fastify: FastifyInstance) {
  fastify.get('/certificates', async (_request, reply) => {
    await ensureCertsDir();
    const entries = await readdir(CERTS_DIR);
    const certs = await Promise.all(
      entries
        .filter((name) => name.endsWith('.pem'))
        .map(async (name) => {
          const path = join(CERTS_DIR, name);
          const stats = await stat(path);
          return {
            name,
            size: stats.size,
            modified: stats.mtime.toISOString(),
          };
        }),
    );
    return reply.send({ certificates: certs, dir: CERTS_DIR });
  });

  fastify.post('/certificates/upload', async (request, reply) => {
    await ensureCertsDir();

    const file = await request.file();
    if (!file) {
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    const buf = await file.toBuffer();
    const content = buf.toString('utf-8');

    if (!PEM_CERT_RE.test(content)) {
      return reply
        .status(400)
        .send({ error: 'File does not contain a PEM certificate block' });
    }
    if (!PEM_KEY_RE.test(content)) {
      return reply.status(400).send({
        error: 'File does not contain a PEM private key block. Icecast needs a combined cert+key PEM.',
      });
    }

    const filename = safeFilename(file.filename || 'server.pem');
    const finalName = filename.endsWith('.pem') ? filename : `${filename}.pem`;
    const targetPath = join(CERTS_DIR, finalName);

    // Write with restrictive permissions (private key inside)
    await writeFile(targetPath, content, { encoding: 'utf-8', mode: 0o600 });

    return reply.send({ success: true, name: finalName });
  });

  fastify.delete<{ Params: { name: string } }>(
    '/certificates/:name',
    async (request, reply) => {
      const name = safeFilename(request.params.name);
      try {
        await unlink(join(CERTS_DIR, name));
        return reply.send({ success: true });
      } catch (err) {
        return reply
          .status(404)
          .send({ error: `Certificate not found: ${(err as Error).message}` });
      }
    },
  );

  fastify.get<{ Params: { name: string } }>(
    '/certificates/:name/info',
    async (request, reply) => {
      const name = safeFilename(request.params.name);
      try {
        const path = join(CERTS_DIR, name);
        const stats = await stat(path);
        const content = await readFile(path, 'utf-8');
        const hasCert = PEM_CERT_RE.test(content);
        const hasKey = PEM_KEY_RE.test(content);
        return reply.send({
          name,
          path,
          size: stats.size,
          modified: stats.mtime.toISOString(),
          has_certificate: hasCert,
          has_private_key: hasKey,
        });
      } catch {
        return reply.status(404).send({ error: 'Certificate not found' });
      }
    },
  );
}
