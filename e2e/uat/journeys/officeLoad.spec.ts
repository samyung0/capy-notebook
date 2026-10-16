/* biome-ignore-all lint/suspicious/noMisplacedAssertion: The readiness wait executes only inside this test. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { runDirectory } from './evidence';
import {
  fileRow,
  openFile,
  string,
  upload,
  whenReady,
  workspace,
} from './files';
import { type OfficeFormat, officeMenu, officeMenuLabels } from './office';
import { type Actor, expect, test, type UatRun } from './runtime';

/**
 * Office open times on UAT, results only: the journey asserts that each open
 * reaches the editor, never how fast (README, "Office load measurement").
 * Small files show the fixed cost of an open (frame, WASM, fonts, grant and
 * room) with almost no document work. Large: the Office bench's large DOCX
 * and XLSX and its small PPTX (bench/editor/scripts/runtime.office.ts), so the
 * numbers compare with its local medians; its large PPTX (24 MB) is over the
 * Free plan's 10 MiB file cap.
 */
const FILES: [OfficeFormat, 'small' | 'large', string][] = [
  ['docx', 'small', 'e2e/fixtures/files/basic/lesson.docx'],
  ['xlsx', 'small', 'e2e/fixtures/files/basic/grades.xlsx'],
  ['pptx', 'small', 'e2e/fixtures/files/basic/lesson.pptx'],
  ['docx', 'large', 'bench/editor/fixtures/office/long-handbook.docx'],
  ['xlsx', 'large', 'bench/editor/fixtures/office/large-gradebook.xlsx'],
  ['pptx', 'large', 'e2e/fixtures/files/rich-content/lecture.pptx'],
];

/** Per open, from navigation to the Edit menu. */
const OPEN_TIMEOUT = 240_000;

/** Milestones in dependency order: a failed open is stuck at the first one missing. */
const STAGES = [
  'htmlReceived',
  'spaReady',
  'runtimeInitialized',
  'collaborationGrant',
  'roomSynced',
  'firstPagePainted',
  'replicaReady',
  'editable',
] as const;

/** What no signal shows without a product hook (README). */
const UNAVAILABLE = {
  crossOriginSizes:
    'Sizes and cache state of cross-origin responses without Timing-Allow-Origin (API, B2 source bytes, Clerk): only start and end. Needs Timing-Allow-Origin on those responses.',
  documentFontsReady:
    "document.fonts.ready: the runtime loads each face from bytes before adding it, so the frame's FontFaceSet reports no loading; fontsAdded (the last face added) stands in.",
  workerWasmCompile:
    "WASM compile and instantiate inside a worker: Playwright cannot run a script in a worker before the worker's own. Needs performance.mark around the engine's WASM init, which the test can read from the worker's timeline.",
};

type MeasuredFile = {
  blobPath: string;
  bytes: number;
  format: OfficeFormat;
  id: string;
  name: string;
  size: 'small' | 'large';
};

/** What the init script records, on its frame's clock (performance.now()). */
type Probe = {
  /** App page: when each runtime message type first arrived. */
  runtime: Record<string, number>;
  /** The runtime's own `ready` timings (OfficeReadyTimings). */
  readyTimings?: { loadMs: number; paintMs: number };
  runtimeErrors: string[];
  sockets: {
    url: string;
    created: number;
    open?: number;
    firstMessage?: number;
  }[];
  /** The header's `data-save-state` values, in order. */
  saveStates: { state: string; at: number }[];
  /** When the Office header's Edit menu appeared. */
  editable?: number;
  /** Runtime frame: when each host message type first arrived. */
  host: Record<string, number>;
  capabilities: { canEdit: boolean; at: number }[];
  wasm: {
    call: string;
    url?: string;
    start: number;
    end?: number;
    failed?: boolean;
  }[];
  /** `document.fonts.add` calls and FontFaceSet `loadingdone` events. */
  fontsAdded: number[];
  fontsLoadingDone: number[];
};

/**
 * Runs in every frame before its own scripts (context.addInitScript). The app
 * page records runtime messages, its collaboration sockets, the header's save
 * states and when the Edit menu appeared; the runtime frame records host
 * messages, WASM compiles and the fonts it adds. Instrumentation only.
 */
