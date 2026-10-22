import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import { MERMAID_SOURCE_MAX } from './document';
import {
  MERMAID_RENDER_LIMIT_MS,
  renderMermaid,
  SUPERSEDED,
  warmMermaid,
} from './Mermaid';

// These tests run without a browser DOM: the page pass (forPage) gets
// linkedom's document and a sanitizer that only parses, since what they check
// is the worker's life, not sanitizing (mermaid-safety.spec.ts covers that).
const { document } = parseHTML('<!doctype html><html><body></body></html>');
vi.mock('dompurify', () => ({
  default: {
    sanitize(svg: string) {
      const template = document.createElement('template');
      template.innerHTML = svg;
      return template.content;
    },
  },
}));

/** A stand-in for the Mermaid worker: keeps what it is sent and answers the
 * latest request when the test says so. */
class FakeWorker {
  static started: FakeWorker[] = [];
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  requests: { id: number }[] = [];
  stopped = false;
  constructor() {
    FakeWorker.started.push(this);
  }
  postMessage(request: { id: number }) {
    this.requests.push(request);
  }
  terminate() {
    this.stopped = true;
  }
  answer(data: object) {
    this.onmessage?.({ data: { id: this.requests.at(-1)?.id, ...data } });
  }
}

afterEach(async () => {
  // The idle timer ends the worker, so the next test starts its own.
  if (vi.isFakeTimers()) await vi.runOnlyPendingTimersAsync();
  FakeWorker.started = [];
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

// Epo 2026-10-22: a render still running 30 s after the worker starts
// drawing it stops, the worker with it, and says the diagram is too large to
// draw on this device. The clock waits while the worker loads mermaid
// (review M1); the refusal is not cached and the next render starts a new
// worker (review L5).
it('stops a render 30 s after the worker starts drawing it', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('document', document);
  const code = 'graph TD\n  slow --> layout';
  const refused = expect(renderMermaid(code)).rejects.toMatchObject({
    reason: 'tooLarge',
  });
  // Still loading mermaid: no clock yet.
  await vi.advanceTimersByTimeAsync(MERMAID_RENDER_LIMIT_MS);
  const [first] = FakeWorker.started;
  first?.answer({ started: true });
  await vi.advanceTimersByTimeAsync(MERMAID_RENDER_LIMIT_MS - 1);
  expect(first?.stopped).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await refused;
  expect(first?.stopped).toBe(true);

  const again = renderMermaid(code);
  await vi.advanceTimersByTimeAsync(0);
  const second = FakeWorker.started[1];
  expect(second).toBeDefined();
  second?.answer({ started: true });
  second?.answer({
    background: '#fff',
    svg: '<svg></svg>',
    type: 'flowchart-v2',
  });
  await expect(again).resolves.toMatchObject({ type: 'flowchart-v2' });
});

// Epo 2026-10-23: a diagram on the page starts the worker at idle; the
// first draw then goes to that worker instead of starting another.
it('draws in the worker the warm-up started', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('document', document);
  warmMermaid();
  warmMermaid();
  expect(FakeWorker.started).toHaveLength(1);
  const drawn = renderMermaid('graph TD\n  warm --> start');
  await vi.advanceTimersByTimeAsync(0);
  const [warm] = FakeWorker.started;
  warm?.answer({ started: true });
  warm?.answer({
    background: '#fff',
    svg: '<svg></svg>',
    type: 'flowchart-v2',
  });
  await drawn;
  expect(FakeWorker.started).toHaveLength(1);
  expect(warm?.requests).toHaveLength(1);
});
