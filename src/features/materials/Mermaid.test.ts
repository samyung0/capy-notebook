import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import { MERMAID_SOURCE_MAX } from './document';
import {
  MERMAID_RENDER_LIMIT_MS,
  ownIds,
  renderMermaid,
  SUPERSEDED,
  warmMermaid,
} from './Mermaid';

// These tests run without a browser DOM: the page pass (forPage) gets
// linkedom's document and a sanitizer that only parses, since what they check
// is the worker's life, not sanitizing (mermaid-safety.spec.ts covers that).
const { document, HTMLCanvasElement } = parseHTML(
  '<!doctype html><html><body></body></html>'
);
// genericFaces probes a 2D canvas; linkedom's would load node-canvas, which
// takes seconds on a busy machine, and these tests measure no text.
HTMLCanvasElement.prototype.getContext = () => null;
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

/** The page as a draw needs it, FakeWorker its worker. */
function fakeBrowser() {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('document', document);
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext() {
        return {};
      }
    }
  );
}

/** What the worker answers for a drawn diagram. */
const drawing = (svg = '<svg></svg>') => ({
  background: '#fff',
  svg,
  type: 'flowchart-v2',
});

/** Draws `code` in the latest worker, which answers with `svg`. */
async function drawn(code: string, svg?: string) {
  const render = renderMermaid(code);
  await vi.advanceTimersByTimeAsync(0);
  const current = FakeWorker.started.at(-1);
  current?.answer({ started: true });
  current?.answer(drawing(svg));
  return render;
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
// draw on this device. Loading does not count against it (review M1); the
// refusal is not kept and the next render starts a new worker (review L5).
it('stops a render 30 s after the worker starts drawing it', async () => {
  fakeBrowser();
  const code = 'graph TD\n  slow --> layout';
  const refused = expect(renderMermaid(code)).rejects.toMatchObject({
    reason: 'tooLarge',
  });
  await vi.advanceTimersByTimeAsync(MERMAID_RENDER_LIMIT_MS - 1);
  const [first] = FakeWorker.started;
  first?.answer({ started: true });
  await vi.advanceTimersByTimeAsync(MERMAID_RENDER_LIMIT_MS - 1);
  expect(first?.stopped).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await refused;
  expect(first?.stopped).toBe(true);

  await expect(drawn(code)).resolves.toMatchObject({ type: 'flowchart-v2' });
  expect(FakeWorker.started).toHaveLength(2);
});

// Epo 2026-10-23 (review r2 M1, M2): a worker that has not started drawing
// 30 s after the request, a download that failed in it, or an error escaping
// it says "Diagrams couldn't load."; the worker stops, nothing is kept, and
// the next view draws in a new worker.
it('says a diagram could not load, and draws it the next time', async () => {
  fakeBrowser();
  const code = 'graph TD\n  load --> fails';
  const silent = expect(renderMermaid(code)).rejects.toMatchObject({
    reason: 'notLoaded',
  });
  await vi.advanceTimersByTimeAsync(MERMAID_RENDER_LIMIT_MS);
  await silent;
  expect(FakeWorker.started[0]?.stopped).toBe(true);

  const failedImport = expect(renderMermaid(code)).rejects.toMatchObject({
    reason: 'notLoaded',
  });
  await vi.advanceTimersByTimeAsync(0);
  FakeWorker.started[1]?.answer({ notLoaded: true });
  await failedImport;
  expect(FakeWorker.started[1]?.stopped).toBe(true);

  const escaped = expect(renderMermaid(code)).rejects.toMatchObject({
    reason: 'notLoaded',
  });
  await vi.advanceTimersByTimeAsync(0);
  FakeWorker.started[2]?.answer({ started: true });
  FakeWorker.started[2]?.onerror?.(new Event('error'));
  await escaped;

  await expect(drawn(code)).resolves.toMatchObject({ type: 'flowchart-v2' });
  expect(FakeWorker.started).toHaveLength(4);
});

// Epo 2026-10-23 (review r2 L4): what the source causes (an unsupported type)
// is kept; a browser that cannot start the worker is not. An idle worker ends
// after 60 s (review L2).
it('keeps only failures the source causes', async () => {
  fakeBrowser();
  const unsupported =
    '%%{init: {"flowchart": {"defaultRenderer": "dagre-d3"}}}%%\ngraph TD\n  A --> B';
  const refused = expect(renderMermaid(unsupported)).rejects.toMatchObject({
    reason: 'unsupported',
  });
  await vi.advanceTimersByTimeAsync(0);
  const [first] = FakeWorker.started;
  first?.answer({ unsupported: true });
  await refused;
  await expect(renderMermaid(unsupported)).rejects.toMatchObject({
    reason: 'unsupported',
  });
  expect(first?.requests).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(first?.stopped).toBe(true);

  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        throw new Error('No module workers.');
      }
    }
  );
  const code = 'graph TD\n  no --> worker';
  await expect(renderMermaid(code)).rejects.toMatchObject({
    reason: 'noWorker',
  });
  vi.stubGlobal('Worker', FakeWorker);
  await expect(drawn(code)).resolves.toMatchObject({ type: 'flowchart-v2' });
});

// Review r2 L4: past CACHE_CHARS (8 million characters of SVG) the oldest
// drawing goes; the newest stays.
it('drops the oldest drawing past the cache cap', async () => {
  fakeBrowser();
  const big = `<svg>${'x'.repeat(5_000_000)}</svg>`;
  await drawn('graph TD\n  first', big);
  await drawn('graph TD\n  second', big);
  const [current] = FakeWorker.started;
  await renderMermaid('graph TD\n  second');
  expect(current?.requests).toHaveLength(2);
  await drawn('graph TD\n  first', big);
  expect(current?.requests).toHaveLength(3);
});

// Epo 2026-10-23: a diagram on the page starts the worker at idle; the
// first draw then goes to that worker instead of starting another.
it('draws in the worker the warm-up started', async () => {
  fakeBrowser();
  warmMermaid();
  warmMermaid();
  expect(FakeWorker.started).toHaveLength(1);
  await drawn('graph TD\n  warm --> start');
  expect(FakeWorker.started).toHaveLength(1);
  expect(FakeWorker.started[0]?.requests).toHaveLength(1);
});

// Review L1, r2 L2: every id a drawing defines becomes the copy's own, ids
// from mermaid's per-worker counters (sankey gradients, sequence actors)
// too, with every reference; a link to the page outside the drawing stays.
it('makes every id a drawing defines its copy own', () => {
  const svg =
    '<svg id="mmd-3" aria-labelledby="chart-title-mmd-3"><title id="chart-title-mmd-3">T</title><linearGradient id="linearGradient-1"/><path stroke="url(#linearGradient-1)" marker-end="url(#mmd-3_arrow)"/><g id="actor0"/><use href="#actor0"/><a href="#notes">x</a><g id="mmd-30"/></svg>';
  expect(ownIds(svg, 'mmi-7')).toBe(
    '<svg id="mmi-7" aria-labelledby="chart-title-mmi-7"><title id="chart-title-mmi-7">T</title><linearGradient id="mmi-7-linearGradient-1"/><path stroke="url(#mmi-7-linearGradient-1)" marker-end="url(#mmi-7_arrow)"/><g id="mmi-7-actor0"/><use href="#mmi-7-actor0"/><a href="#notes">x</a><g id="mmi-7-mmd-30"/></svg>'
  );
});
