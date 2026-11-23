import type { HeartbeatClock } from '../../../src/features/collaboration/heartbeat';
import { HEARTBEAT_MS } from '../../../src/features/collaboration/protocol';

/** A Node peer's heartbeat clock (`CollabSocket.create`): a plain interval,
 * as Node has no worker and no hidden-page timer throttling to escape. A run
 * against UAT through cloudflared then sees only the closes a browser would. */
export const nodeHeartbeat: HeartbeatClock = (onBeat) => {
  const timer = setInterval(onBeat, HEARTBEAT_MS);
  return () => clearInterval(timer);
};