function installProbe(labels: { bar: string; item: string }) {
  const now = () => performance.now();
  const probe: Probe = {
    capabilities: [],
    fontsAdded: [],
    fontsLoadingDone: [],
    host: {},
    runtime: {},
    runtimeErrors: [],
    saveStates: [],
    sockets: [],
    wasm: [],
  };
  Object.assign(globalThis, { __officeLoad: probe });
  performance.setResourceTimingBufferSize(10_000);
  if (window.top === window) {
    window.addEventListener('message', (event) => {
      const data = event.data as {
        type?: unknown;
        version?: unknown;
        timings?: Probe['readyTimings'];
        message?: unknown;
      } | null;
      if (typeof data?.type !== 'string' || data.version === undefined) return;
      probe.runtime[data.type] ??= now();
      if (data.type === 'ready') probe.readyTimings ??= data.timings;
      if (data.type === 'error' && typeof data.message === 'string')
        probe.runtimeErrors.push(data.message.slice(0, 200));
    });
    window.WebSocket = new Proxy(WebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget) as WebSocket;
        const entry: Probe['sockets'][number] = {
          created: now(),
          url: String(args[0]).split('?')[0],
        };
        probe.sockets.push(entry);
        socket.addEventListener(
          'open',
          () => {
            entry.open = now();
          },
          { once: true }
        );
        socket.addEventListener(
          'message',
          () => {
            entry.firstMessage = now();
          },
          { once: true }
        );
        return socket;
      },
    });
    new MutationObserver(() => {
      const state = document
        .querySelector('[data-testid="editor-save-state"]')
        ?.getAttribute('data-save-state');
      if (state && state !== probe.saveStates.at(-1)?.state)
        probe.saveStates.push({ at: now(), state });
      // The menu bar comes from the runtime's `menus` message.
      if (probe.editable !== undefined || probe.runtime.menus === undefined)
        return;
      const bar = Array.from(
        document.querySelectorAll('[role="menubar"]')
      ).find((element) => element.getAttribute('aria-label') === labels.bar);
      if (
        bar &&
        Array.from(bar.querySelectorAll('[role="menuitem"]')).some(
          (item) => item.textContent?.trim() === labels.item
        )
      )
        probe.editable = now();
    }).observe(document, {
      attributeFilter: ['data-save-state'],
      attributes: true,
      childList: true,
      subtree: true,
    });
    return;
  }
  // Another frame: only the Office runtime gets these from its parent.
  window.addEventListener('message', (event) => {
    const data = event.data as { type?: unknown; canEdit?: unknown } | null;
    if (event.source !== window.parent || typeof data?.type !== 'string')
      return;
    probe.host[data.type] ??= now();
    if (data.type === 'set-capabilities')
      probe.capabilities.push({ at: now(), canEdit: data.canEdit === true });
  });
  const record = <T>(
    call: string,
    source: Response | PromiseLike<Response> | undefined,
    start: () => Promise<T>
  ) => {
    const entry: Probe['wasm'][number] = { call, start: now() };
    probe.wasm.push(entry);
    if (source)
      Promise.resolve(source).then(
        (response) => {
          entry.url = response.url.split('?')[0];
        },
        () => {}
      );
    const result = start();
    result.then(
      () => {
        entry.end = now();
      },
      () => {
        entry.failed = true;
      }
    );
    return result;
  };
  const { compile, compileStreaming, instantiate, instantiateStreaming } =
    WebAssembly;
  WebAssembly.compile = (bytes) =>
    record('compile', undefined, () => compile(bytes));
  WebAssembly.compileStreaming = (source) =>
    record('compileStreaming', source, () => compileStreaming(source));
  WebAssembly.instantiateStreaming = (source, imports) =>
    record('instantiateStreaming', source, () =>
      instantiateStreaming(source, imports)
    );
  WebAssembly.instantiate = ((...args: Parameters<typeof instantiate>) =>
    record(
      args[0] instanceof WebAssembly.Module
        ? 'instantiate module'
        : 'instantiate',
      undefined,
      () => instantiate(...args)
    )) as typeof WebAssembly.instantiate;
  const fonts = document.fonts;
  const add = fonts.add.bind(fonts);
  fonts.add = (face) => {
    probe.fontsAdded.push(now());
    return add(face);
  };
  fonts.addEventListener('loadingdone', () =>
    probe.fontsLoadingDone.push(now())
  );
}

