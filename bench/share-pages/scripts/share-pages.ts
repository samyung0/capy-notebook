/**
 * Shared page performance on the deployed UAT site.
 *
 * Signs in the fixed UAT owner, creates a link-shared workspace (store-only
 * files, two chapters), quiz, flashcard set and note from ../fixtures, waits
 * until the public API serves them, then measures each page:
 *
 * - Caching (fails the run): a 200 render is `SHARED_CACHE` with no
 *   Set-Cookie or Vary, a second visitor with other cookies, language and
 *   user agent gets the same bytes from Workers Cache (`CF-Cache-Status: HIT`),
 *   and a forged link is not cached.
 * - Lighthouse against BUDGETS (fails the run): desktop with applied and
 *   mobile with simulated throttling. Uncached runs add a unique query string,
 *   which Workers Cache keys on, so the Worker renders; cached runs hit the
 *   cached page.
 *
 * Everything this run creates is deleted at the end, along with leftovers of
 * earlier runs (named with PREFIX).
 *
 *   pnpm bench:share-pages
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import lighthouse from 'lighthouse';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';
import * as Y from 'yjs';
import { signIn } from '../../../e2e/uat/support';
import { RoomProvider } from '../../../src/features/collaboration/roomProvider';
import { CollabSocket } from '../../../src/features/collaboration/socket';
import { seedCards } from '../../../src/features/flashcards/liveSet';
import type { FlashcardContent } from '../../../src/features/materials/blocks';
import { uid } from '../../../src/lib/id';
import { buildBiologyLoadTestValue } from '../../../src/mocks/noteContent/loadTest';
import { compareStyles } from './styles';

const directory = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(directory, '../fixtures');
const out = process.env.SHARE_PERF_OUT ?? path.join(directory, '../.results');
const RUNS = Number(process.env.SHARE_PERF_RUNS ?? 5);
const PREFIX = 'Perf share page';
const SHARED_CACHE = 'public, s-maxage=300, max-age=0, must-revalidate';

for (const name of [
  'UAT_TARGET_AUTHORIZED',
  'UAT_ALLOWED_HOSTS',
  'UAT_APP_URL',
  'CLERK_SECRET_KEY',
  'UAT_OWNER_EMAIL',
])
  if (!process.env[name]) throw new Error(`Missing ${name}`);
if (process.env.UAT_TARGET_AUTHORIZED !== 'true')
  throw new Error('UAT_TARGET_AUTHORIZED must be exactly true');
const appUrl = new URL(process.env.UAT_APP_URL!).origin;
if (
  !process.env
    .UAT_ALLOWED_HOSTS!.split(',')
    .map((host) => host.trim())
    .includes(new URL(appUrl).hostname)
)
  throw new Error('UAT_APP_URL host is not present in UAT_ALLOWED_HOSTS');

type Json = Record<string, unknown>;
type Shared = { kind: string; path: string; publicApi: string };

class OriginWebSocket extends WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    // Node's WebSocket takes headers; the browser one sends Origin itself,
    // and the collaboration service admits the app's origin only.
    super(url, {
      headers: { Origin: appUrl },
      protocols,
    } as unknown as string[]);
  }
}

/** Writes a set's cards through its live room, as its editor does: live item
 * rooms are the only writers of set content. Resolves once a store holds
 * them. */
async function seedSet(page: Page, setId: string, cards: FlashcardContent[]) {
  const first = (await api(
    page,
    `/api/materials/${setId}/collaboration-token`,
    'POST',
    {}
  )) as { room: string; token: string; url: string };
  const doc = new Y.Doc();
  const request = randomUUID();
  let synced!: () => void;
  let stored!: () => void;
  let failed!: (error: Error) => void;
  const joined = new Promise<void>((resolve, reject) => {
    synced = resolve;
    failed = reject;
  });
  const saved = new Promise<void>((resolve) => {
    stored = resolve;
  });
  const provider = new RoomProvider({
    document: doc,
    name: first.room,
    onAuthenticationFailed: ({ reason }) =>
      failed(new Error(`Flashcards room refused: ${reason}`)),
    onStateless: ({ payload }) => {
      const event = JSON.parse(payload) as {
        checkpointIds?: string[];
        type?: string;
      };
      if (
        event.type === 'checkpoint-persisted' &&
        event.checkpointIds?.includes(request)
      )
        stored();
    },
    onSynced: ({ state }) => {
      if (state) synced();
    },
    socket: CollabSocket.create(first.url),
    token: async () => first.token,
    url: first.url,
  });
  const within = async (promise: Promise<void>, what: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${what} took over 60 s`)),
            60_000
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  // The room provider opens its socket with the global constructor.
  const NodeWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = OriginWebSocket;
  try {
    provider.connect();
    await within(joined, 'Joining the flashcards room');
    seedCards(doc, cards);
    // After the cards on the same channel, so the receipt covers them.
    provider.sendStateless(
      JSON.stringify({ id: request, type: 'checkpoint-request' })
    );
    await within(saved, 'Storing the cards');
  } finally {
    provider.destroy();
    globalThis.WebSocket = NodeWebSocket;
  }
}

/** An authenticated API call with a fresh Clerk session token. */
async function api(
  page: Page,
  route: string,
  method = 'GET',
  body?: unknown,
  expected = method === 'POST' ? 201 : method === 'DELETE' ? 204 : 200
): Promise<Json> {
  const token = await page.evaluate(() =>
    (
      window as unknown as {
        Clerk: { session: { getToken: () => Promise<string> } };
      }
    ).Clerk.session.getToken()
  );
  const response = await fetch(`${appUrl}${route}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    method,
  });
  const text = await response.text();
  if (response.status !== expected)
    throw new Error(`${method} ${route}: ${response.status} ${text}`);
  return text ? (JSON.parse(text) as Json) : {};
}

