import { afterEach, expect, it, vi } from 'vitest';
import { MERMAID_SOURCE_MAX } from './document';
import { MERMAID_RENDER_LIMIT_MS, renderMermaid, SUPERSEDED } from './Mermaid';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// REVIEW4 S2: a queued render whose source changed again before its turn
// does not run (it used to run and drop its result), so a live source draws
// only its latest text.
it('skips a render that is no longer wanted when its turn comes', async () => {
  let wanted = true;
  const render = renderMermaid('graph TD\n  A --> B', undefined, {
    wanted: () => wanted,
  });
  wanted = false;
  await expect(render).rejects.toBe(SUPERSEDED);
});

// A source past the catalog's cap is refused before any render (Epo
// 2026-10-22), with its own message.
it('refuses a source over MERMAID_SOURCE_MAX without drawing it', async () => {
  await expect(
    renderMermaid(`graph TD\n${'A'.repeat(MERMAID_SOURCE_MAX)}`)
  ).rejects.toMatchObject({ reason: 'tooLong' });
});

// Epo 2026-10-22: a render still running after 30 s stops, the worker with
// it, and says the diagram is too large to draw on this device.
it('stops a render still running at the time limit', async () => {
  vi.useFakeTimers();
  const stopped: unknown[] = [];
  vi.stubGlobal(
    'Worker',
    class {
      onerror = null;
      onmessage = null;
      postMessage() {
        // Never answers: mermaid is still laying the diagram out.
      }
      terminate() {
        stopped.push(this);
      }
    }
  );
  const render = renderMermaid('graph TD\n  slow --> layout');
  const refused = expect(render).rejects.toMatchObject({ reason: 'tooLarge' });
  await vi.advanceTimersByTimeAsync(MERMAID_RENDER_LIMIT_MS - 1);
  expect(stopped).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  await refused;
  expect(stopped).toHaveLength(1);
});
