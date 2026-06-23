import { FastifyInstance } from 'fastify';
import { readdir, readFile, writeFile, unlink, mkdir, mkdtemp, rm, stat } from 'fs/promises';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

const CERTS_DIR =
  process.env.RADIO_CERTS_DIR ||
  process.env.ICECAST_CERTS_DIR || // legacy env name; kept for backwards compat
  join(process.cwd(), '..', '..', 'data', 'certs');

const PEM_CERT_RE = /-----BEGIN CERTIFICATE-----/;
const PEM_KEY_RE = /-----BEGIN (RSA |EC |ENCRYPTED |)PRIVATE KEY-----/;

async function extractCN(filePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('openssl', ['x509', '-noout', '-subject', '-in', filePath]);
    const match = stdout.match(/CN\s*=\s*([^,\/\r\n]+)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

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
          const cn = await extractCN(path);
          return {
            name,
            cn,
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

  fastify.post<{
    Body: {
      commonName?: string;
      validityDays?: number;
      altNames?: string[];
      filename?: string;
      city?: string;
      country?: string;
    };
  }>('/certificates/generate', async (request, reply) => {
    await ensureCertsDir();

    const { commonName, validityDays = 365, altNames, filename, city, country } = request.body || {};

    if (!commonName || typeof commonName !== 'string' || !commonName.trim()) {
      return reply.status(400).send({ error: 'commonName is required' });
    }
    const cn = commonName.trim();
    if (cn.length > 253 || /[\r\n\0\/=]/.test(cn)) {
      return reply.status(400).send({ error: 'commonName is invalid (cannot contain / or =)' });
    }

    let sanitizedCity: string | undefined;
    if (city !== undefined && city !== null) {
      if (typeof city !== 'string') {
        return reply.status(400).send({ error: 'city must be a string' });
      }
      const c = city.trim();
      if (c.length > 64 || /[\r\n\0\/=]/.test(c)) {
        return reply.status(400).send({ error: 'city is invalid (max 64 chars, no / or =)' });
      }
      if (c) sanitizedCity = c;
    }

    let sanitizedCountry: string | undefined;
    if (country !== undefined && country !== null) {
      if (typeof country !== 'string') {
        return reply.status(400).send({ error: 'country must be a string' });
      }
      const co = country.trim().toUpperCase();
      if (co && !/^[A-Z]{2}$/.test(co)) {
        return reply.status(400).send({ error: 'country must be a 2-letter ISO 3166 code' });
      }
      if (co) sanitizedCountry = co;
    }
    if (
      typeof validityDays !== 'number' ||
      !Number.isInteger(validityDays) ||
      validityDays < 1 ||
      validityDays > 36500
    ) {
      return reply
        .status(400)
        .send({ error: 'validityDays must be an integer between 1 and 36500' });
    }
    if (altNames !== undefined && !Array.isArray(altNames)) {
      return reply.status(400).send({ error: 'altNames must be an array of strings' });
    }
    const sanitizedAltNames: string[] = [];
    if (Array.isArray(altNames)) {
      for (const an of altNames) {
        if (typeof an !== 'string' || !an.trim()) continue;
        const t = an.trim();
        if (t.length > 253 || /[\r\n\0,]/.test(t)) {
          return reply.status(400).send({ error: `altName invalid: ${t}` });
        }
        sanitizedAltNames.push(t);
      }
    }

    // Derive filename from CN if not supplied
    const baseName = (filename && filename.trim()) || cn;
    const cleaned = safeFilename(baseName);
    const finalName = cleaned.endsWith('.pem') ? cleaned : `${cleaned}.pem`;
    const targetPath = join(CERTS_DIR, finalName);

    const tmp = await mkdtemp(join(tmpdir(), 'radio-cert-'));
    try {
      const keyPath = join(tmp, 'key.pem');
      const certPath = join(tmp, 'cert.pem');

      let subj = '';
      if (sanitizedCountry) subj += `/C=${sanitizedCountry}`;
      if (sanitizedCity) subj += `/L=${sanitizedCity}`;
      subj += `/CN=${cn}`;

      const args = [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        String(validityDays),
        '-nodes',
        '-subj',
        subj,
      ];

      if (sanitizedAltNames.length > 0) {
        const sans = sanitizedAltNames
          .map((a) => (/^\d{1,3}(\.\d{1,3}){3}$/.test(a) ? `IP:${a}` : `DNS:${a}`))
          .join(',');
        args.push('-addext', `subjectAltName=${sans}`);
      }

      try {
        await execFile('openssl', args);
      } catch (err) {
        return reply
          .status(500)
          .send({ error: `openssl failed: ${(err as Error).message}` });
      }

      const cert = await readFile(certPath, 'utf-8');
      const key = await readFile(keyPath, 'utf-8');
      const combined = cert.endsWith('\n') ? cert + key : cert + '\n' + key;

      await writeFile(targetPath, combined, { encoding: 'utf-8', mode: 0o600 });

      return reply.send({ success: true, name: finalName });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  fastify.post<{
    Body: { certificate?: string; chain?: string; key?: string; filename?: string };
  }>('/certificates/assemble', async (request, reply) => {
    await ensureCertsDir();
    const { certificate, chain, key, filename } = request.body || {};

    if (!certificate || !PEM_CERT_RE.test(certificate)) {
      return reply.status(400).send({ error: 'certificate must contain a PEM certificate block' });
    }
    if (!key || !PEM_KEY_RE.test(key)) {
      return reply.status(400).send({ error: 'key must contain a PEM private key block' });
    }
    if (chain && !PEM_CERT_RE.test(chain)) {
      return reply.status(400).send({ error: 'chain must contain PEM certificate block(s)' });
    }

    const parts = [certificate.trim()];
    if (chain && chain.trim()) parts.push(chain.trim());
    parts.push(key.trim());
    const combined = parts.join('\n') + '\n';

    let baseName = filename?.trim();
    if (!baseName) {
      const tmp = await mkdtemp(join(tmpdir(), 'radio-cert-'));
      try {
        const tmpCert = join(tmp, 'cert.pem');
        await writeFile(tmpCert, certificate, 'utf-8');
        baseName = (await extractCN(tmpCert)) || 'server';
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    }

    const cleaned = safeFilename(baseName);
    const finalName = cleaned.endsWith('.pem') ? cleaned : `${cleaned}.pem`;
    await writeFile(join(CERTS_DIR, finalName), combined, { encoding: 'utf-8', mode: 0o600 });
    return reply.send({ success: true, name: finalName });
  });

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

        let text = '';
        try {
          const { stdout } = await execFile('openssl', [
            'x509',
            '-in',
            path,
            '-noout',
            '-text',
          ]);
          text = stdout;
        } catch (err) {
          text = `(unable to parse certificate: ${(err as Error).message})`;
        }

        return reply.send({
          name,
          path,
          size: stats.size,
          modified: stats.mtime.toISOString(),
          has_certificate: hasCert,
          has_private_key: hasKey,
          text,
        });
      } catch {
        return reply.status(404).send({ error: 'Certificate not found' });
      }
    },
  );
}
