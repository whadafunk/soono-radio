const PROXY_URL = process.env.DOCKER_PROXY_URL;

/**
 * Restart a container by name via the Docker socket proxy.
 * Throws if DOCKER_PROXY_URL is not set (dev without Compose) or if the
 * proxy returns an error.
 */
export async function restartContainer(name: string): Promise<void> {
  if (!PROXY_URL) {
    throw new Error(
      'DOCKER_PROXY_URL is not configured — restart the container manually with: docker compose restart ' + name,
    );
  }

  const res = await fetch(`${PROXY_URL}/containers/${encodeURIComponent(name)}/restart`, {
    method: 'POST',
  });

  if (res.status === 204 || res.ok) return;
  if (res.status === 404) throw new Error(`Container "${name}" not found`);
  throw new Error(`Docker proxy returned ${res.status} for container "${name}"`);
}
