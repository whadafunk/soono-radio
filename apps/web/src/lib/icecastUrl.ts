import { IcecastConfig } from '@soono/shared';

// The public hostname is reached through a reverse proxy doing SSL offloading —
// Icecast's own listen-socket SSL flags don't correlate with what's externally reachable.
export function getIcecastBaseUrl(config: IcecastConfig): string {
  const port = config.network.listen_sockets[0]?.port ?? 8000;
  return `https://${config.server.hostname}:${port}`;
}