/** One realm's clock and Resource Timing, with the probe the init script left there. */
function timeline() {
  const navigation = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined;
  return {
    navigation: navigation
      ? {
          domContentLoaded: navigation.domContentLoadedEventEnd,
          load: navigation.loadEventEnd,
          responseEnd: navigation.responseEnd,
        }
      : null,
    origin: performance.timeOrigin,
    probe:
      (globalThis as typeof globalThis & { __officeLoad?: Probe })
        .__officeLoad ?? null,
    resources: (
      performance.getEntriesByType('resource') as (PerformanceResourceTiming & {
        deliveryType?: string;
      })[]
    ).map((entry) => ({
      deliveryType: entry.deliveryType ?? '',
      encodedBodySize: entry.encodedBodySize,
      end: entry.responseEnd,
      initiatorType: entry.initiatorType,
      name: entry.name,
      start: entry.startTime,
      transferSize: entry.transferSize,
    })),
  };
}

type Timeline = ReturnType<typeof timeline>;
type Realm = Timeline & { name: string };

/** The app page, its frames and every worker the page or the runtime started. */
async function timelines(page: Page) {
  const read = (name: string, evaluate: () => Promise<Timeline>) =>
    evaluate().then(
      (value): Realm => ({ ...value, name }),
      () => null
    );
  const realms = await Promise.all([
    read('app', () => page.evaluate(timeline)),
    ...page
      .frames()
      .filter((frame) => frame !== page.mainFrame())
      .map((frame) =>
        read(
          frame.url().includes('office-runtime')
            ? 'runtime'
            : `frame ${address(frame.url())}`,
          () => frame.evaluate(timeline)
        )
      ),
    ...page
      .workers()
      .map((worker) =>
        read(`worker ${address(worker.url())}`, () => worker.evaluate(timeline))
      ),
  ]);
  return realms.filter((realm): realm is Realm => realm !== null);
}

/** A URL without its query: presigned reads carry credentials there. */
function address(url: string) {
  try {
    const parsed = new URL(url);
    return /^(https?|wss?):$/.test(parsed.protocol)
      ? `${parsed.origin}${parsed.pathname}`
      : parsed.protocol;
  } catch {
    return '';
  }
}

