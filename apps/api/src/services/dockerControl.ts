/**
 * Restart a container by name via the Docker socket proxy.
 * Throws if DOCKER_PROXY_URL is not set (dev without Compose) or if the
 * proxy returns an error.
 */
export async function restartContainer(name: string): Promise<void> {
  const PROXY_URL = process.env.DOCKER_PROXY_URL ?? 'http://localhost:2375';

  const res = await fetch(`${PROXY_URL}/containers/${encodeURIComponent(name)}/restart`, {
    method: 'POST',
  });

  if (res.status === 204 || res.ok) return;
  if (res.status === 404) throw new Error(`Container "${name}" not found`);
  throw new Error(`Docker proxy returned ${res.status} for container "${name}"`);
}
