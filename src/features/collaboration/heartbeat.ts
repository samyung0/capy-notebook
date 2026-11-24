import { captureException } from '@sentry/react';
import { HEARTBEAT_MS } from './protocol';

/** A heartbeat clock: calls `onBeat` on each beat until the returned stop.
 * The app's is `onHeartbeat`; a Node load generator passes its own
 * (`CollabSocket.create`). */
export type HeartbeatClock = (onBeat: () => void) => () => void;

/**
 * The tab's heartbeat clock (protocol 41): every open collaboration socket
 * sends `HEARTBEAT` on each tick (`CollabSocket`). The ticks come from a
 * dedicated worker's timer, not the page's: Chrome runs the timers of a page
 * hidden for 5 minutes once a minute (intensive wake-up throttling), right at
 * the server's 60 s silent window, and a hidden tab that keeps its socket
 * (unsent edits, an Office or text file open) is the one with a group to
 * lose; the worker's message is no page timer. The worker is an inline
 * blob, not a built file, so a tab whose first socket opens after a deploy
 * changed the bundle's hashes still starts it. One worker for the tab,
 * started by the first socket to open and stopped once none is open. A
 * worker that cannot start or fails is reported, once a page, and no tick
 * comes: nothing stands in for it.
 */
const CLOCK = `postMessage('ready'); setInterval(() => postMessage(null), ${HEARTBEAT_MS});`;
const listeners = new Set<() => void>();
/** The running worker, and its blob's URL until the worker started. */
let clock: { source: string | null; worker: Worker } | null = null;
let failed = false;

/** Stops the worker and lets its blob's URL go. */
function stop() {
  if (clock?.source) URL.revokeObjectURL(clock.source);
  clock?.worker.terminate();
  clock = null;
}

function fail(error: unknown) {
  failed = true;
  stop();
  console.error('The collaboration heartbeat stopped:', error);
  captureException(error, { tags: { component: 'collaboration-heartbeat' } });
}

function start() {
  const source = URL.createObjectURL(
    new Blob([CLOCK], { type: 'text/javascript' })
  );
  let worker: Worker;
  try {
    worker = new Worker(source, { name: 'heartbeat' });
  } catch (error) {
    URL.revokeObjectURL(source);
    fail(error);
    return;
  }
  const started = { source: source as string | null, worker };
  clock = started;
  worker.onmessage = ({ data }: MessageEvent<'ready' | null>) => {
    if (data !== 'ready') {
      for (const listener of [...listeners]) listener();
      return;
    }
    if (started.source) URL.revokeObjectURL(started.source);
    started.source = null;
  };
  // A load failure is a plain event, with no message.
  worker.onerror = (event) => {
    event.preventDefault();
    fail(
      new Error(
        `The heartbeat worker failed: ${event.message || 'it did not load or start'}`
      )
    );
  };
}

/** The tab's heartbeat clock. */
export const onHeartbeat: HeartbeatClock = (onBeat) => {
  listeners.add(onBeat);
  if (!(clock || failed)) start();
  return () => {
    listeners.delete(onBeat);
    if (listeners.size === 0) stop();
  };
};