function decoded(url: string) {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

/** From Resource Timing; a cross-origin entry without Timing-Allow-Origin has no sizes. */
function cacheState(entry: Timeline['resources'][number]) {
  if (
    entry.deliveryType === 'cache' ||
    (entry.transferSize === 0 && entry.encodedBodySize > 0)
  )
    return 'cache';
  if (entry.transferSize === 0) return 'opaque';
  return entry.transferSize < entry.encodedBodySize ? 'revalidated' : 'network';
}

function summarize(
  run: UatRun,
  file: MeasuredFile,
  open: 'cold' | 'warm',
  realms: Realm[],
  error: string | null
) {
  const app = realms.find((realm) => realm.name === 'app');
  const frame = realms.find((realm) => realm.name === 'runtime');
  const zero = app?.origin ?? 0;
  /** A time on `realm`'s clock, in ms after the app's navigation start. */
  const at = (realm: Realm | undefined, time: number | undefined) =>
    app && realm && time ? Math.round(realm.origin + time - zero) : null;
  const resources = realms.flatMap((realm) =>
    realm.resources.map((entry) => ({
      cache: cacheState(entry),
      encodedBodySize: entry.encodedBodySize,
      end: at(realm, entry.end),
      initiatorType: entry.initiatorType,
      realm: realm.name,
      start: at(realm, entry.start),
      transferSize: entry.transferSize,
      url: address(entry.name),
    }))
  );
  type Resource = (typeof resources)[number];
  const probe = app?.probe;
  const runtime = frame?.probe;
  const editable = at(app, probe?.editable);
  const latest = (times: (number | null)[]) =>
    times.reduce<number | null>(
      (last, time) =>
        time !== null &&
        (editable === null || time <= editable) &&
        (last === null || time > last)
          ? time
          : last,
      null
    );
  const span = (entry: Resource | undefined) =>
    entry ? { end: entry.end, start: entry.start } : null;
  const api = (route: string) =>
    resources.find(
      (entry) =>
        entry.realm === 'app' &&
        entry.url.endsWith(`/api/files/${file.id}/${route}`)
    );
  const collab = new URL(run.env.collabUrl).origin;
  const socket = probe?.sockets.find((entry) => entry.url.startsWith(collab));
  const synced = probe?.saveStates.find(
    (entry) => entry.state === 'saved' || entry.state === 'syncing'
  );
  const wasm = resources.filter((entry) => /\.wasm$/i.test(entry.url));
  const fonts = resources.filter((entry) =>
    /\.(woff2?|ttf|otf)$/i.test(entry.url)
  );
  const bundles = resources.filter((entry) => /\.(m?js|css)$/i.test(entry.url));
  const compiles = (runtime?.wasm ?? []).map((entry) => ({
    ...entry,
    end: at(frame, entry.end),
    start: at(frame, entry.start),
  }));
  const fontsAdded = (runtime?.fontsAdded ?? []).map((time) => at(frame, time));
  const milestones = {
    collaborationGrant: span(api('collaboration-token')),
    documentLoaded: at(app, app?.navigation?.load),
    domContentLoaded: at(app, app?.navigation?.domContentLoaded),
    editable,
    firstPagePainted: at(app, probe?.runtime.ready),
    fontsAdded: latest(fontsAdded),
    fontsFetched: latest(fonts.map((entry) => entry.end)),
    htmlReceived: at(app, app?.navigation?.responseEnd),
    loadArrived: at(frame, runtime?.host.load),
    replicaReady: at(app, probe?.runtime['collaboration-ready']),
    roomSocket: socket
      ? {
          created: at(app, socket.created),
          firstMessage: at(app, socket.firstMessage),
          open: at(app, socket.open),
        }
      : null,
    roomSynced: at(app, synced?.at),
    runtimeFrameLoaded: at(frame, frame?.navigation?.load),
    runtimeInitialized: at(app, probe?.runtime.initialized),
    sourceBytes: span(
      resources.find((entry) =>
        decoded(entry.url).endsWith(`/${file.blobPath}`)
      )
    ),
    sourceSession: span(api('source-session')),
    // The file view mounted its runtime frame: the SPA loaded, Clerk restored
    // the session and the workspace and file reads answered.
    spaReady: app && frame ? Math.round(frame.origin - zero) : null,
    wasmCompiled: latest(compiles.map((entry) => entry.end)),
    wasmFetched: latest(wasm.map((entry) => entry.end)),
  };
  const total = (list: Resource[]) => ({
    cached: list.filter((entry) => entry.cache === 'cache').length,
    count: list.length,
    opaque: list.filter((entry) => entry.cache === 'opaque').length,
    revalidated: list.filter((entry) => entry.cache === 'revalidated').length,
    transferBytes: list.reduce((sum, entry) => sum + entry.transferSize, 0),
  });
  return {
    error,
    file: {
      bytes: file.bytes,
      format: file.format,
      id: file.id,
      name: file.name,
      size: file.size,
    },
    fonts: {
      added: fontsAdded,
      fetches: fonts,
      loadingDone: (runtime?.fontsLoadingDone ?? []).map((time) =>
        at(frame, time)
      ),
    },
    milestones,
    navigationStart: app ? new Date(zero).toISOString() : null,
    open,
    realms: realms.map((realm) => realm.name),
    resources,
    runtimeCapabilities: (runtime?.capabilities ?? []).map((entry) => ({
      at: at(frame, entry.at),
      canEdit: entry.canEdit,
    })),
    runtimeErrors: probe?.runtimeErrors ?? [],
    runtimeTimings: probe?.readyTimings ?? null,
    saveStates: (probe?.saveStates ?? []).map((entry) => ({
      at: at(app, entry.at),
      state: entry.state,
    })),
    stuckAt: error
      ? (STAGES.find((stage) => milestones[stage] === null) ?? 'editable')
      : null,
    totals: { bundles: total(bundles), fonts: total(fonts), wasm: total(wasm) },
    unavailable: UNAVAILABLE,
    wasm: { compiles, fetches: wasm },
  };
}

type OpenResult = ReturnType<typeof summarize>;

/** Opens the file in Edit in `actor`'s page and reads every realm's timeline. */
async function measure(
  run: UatRun,
  actor: Actor,
  workspaceId: string,
  file: MeasuredFile,
  open: 'cold' | 'warm'
) {
  let error: string | null = null;
  try {
    await openFile(run, actor, workspaceId, file.id, 'edit');
    await whenReady(
      run,
      actor,
      `office-load-${file.format}-${file.size}-${open}`,
      () =>
        expect(officeMenu(actor.page, file.format, 'Edit')).toBeVisible({
          timeout: OPEN_TIMEOUT,
        })
    );
  } catch (caught) {
    error = String(caught instanceof Error ? caught.message : caught)
      .split('\n')[0]
      .slice(0, 300);
  }
  return summarize(run, file, open, await timelines(actor.page), error);
}

/** Rewritten after every open, so a run that stops early keeps its rows. */
function writeSummary(run: UatRun, directory: string, results: OpenResult[]) {
  const ms = (value: number | null | undefined) =>
    value === null || value === undefined ? '–' : String(value);
  const kb = (bytes: number) => Math.round(bytes / 1024);
  const sent = (total: OpenResult['totals']['wasm']) =>
    `${total.count} / ${kb(total.transferBytes)} KB / ${total.cached} cached`;
  const name = ({ file }: OpenResult) =>
    `${file.format} ${file.size}: \`${file.name}\` (${kb(file.bytes)} KB)`;
  const lines = [
    '# Office open times',
    '',
    `Run \`${run.id}\` on ${run.env.expectedRevision}. Milliseconds after the tab's navigation start; – is not reached or not observable. Cold: a new browser context, signed in, its HTTP cache cleared. Warm: a new tab in that context after the cold tab closed. Detail per open in \`office-load-*.json\`, traces in \`office-load-*.zip\` (\`npx playwright show-trace\`).`,
    '',
    '| File | Open | SPA ready | Frame initialized | Grant | Source bytes | Synced | WASM fetched | Fonts fetched | First page | Replica | Editable | Stuck at |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...results.map((result) => {
      const t = result.milestones;
      return `| ${name(result)} | ${result.open} | ${[
        t.spaReady,
        t.runtimeInitialized,
        t.collaborationGrant?.end,
        t.sourceBytes?.end,
        t.roomSynced,
        t.wasmFetched,
        t.fontsFetched,
        t.firstPagePainted,
        t.replicaReady,
        t.editable,
      ]
        .map(ms)
        .join(' | ')} | ${result.stuckAt ?? ''} |`;
    }),
    '',
    '## Transfer and cache',
    '',
    'Entries / KB over the network / entries from the HTTP cache, read once the editor was ready. Cross-origin responses without `Timing-Allow-Origin` report no size (`opaque` in the JSON).',
    '',
    '| File | Open | Bundles (JS, CSS) | WASM | Fonts |',
    '| --- | --- | --- | --- | --- |',
    ...results.map(
      (result) =>
        `| ${name(result)} | ${result.open} | ${sent(result.totals.bundles)} | ${sent(result.totals.wasm)} | ${sent(result.totals.fonts)} |`
    ),
  ];
  writeFileSync(
    path.join(directory, 'office-load.md'),
    `${lines.join('\n')}\n`,
    {
      mode: 0o600,
    }
  );
}