/** Deletes everything named with PREFIX: this run's items and leftovers. */
async function cleanUp(page: Page) {
  const workspaces = (await api(page, '/api/workspaces')) as unknown as Json[];
  for (const workspace of workspaces)
    if (String(workspace.name).startsWith(PREFIX))
      await api(page, `/api/workspaces/${workspace.id}`, 'DELETE');
  const { items } = (await api(
    page,
    '/api/materials?location=standalone&scope=owned&limit=100'
  )) as { items: Json[] };
  for (const material of items)
    if (String(material.title).startsWith(PREFIX))
      await api(page, `/api/materials/${material.id}`, 'DELETE');
}

const UPLOADS = [
  { chapter: undefined, name: 'digital.pdf' },
  { chapter: 'Week 1 · Cells', name: 'lesson.docx' },
  { chapter: 'Week 1 · Cells', name: 'lesson.pptx' },
  { chapter: 'Week 2 · Data', name: 'grades.xlsx' },
];

async function provision(page: Page, run: string): Promise<Shared[]> {
  const workspace = await api(page, '/api/workspaces', 'POST', {
    description: 'Cell biology lecture files, worksheets and the term data.',
    name: `${PREFIX} ${run}`,
    tags: [{ value: 'biology' }, { value: 'term 1' }],
  });
  const batchId = `perf_${run}`;
  for (const upload of UPLOADS) {
    const bytes = await readFile(
      path.join(directory, '../../../e2e/fixtures/files/basic', upload.name)
    );
    // Store only: nothing is parsed, embedded or sent to a model.
    const reservation = await api(
      page,
      `/api/workspaces/${workspace.id}/sources/uploads`,
      'POST',
      {
        batchId,
        batchTotal: UPLOADS.length,
        chapterName: upload.chapter,
        name: upload.name,
        parseMode: 'none',
        sizeBytes: bytes.length,
      }
    );
    const put = await fetch(String(reservation.url), {
      body: bytes,
      headers: reservation.headers as Record<string, string>,
      method: String(reservation.method),
    });
    if (!put.ok) throw new Error(`Upload ${upload.name}: ${put.status}`);
    await api(
      page,
      `/api/workspaces/${workspace.id}/sources/uploads/${reservation.uploadId}/complete`,
      'POST'
    );
  }
  const sharedWorkspace = await api(
    page,
    `/api/workspaces/${workspace.id}/sharing`,
    'PATCH',
    { privacy: 'link' }
  );

  const quiz = await api(page, '/api/quizzes', 'POST', {
    name: `${PREFIX} ${run} quiz`,
    privacy: 'link',
    questions: JSON.parse(
      await readFile(path.join(fixtures, 'quiz.json'), 'utf8')
    ),
  });

  const set = await api(page, '/api/flashcards', 'POST', {
    name: `${PREFIX} ${run} cards`,
  });
  const cards = JSON.parse(
    await readFile(path.join(fixtures, 'cards.json'), 'utf8')
  ) as Omit<FlashcardContent, 'id'>[];
  await seedSet(
    page,
    String(set.id),
    cards.map((card) => ({ ...card, id: uid('c') }))
  );
  const sharedSet = await api(
    page,
    `/api/flashcards/${set.id}/sharing`,
    'PATCH',
    { privacy: 'link' }
  );

  // Only standalone notes have links: write the every-block note in the
  // workspace, then clone it out. Uploaded asset blocks and links to other
  // materials are left out, as in the UAT note journey. A second note also
  // leaves out the blocks only the browser can draw (Mermaid diagrams and
  // interactive HTML frames), to tell their layout shift from the rest.
  const everyBlock = JSON.parse(
    await readFile(
      path.join(
        directory,
        '../../../server/internal/materialdoc/testdata/every-block-note.json'
      ),
      'utf8'
    )
  ) as { value: Json[] };
  const without = (nodes: Json[], types: string[]): Json[] =>
    nodes
      .filter((node) => !types.includes(String(node.type)))
      .map((node) =>
        Array.isArray(node.children)
          ? { ...node, children: without(node.children as Json[], types) }
          : node
      );
  const sharedNote = async (value: Json[], title: string) => {
    const note = await api(
      page,
      `/api/workspaces/${workspace.id}/materials`,
      'POST',
      {
        content: { schemaVersion: 1, value },
        kind: 'note',
        title: `${PREFIX} ${run} ${title}`,
      }
    );
    // No workspaceId: a standalone copy.
    const clone = await api(page, `/api/materials/${note.id}/clone`, 'POST', {
      title: `${PREFIX} ${run} ${title}`,
    });
    await api(page, `/api/materials/${clone.id}/sharing`, 'PATCH', {
      privacy: 'link',
    });
    const { items } = (await api(
      page,
      '/api/materials?kind=note&location=standalone&scope=owned&limit=100'
    )) as { items: Json[] };
    const sharePath = items.find((item) => item.id === clone.id)?.sharePath;
    if (typeof sharePath !== 'string') throw new Error(`${title} has no link`);
    return sharePath;
  };
  const UNSHAREABLE = ['img', 'audio', 'file', 'material_ref'];
  const notePath = await sharedNote(
    without(everyBlock.value, UNSHAREABLE),
    'note'
  );
  const serverOnlyPath = await sharedNote(
    without(everyBlock.value, [...UNSHAREABLE, 'mermaid', 'html_embed']),
    'server-only note'
  );
  // The app's load-test note: every kind of block, padded to 95% of the
  // 2 MB content limit (src/mocks/noteContent/loadTest.ts).
  const nearLimitPath = await sharedNote(
    without(buildBiologyLoadTestValue() as unknown as Json[], UNSHAREABLE),
    'near-limit note'
  );

  const token = (sharePath: unknown) => String(sharePath).split('/').pop();
  return [
    {
      kind: 'workspace',
      path: String(sharedWorkspace.sharePath),
      // The summary API takes the signed token, never the bare id.
      publicApi: `/api/public/workspaces/${token(sharedWorkspace.sharePath)}/summary`,
    },
    {
      kind: 'quizzes',
      path: String(quiz.sharePath),
      publicApi: `/api/public/quizzes/${token(quiz.sharePath)}`,
    },
    {
      kind: 'flashcards',
      path: String(sharedSet.sharePath),
      publicApi: `/api/public/flashcards/${token(sharedSet.sharePath)}`,
    },
    {
      kind: 'notes',
      path: notePath,
      publicApi: `/api/public/notes/${token(notePath)}`,
    },
    {
      kind: 'notes-server-only',
      path: serverOnlyPath,
      publicApi: `/api/public/notes/${token(serverOnlyPath)}`,
    },
    {
      kind: 'notes-near-limit',
      path: nearLimitPath,
      publicApi: `/api/public/notes/${token(nearLimitPath)}`,
    },
  ];
}

