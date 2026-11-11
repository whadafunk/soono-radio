export const LIQUIDSOAP_CONTAINER = 'soono-liquidsoap';

type ContainerAction = 'restart' | 'stop' | 'start';

/**
 * Run a lifecycle action on a container by name via the Docker socket proxy.
 * Throws if the proxy is unreachable (dev without the proxy running) or
 * returns an error. 304 means the container is already in the requested
 * state (stopping a stopped container, starting a running one) — success.
 */
async function containerAction(name: string, action: ContainerAction): Promise<void> {
  const PROXY_URL = process.env.DOCKER_PROXY_URL ?? 'http://localhost:2375';

  const res = await fetch(`${PROXY_URL}/containers/${encodeURIComponent(name)}/${action}`, {
    method: 'POST',
    // `docker stop` waits out the container's grace period before replying.
    signal: AbortSignal.timeout(30_000),
  });

  if (res.status === 204 || res.status === 304 || res.ok) return;
  if (res.status === 404) throw new Error(`Container "${name}" not found`);
  throw new Error(`Docker proxy returned ${res.status} for ${action} of container "${name}"`);
}

export function restartContainer(name: string): Promise<void> {
  return containerAction(name, 'restart');
}

export function stopContainer(name: string): Promise<void> {
  return containerAction(name, 'stop');
}

export function startContainer(name: string): Promise<void> {
  return containerAction(name, 'start');
}