test('Office open times: DOCX, XLSX and PPTX, small and large, cold and warm', async ({
  run,
}) => {
  test.setTimeout(80 * 60_000);
  const evidence = path.join(runDirectory(run.id), 'evidence');
  mkdirSync(evidence, { mode: 0o700, recursive: true });
  const workspaceId = await workspace(run, 'office-load');
  const files: MeasuredFile[] = [];
  for (const [format, size, source] of FILES) {
    const bytes = await readFile(
      new URL(`../../../${source}`, import.meta.url)
    );
    const name = path.basename(source);
    // Store-only: ready to open once uploaded, with no parse or model spend;
    // opening in Edit takes the same path as for a parsed file.
    const id = await upload(run, workspaceId, name, bytes, true);
    files.push({
      blobPath: string((await fileRow(run, id)).blob_path),
      bytes: bytes.length,
      format,
      id,
      name,
      size,
    });
  }
  const results: OpenResult[] = [];
  for (const file of files) {
    const actor = await run.signInAgain(run.owner);
    const { context } = actor;
    // Cold: nothing the sign-in page loaded stays in the HTTP cache; cookies
    // and storage (the session) stay.
    const cdp = await context.newCDPSession(actor.page);
    await cdp.send('Network.clearBrowserCache');
    await cdp.detach();
    await actor.page.close();
    await context.addInitScript(
      installProbe,
      officeMenuLabels(file.format, 'Edit')
    );
    await context.tracing.start({ screenshots: true, snapshots: true });
    // Warm: a new tab in the same context once the cold tab closed.
    for (const open of ['cold', 'warm'] as const) {
      const label = `office-load-${file.format}-${file.size}-${open}`;
      await context.tracing.startChunk({ title: label });
      const page = await context.newPage();
      const result = await measure(
        run,
        { ...actor, page },
        workspaceId,
        file,
        open
      );
      await context.tracing.stopChunk({
        path: path.join(evidence, `${label}.zip`),
      });
      await page.close();
      results.push(result);
      await run.attach(label, result);
      writeSummary(run, evidence, results);
    }
    await context.tracing.stop();
  }
  assert.deepEqual(
    results
      .filter((result) => result.stuckAt)
      .map(
        ({ error, file, open, stuckAt }) =>
          `${file.name} ${open}: stuck at ${stuckAt} (${error})`
      ),
    [],
    'every open reaches the editor'
  );
});