/** Waits until the public API serves the item, without touching the page's
 * cache entry, so the first page request below is a real miss. */
async function waitUntilPublic(shared: Shared) {
  const deadline = Date.now() + 60_000;
  while (true) {
    const response = await fetch(`${appUrl}${shared.publicApi}`);
    await response.body?.cancel();
    if (response.ok) return;
    if (Date.now() > deadline)
      throw new Error(`${shared.kind} is not public: ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

const VISITOR = {
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Cookie: '__session=perf-visitor; capy.theme=mocha',
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
};

/** Returns the failed caching checks for one page. */
async function checkCaching(shared: Shared) {
  const failures: string[] = [];
  const url = `${appUrl}${shared.path}`;
  const first = await fetch(url);
  const firstBody = await first.text();
  const second = await fetch(url, { headers: VISITOR });
  const secondBody = await second.text();
  const head = await fetch(url, { method: 'HEAD' });
  for (const [label, response] of [
    ['first', first],
    ['second', second],
  ] as const) {
    if (response.status !== 200)
      failures.push(`${label} request: ${response.status}`);
    const cacheControl = response.headers.get('cache-control');
    if (cacheControl !== SHARED_CACHE)
      failures.push(`${label} request: Cache-Control ${cacheControl}`);
    if (response.headers.has('set-cookie'))
      failures.push(`${label} request sets a cookie`);
    const vary = response.headers.get('vary');
    if (vary && vary.toLowerCase() !== 'accept-encoding')
      failures.push(`${label} request varies on ${vary}`);
  }
  const status = (response: Response) =>
    response.headers.get('cf-cache-status');
  if (status(second) !== 'HIT')
    failures.push(`another visitor got CF-Cache-Status ${status(second)}`);
  if (status(head) !== 'HIT')
    failures.push(`HEAD got CF-Cache-Status ${status(head)}`);
  if (secondBody !== firstBody)
    failures.push('another visitor got different bytes');
  return {
    failures,
    hit: status(second) === 'HIT',
    release: /<meta content="([0-9a-f]{40})" name="capy-release">/.exec(
      firstBody
    )?.[1],
  };
}

/** A forged link gets the uncached 404 page. */
async function checkForged() {
  const response = await fetch(`${appUrl}/share/quizzes/mat_forged.AAAA`);
  await response.body?.cancel();
  const failures: string[] = [];
  if (response.status !== 404) failures.push(`forged link: ${response.status}`);
  if (response.headers.get('cache-control') !== 'no-store')
    failures.push(
      `forged link: Cache-Control ${response.headers.get('cache-control')}`
    );
  if (response.headers.get('cf-cache-status') === 'HIT')
    failures.push('forged link was served from the cache');
  return failures;
}

/** One plain request's time to headers and the Worker's Server-Timing. */
async function timed(url: string, method = 'GET') {
  const start = performance.now();
  const response = await fetch(url, { method });
  const ms = performance.now() - start;
  await response.body?.cancel();
  const timing = response.headers.get('server-timing') ?? '';
  const entry = (name: string) =>
    timing.match(new RegExp(`${name}(?:;desc="([^"]*)")?;dur=([0-9.]+)`));
  return {
    api: Number(entry('api')?.[2] ?? Number.NaN),
    isolate: entry('isolate')?.[1],
    ms,
    total: Number(entry('total')?.[2] ?? Number.NaN),
  };
}

const BREAKDOWN_SAMPLES = 10;

/** The uncached time to first byte taken apart from the runner, one layer
 * at a time, with plain requests on a kept-alive connection (no browser, no
 * throttling): a static file (the edge), a forged link (the Worker alone:
 * token check, no API), the public API through the Worker (Worker and API)
 * and the uncached page (Worker, API and render). Report-only. */
async function breakdown(item: Shared, id: string) {
  const probes = {
    edge: (i: number) => timed(`${appUrl}/favicon.svg?b=${id}-${i}`),
    worker: (i: number) =>
      timed(`${appUrl}/share/quizzes/mat_forged.AAAA?b=${id}-${i}`, 'HEAD'),
    api: () => timed(`${appUrl}${item.publicApi}`),
    page: (i: number) => timed(`${appUrl}${item.path}?b=${id}-${i}`),
  };
  const samples = Object.fromEntries(
    Object.keys(probes).map((key) => [
      key,
      [] as Awaited<ReturnType<typeof timed>>[],
    ])
  ) as Record<keyof typeof probes, Awaited<ReturnType<typeof timed>>[]>;
  // Interleaved, so every layer sees the same moments of the network.
  for (let i = 0; i < BREAKDOWN_SAMPLES; i++)
    for (const key of Object.keys(probes) as (keyof typeof probes)[])
      samples[key].push(await probes[key](i));
  const of = (
    key: keyof typeof probes,
    get: (s: Awaited<ReturnType<typeof timed>>) => number
  ) => median(samples[key].map(get).filter((v) => !Number.isNaN(v)));
  return {
    apiMs: of('api', (s) => s.ms),
    edgeMs: of('edge', (s) => s.ms),
    newIsolates: Object.fromEntries(
      Object.entries(samples).map(([key, list]) => [
        key,
        list.filter((s) => s.isolate === 'new').length,
      ])
    ),
    pageApiMs: of('page', (s) => s.api),
    pageMs: of('page', (s) => s.ms),
    pageTotalMs: of('page', (s) => s.total),
    samples,
    workerMs: of('worker', (s) => s.ms),
  };
}

type Metrics = {
  bytes: Record<string, number>;
  cls: number;
  fcp: number;
  lcp: number;
  /** Unthrottled: what the runner's Chromium actually painted. */
  observedFcp: number;
  observedLcp: number;
  requests: number;
  score: number;
  tbt: number;
  ttfb: number;
};

type Shift = { score: number; selector?: string; snippet?: string };

/** Desktop is closer to most visitors: 40 ms RTT and 10 Mbps applied to the
 * browser's real requests (DevTools throttling), full-speed CPU. Applied
 * throttling keeps the document's real server time in FCP and LCP, so a
 * Worker render shows against a cached copy; simulated throttling estimates
 * server time per origin and hides it. Mobile is the worst case and stays
 * simulated for steady numbers: a mid-range phone on slow 4G (150 ms RTT,
 * 1.6 Mbps, 4x slower CPU); its uncached cost shows only in TTFB. */
const DESKTOP_APPLIED = {
  ...desktopConfig,
  settings: {
    ...desktopConfig.settings,
    throttling: {
      ...desktopConfig.settings!.throttling,
      // Lighthouse's own factors for turning RTT and throughput into the
      // request latency and bandwidth DevTools applies.
      downloadThroughputKbps: 10 * 1024 * 0.9,
      requestLatencyMs: 40 * 3.75,
      uploadThroughputKbps: 10 * 1024 * 0.9,
    },
    throttlingMethod: 'devtools' as const,
  },
};
const PROFILES = { desktop: DESKTOP_APPLIED, mobile: undefined } as const;
type Profile = keyof typeof PROFILES;

async function audit(port: number, url: string, profile: Profile) {
  const result = await lighthouse(
    url,
    {
      logLevel: 'error',
      onlyCategories: ['performance'],
      output: 'html',
      port,
    },
    PROFILES[profile]
  );
  if (!result) throw new Error(`Lighthouse returned nothing for ${url}`);
  const { audits, categories, runtimeError } = result.lhr;
  if (runtimeError) throw new Error(`${url}: ${runtimeError.message}`);
  const items = (
    audits['resource-summary'].details as unknown as {
      items: {
        requestCount: number;
        resourceType: string;
        transferSize: number;
      }[];
    }
  ).items;
  const [observed] = (
    audits.metrics.details as unknown as {
      items: {
        observedFirstContentfulPaint: number;
        observedLargestContentfulPaint: number;
      }[];
    }
  ).items;
  const shifts = (
    audits['layout-shifts'].details as unknown as
      | {
          items: {
            node?: { selector?: string; snippet?: string };
            score: number;
          }[];
        }
      | undefined
  )?.items.map((item): Shift => ({
    score: item.score,
    selector: item.node?.selector,
    snippet: item.node?.snippet?.slice(0, 200),
  }));
  const metrics: Metrics = {
    bytes: Object.fromEntries(
      items.map((item) => [item.resourceType, item.transferSize])
    ),
    cls: audits['cumulative-layout-shift'].numericValue!,
    fcp: audits['first-contentful-paint'].numericValue!,
    lcp: audits['largest-contentful-paint'].numericValue!,
    observedFcp: observed.observedFirstContentfulPaint,
    observedLcp: observed.observedLargestContentfulPaint,
    requests: items.find((item) => item.resourceType === 'total')!.requestCount,
    score: categories.performance.score!,
    tbt: audits['total-blocking-time'].numericValue!,
    ttfb: audits['server-response-time'].numericValue!,
  };
  // What the edge said about this run's own document.
  const document = result.artifacts.DevtoolsLog.find(
    (event) =>
      event.method === 'Network.responseReceived' &&
      event.params.type === 'Document'
  ) as
    { params: { response: { headers: Record<string, string> } } } | undefined;
  const header = (wanted: string) =>
    Object.entries(document?.params.response.headers ?? {}).find(
      ([name]) => name.toLowerCase() === wanted
    )?.[1];
  // The Worker's own timing (workers/site/handler.ts): `api` and `total` ms.
  // DevTools joins repeated headers with newlines, and Cloudflare adds its own.
  const server = Object.fromEntries(
    (header('server-timing') ?? '').split(/[,\n]/).flatMap((entry) => {
      const [name, duration] = entry.trim().split(';dur=');
      return duration ? [[name, Number(duration)]] : [];
    })
  ) as { api?: number; total?: number };
  // Whether a new isolate rendered the page (workers/site/index.ts).
  const isolate = header('server-timing')?.match(
    /isolate;desc="(new|reused)"/
  )?.[1] as 'new' | 'reused' | undefined;
  return {
    edge: header('cf-cache-status') ?? 'none',
    isolate,
    lhr: result.lhr,
    metrics,
    report: result.report as string,
    server,
    shifts: shifts ?? [],
    // The DevTools trace, which opens in the Performance panel.
    trace: result.artifacts.Trace,
  };
}

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

type Run = Awaited<ReturnType<typeof audit>>;

/** The median of each metric, plus the run whose LCP is the median. */
function medians(runs: Run[]) {
  const pick = (get: (m: Metrics) => number) =>
    median(runs.map(({ metrics }) => get(metrics)));
  const middle = runs.find(
    ({ metrics }) => metrics.lcp === pick((m) => m.lcp)
  )!;
  const types = Object.keys(runs[0].metrics.bytes);
  return {
    median: {
      bytes: Object.fromEntries(
        types.map((type) => [type, pick((m) => m.bytes[type] ?? 0)])
      ),
      cls: pick((m) => m.cls),
      fcp: pick((m) => m.fcp),
      lcp: pick((m) => m.lcp),
      observedFcp: pick((m) => m.observedFcp),
      observedLcp: pick((m) => m.observedLcp),
      requests: pick((m) => m.requests),
      score: pick((m) => m.score),
      tbt: pick((m) => m.tbt),
      ttfb: pick((m) => m.ttfb),
    } satisfies Metrics,
    middle,
    /** Median Server-Timing of the runs: on a miss, this run's render; on a
     * hit, the render that filled the cache. */
    server: {
      api: median(runs.flatMap(({ server }) => server.api ?? [])),
      total: median(runs.flatMap(({ server }) => server.total ?? [])),
    },
    servers: runs.map(({ server }) => server),
    runs: runs.map(({ metrics }) => metrics),
  };
}

/** Uncached runs stop here even short of RUNS warm ones. About half land on
 * a new isolate, so RUNS warm runs take about twice RUNS; four times leaves
 * well under a 1% chance of falling short. */
const MAX_UNCACHED_RUNS = RUNS * 4;

/** Runs Lighthouse until RUNS runs count and keeps their medians. An
 * uncached run counts only when a warm isolate rendered the page: a new one
 * adds a few hundred ms of cold start to about half the runs at random,
 * which moved the median by that much from run to run. Those runs are kept
 * apart as `cold`, reported but not budgeted. */
async function measure(
  port: number,
  url: (index: number) => string,
  profile: Profile,
  cached: boolean
) {
  const runs: Run[] = [];
  const cold: Run[] = [];
  /** Every run in order: its document's CF-Cache-Status and, uncached,
   * whether a new isolate rendered it. */
  const attempts: { edge: string; isolate?: 'new' | 'reused' }[] = [];
  for (let index = 0; runs.length < RUNS; index++) {
    if (!cached && index === MAX_UNCACHED_RUNS) break;
    // A cached run asks right after a request that fills the edge, since the
    // five-minute entry may have lapsed while earlier pages were measured.
    if (cached) await (await fetch(url(index))).body?.cancel();
    const result = await audit(port, url(index), profile);
    attempts.push({ edge: result.edge, isolate: result.isolate });
    if (!cached && !result.isolate)
      throw new Error(`${url(index)}: no isolate in Server-Timing`);
    (cached || result.isolate === 'reused' ? runs : cold).push(result);
  }
  if (!runs.length)
    throw new Error(
      `${url(0)}: no warm isolate in ${MAX_UNCACHED_RUNS} uncached runs`
    );
  const { middle, ...counted } = medians(runs);
  const coldMedians = cold.length ? medians(cold) : undefined;
  return {
    ...counted,
    attempts,
    cold: coldMedians && {
      median: coldMedians.median,
      runs: coldMedians.runs,
      server: coldMedians.server,
      servers: coldMedians.servers,
    },
    lhr: middle.lhr,
    report: middle.report,
    shifts: middle.shifts,
    trace: middle.trace,
  };
}

/** Signed off 2026-10-11 from runs 38121449475 and 38122817338: the worst
 * median with some headroom; cached desktop paint and the near-limit
 * note's blocking time raised after run 38144545133. Medians are compared,
 * cached and uncached alike unless named; uncached medians are of
 * warm-isolate runs only since 2026-10-12 (the budgets were set from medians
 * that mixed in cold ones). Blocking time is set from the slower of the two
 * runners GitHub handed out (Lighthouse CPU benchmark about 2200 against
 * 3600), since it scales with the runner's CPU. */
const BUDGETS = {
  /** Transfer size of the whole page, desktop cached. */
  bytesKb: {
    flashcards: 480,
    notes: 720,
    // Provisional: the notes budgets, until a developer signs off its own.
    'notes-near-limit': 720,
    'notes-server-only': 480,
    quizzes: 520,
    workspace: 150,
  },
  /** Raised from 0.02 on 2026-10-13: page titles now wrap in full, so a long
   * one can change its line count when Fustat swaps in (run 38288387195:
   * near-limit note 0.014 desktop, notes 0.009 mobile from the maths fonts). */
  cls: 0.025,
  desktopCachedPaintMs: 650,
  /** Warm isolate; tightened from 2000 for every page on 2026-10-12 after
   * run 38219942945 (warm medians: workspace 479, quizzes 545, flashcards
   * 524, notes 720, notes-server-only 654, notes-near-limit 1129); the
   * near-limit note raised to 1600 after run 38248024079 (1412). */
  desktopUncachedFcpMs: {
    flashcards: 1000,
    notes: 1200,
    'notes-near-limit': 1600,
    'notes-server-only': 1200,
    quizzes: 1000,
    workspace: 1000,
  },
  mobileFcpMs: 2300,
  mobileLcpMs: {
    flashcards: 2500,
    notes: 3000,
    'notes-near-limit': 3000,
    'notes-server-only': 3000,
    quizzes: 2500,
    workspace: 2500,
  },
  mobileTbtMs: {
    flashcards: 250,
    notes: 450,
    'notes-near-limit': 600,
    'notes-server-only': 100,
    quizzes: 300,
    workspace: 50,
  },
  /** The Worker's Server-Timing on an uncached render. */
  workerApiMs: 500,
  workerTotalMs: 800,
};

/** Every budget a page went over, as readable lines. */
function budgetFailures(results: Awaited<ReturnType<typeof run>>) {
  const failures: string[] = [];
  const check = (
    label: string,
    value: number | undefined,
    limit: number,
    unit: string
  ) => {
    // A missing value (no Server-Timing) is a failure, not a pass.
    if (value === undefined || Number.isNaN(value))
      failures.push(`${label}: not measured`);
    else if (value > limit) {
      const shown =
        unit === ''
          ? value.toFixed(3)
          : unit === ' KB'
            ? value.toFixed(1)
            : Math.round(value);
      failures.push(`${label}: ${shown}${unit} over ${limit}${unit}`);
    }
  };
  const per = (table: Record<string, number>, kind: string) => {
    const limit = table[kind];
    if (limit === undefined) throw new Error(`No budget for ${kind}`);
    return limit;
  };
  for (const page of results.pages) {
    const kind = page.kind;
    check(
      `${kind} bytes`,
      page.desktop.cached.median.bytes.total / 1024,
      per(BUDGETS.bytesKb, kind),
      ' KB'
    );
    for (const { edge, measured, profile } of measuredSets(page))
      check(
        `${kind} ${profile} ${edge} CLS`,
        measured.median.cls,
        BUDGETS.cls,
        ''
      );
    const uncached = page.desktop.uncached;
    check(
      `${kind} Worker total`,
      uncached.server.total,
      BUDGETS.workerTotalMs,
      ' ms'
    );
    check(
      `${kind} API read`,
      uncached.server.api,
      BUDGETS.workerApiMs,
      ' ms'
    );
    check(
      `${kind} desktop uncached FCP`,
      uncached.median.fcp,
      per(BUDGETS.desktopUncachedFcpMs, kind),
      ' ms'
    );
    const cached = page.desktop.cached.median;
    check(
      `${kind} desktop cached FCP`,
      cached.fcp,
      BUDGETS.desktopCachedPaintMs,
      ' ms'
    );
    check(
      `${kind} desktop cached LCP`,
      cached.lcp,
      BUDGETS.desktopCachedPaintMs,
      ' ms'
    );
    const mobile = page.mobile.cached.median;
    check(`${kind} mobile FCP`, mobile.fcp, BUDGETS.mobileFcpMs, ' ms');
    check(
      `${kind} mobile LCP`,
      mobile.lcp,
      per(BUDGETS.mobileLcpMs, kind),
      ' ms'
    );
    check(
      `${kind} mobile TBT`,
      mobile.tbt,
      per(BUDGETS.mobileTbtMs, kind),
      ' ms'
    );
  }
  return failures;
}

function summary(
  results: Awaited<ReturnType<typeof run>>,
  overBudget: string[]
) {
  const kb = (bytes = 0) => `${(bytes / 1024).toFixed(1)}`;
  const ms = (value: number) => `${Math.round(value)}`;
  const lines = [
    '### Shared pages on UAT',
    '',
    `Release \`${results.release ?? 'unknown'}\` · Lighthouse ${results.lighthouse} · ${results.chromium} · median of ${RUNS} (uncached: warm isolates, up to ${MAX_UNCACHED_RUNS} runs)`,
    '',
    "Uncached: a unique query string, so the Worker renders the page. Cached: the clean URL, requested just before. Edge is each run's own CF-Cache-Status. TTFB is the document's server response time; Worker is the Worker's own Server-Timing for an uncached render, the time until the page was built with the API read in brackets (CPU time never shows in a Worker's clock, so the render itself is the rest of TTFB). Every run is a first visit: the browser's cache is empty. Uncached medians and budgets count only runs a warm Worker isolate rendered; the runs a new isolate rendered (its cold start, a few hundred ms) are the *new isolate* row, not budgeted.",
  ];
  for (const [profile, label] of [
    [
      'desktop',
      'Desktop, applied throttling (40 ms RTT, 10 Mbps, full-speed CPU): server time counts',
    ],
    [
      'mobile',
      'Mobile, simulated worst case (slow 4G, 4x slower CPU), cached only: simulation leaves server time out of the paint times, so an uncached run would only repeat TTFB',
    ],
  ] as const) {
    lines.push(
      '',
      `**${label}**`,
      '',
      '| Page | Edge | TTFB ms | Worker ms (API) | FCP ms | LCP ms | CLS | TBT ms | Total KB | Document KB | Script KB | Requests | Score |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
    );
    const row = (
      kind: string,
      label: string,
      m: Metrics,
      server: { api: number; total: number } | undefined
    ) =>
      `| ${kind} | ${label} | ${ms(m.ttfb)} | ${server ? `${ms(server.total)} (${ms(server.api)})` : '—'} | ${ms(m.fcp)} | ${ms(m.lcp)} | ${m.cls.toFixed(3)} | ${ms(m.tbt)} | ${kb(m.bytes.total)} | ${kb(m.bytes.document)} | ${kb(m.bytes.script)} | ${m.requests} | ${Math.round(m.score * 100)} |`;
    for (const page of results.pages)
      for (const { edge, measured } of measuredSets(page).filter(
        (set) => set.profile === profile
      )) {
        // A run the edge answered against the plan is called out.
        const expected = edge === 'cached' ? 'HIT' : 'MISS';
        const statuses = measured.attempts
          .map(({ edge: status }) =>
            status === expected ? status : `**${status}**`
          )
          .join(' ');
        const uncached = edge === 'uncached';
        lines.push(
          row(
            page.kind,
            uncached
              ? `uncached, warm isolate (${measured.runs.length} of ${measured.attempts.length}: ${statuses})`
              : `cached (${statuses})`,
            measured.median,
            uncached ? measured.server : undefined
          )
        );
        if (measured.cold)
          lines.push(
            row(
              page.kind,
              `uncached, new isolate (${measured.cold.runs.length})`,
              measured.cold.median,
              measured.cold.server
            )
          );
      }
  }
  lines.push('', '**Layout shifts** (mobile, cached, the median-LCP run)', '');
  for (const page of results.pages)
    for (const shift of page.mobile.cached.shifts)
      lines.push(
        `- ${page.kind}: ${shift.score.toFixed(3)} \`${shift.selector ?? 'unknown element'}\``
      );
  lines.push(
    '',
    '**Inlined CSS** (the page with only it against the full stylesheets)',
    ''
  );
  for (const page of results.pages)
    lines.push(
      `- ${page.kind}: ${kb(page.styles.subsetBytes)} of ${kb(page.styles.fullBytes)} KB, ${page.styles.checked} computed styles compared${page.styles.differences.length ? ` — **FAILED:** ${page.styles.differences.join('; ')}` : ', no difference'}${page.styles.noise.length ? ` (rendering noise, the full page differs from itself too: ${page.styles.noise.join('; ')})` : ''}`
    );
  lines.push(
    '',
    `**Uncached time to first byte, layer by layer** (median of ${BREAKDOWN_SAMPLES} plain requests from the runner on a kept-alive connection; new isolates out of ${BREAKDOWN_SAMPLES} in brackets)`,
    '',
    '| Page | Static file (edge) | Forged link (Worker only) | Public API via Worker | Uncached page | Worker total (API) |',
    '| --- | ---: | ---: | ---: | ---: | ---: |'
  );
  for (const page of results.pages) {
    const b = page.breakdown;
    const n = b.newIsolates;
    lines.push(
      `| ${page.kind} | ${ms(b.edgeMs)} (${n.edge}) | ${ms(b.workerMs)} (${n.worker}) | ${ms(b.apiMs)} (${n.api}) | ${ms(b.pageMs)} (${n.page}) | ${ms(b.pageTotalMs)} (${ms(b.pageApiMs)}) |`
    );
  }
  lines.push('', '**Cache hit for a second visitor**', '');
  for (const page of results.pages)
    lines.push(
      `- ${page.kind}: ${page.cache.hit ? 'hit' : '**miss**'}${page.cache.failures.length ? ` — **FAILED:** ${page.cache.failures.join('; ')}` : ''}`
    );
  if (results.forged.length)
    lines.push(`- **FAILED:** ${results.forged.join('; ')}`);
  lines.push('', '**Budgets** (`BUDGETS` in the bench script)', '');
  lines.push(
    ...(overBudget.length
      ? overBudget.map((failure) => `- **FAILED:** ${failure}`)
      : ['- every page within budget'])
  );
  return `${lines.join('\n')}\n`;
}

// Lighthouse drives its own Chromium over this port; the signed-in browser
// stays separate, so no session reaches the audited pages.
const LIGHTHOUSE_PORT = 9223;

async function run(page: Page) {
  const id = randomUUID().slice(0, 8);
  await cleanUp(page);
  const shared = await provision(page, id);
  for (const item of shared) await waitUntilPublic(item);
  const forged = await checkForged();
  const caches = [];
  for (const item of shared) caches.push(await checkCaching(item));
  const breakdowns = [];
  for (const item of shared) breakdowns.push(await breakdown(item, id));
  // Fresh contexts of the signed-in browser carry no session.
  const styles = [];
  for (const item of shared)
    styles.push(
      await compareStyles(
        page.context().browser()!,
        `${appUrl}${item.path}`,
        item.kind,
        out
      )
    );

  const chrome = await chromium.launch({
    args: [`--remote-debugging-port=${LIGHTHOUSE_PORT}`],
    // Full Chromium in new headless mode, not the headless shell.
    channel: 'chromium',
  });
  try {
    const pages = [];
    for (const [index, item] of shared.entries()) {
      const url = `${appUrl}${item.path}`;
      pages.push({
        breakdown: breakdowns[index],
        cache: caches[index],
        kind: item.kind,
        styles: styles[index],
        desktop: {
          // A unique query string is its own Workers Cache entry: a render.
          uncached: await measure(
            LIGHTHOUSE_PORT,
            (i) => `${url}?perf=${id}-${i}`,
            'desktop',
            false
          ),
          cached: await measure(LIGHTHOUSE_PORT, () => url, 'desktop', true),
        },
        // Cached only: simulated throttling leaves server time out of FCP
        // and LCP, so an uncached mobile run measured nothing desktop's
        // doesn't, apart from TTFB.
        mobile: {
          cached: await measure(LIGHTHOUSE_PORT, () => url, 'mobile', true),
        },
      });
    }
    return {
      chromium: `Chromium ${chrome.version()}`,
      forged,
      lighthouse: (
        JSON.parse(
          await readFile(
            path.join(
              directory,
              '../../../node_modules/lighthouse/package.json'
            ),
            'utf8'
          )
        ) as { version: string }
      ).version,
      pages,
      release: caches.find((cache) => cache.release)?.release,
    };
  } finally {
    await chrome.close();
  }
}

type Measured = Awaited<ReturnType<typeof run>>['pages'][number];

/** What a page is measured as: desktop uncached and cached, mobile cached. */
const measuredSets = ({
  desktop,
  mobile,
}: Pick<Measured, 'desktop' | 'mobile'>) =>
  [
    { edge: 'uncached', measured: desktop.uncached, profile: 'desktop' },
    { edge: 'cached', measured: desktop.cached, profile: 'desktop' },
    { edge: 'cached', measured: mobile.cached, profile: 'mobile' },
  ] as const;

const browser = await chromium.launch();
const page = await browser.newPage({ baseURL: appUrl });
let failed = false;
try {
  await signIn(page, 'owner');
  const results = await run(page);
  await mkdir(out, { recursive: true });
  // Per page, profile and edge state, the median-LCP run's report, its full
  // Lighthouse result and its DevTools trace (load it in the Performance
  // panel).
  for (const item of results.pages)
    for (const { edge, measured, profile } of measuredSets(item)) {
      const name = path.join(out, `${item.kind}-${profile}-${edge}`);
      await writeFile(`${name}.report.html`, measured.report);
      await writeFile(`${name}.lhr.json`, JSON.stringify(measured.lhr));
      await writeFile(`${name}.trace.json`, JSON.stringify(measured.trace));
    }
  const keep = (measured: Awaited<ReturnType<typeof measure>>) => ({
    attempts: measured.attempts,
    cold: measured.cold,
    median: measured.median,
    runs: measured.runs,
    server: measured.server,
    servers: measured.servers,
    shifts: measured.shifts,
  });
  const snapshot = {
    ...results,
    pages: results.pages.map(({ desktop, mobile, ...item }) => ({
      ...item,
      desktop: {
        cached: keep(desktop.cached),
        uncached: keep(desktop.uncached),
      },
      mobile: { cached: keep(mobile.cached) },
    })),
    runs: RUNS,
  };
  await writeFile(
    path.join(out, 'share-pages.json'),
    `${JSON.stringify(snapshot, null, 2)}\n`
  );
  const overBudget = budgetFailures(results);
  const markdown = summary(results, overBudget);
  await writeFile(path.join(out, 'summary.md'), markdown);
  console.log(markdown);
  failed =
    overBudget.length > 0 ||
    results.forged.length > 0 ||
    results.pages.some(
      (item) =>
        item.cache.failures.length > 0 || item.styles.differences.length > 0
    );
} finally {
  await cleanUp(page).catch((error) => {
    console.error('Cleanup failed:', error);
    failed = true;
  });
  await browser.close();
}
process.exit(failed ? 1 : 0);
