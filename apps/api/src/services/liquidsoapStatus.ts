import { LiquidsoapStatus } from '@soono/shared';
import { HarborClient } from './supervisor2/harborClient.js';

export async function fetchLiquidsoapStatus(): Promise<LiquidsoapStatus> {
  try {
    const { connected } = await HarborClient.getLiveStatus();
    return {
      on_air: connected ? 'live' : 'automation',
      current_source: connected ? 'live' : 'automation',
      reachable: true,
    };
  } catch {
    return { on_air: 'none', current_source: null, reachable: false };
  }
}
