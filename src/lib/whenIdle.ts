/** Runs `run` once the browser is idle, and at the latest after `timeout` ms
 * (also the wait where there is no requestIdleCallback: Safari). For boot
 * work that should not compete with the first page's chunks (Q908). */
export function whenIdle(run: () => void, timeout = 2000) {
  if (typeof requestIdleCallback === 'function')
    requestIdleCallback(run, { timeout });
  else setTimeout(run, timeout);
}
