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
 * - Lighthouse (report only until budgets are signed off): mobile preset with
 *   simulated throttling. "Cold" runs add a unique query string, which Workers
 *   Cache keys on, so the Worker renders; "warm" runs hit the cached page.
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
import { signIn } from '../../../e2e/uat/support';

const directory = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(directory, '../fixtures');
const out = process.env.SHARE_PERF_OUT ?? path.join(directory, '../.results');
const RUNS = Number(process.env.SHARE_PERF_RUNS ?? 3);
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
type Kind = 'workspace' | 'quizzes' | 'flashcards' | 'notes';
type Shared = { kind: Kind; path: string; publicApi: string };

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
    tags: ['biology', 'term 1'],
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
  await api(page, `/api/flashcards/${set.id}/content`, 'PATCH', {
    cards: JSON.parse(
      await readFile(path.join(fixtures, 'cards.json'), 'utf8')
    ),
    expectedRevision: set.revision,
  });
  const sharedSet = await api(
    page,
    `/api/flashcards/${set.id}/sharing`,
    'PATCH',
    { privacy: 'link' }
  );

  // Only standalone notes have links: write the every-block note in the
  // workspace, then clone it out. Uploaded asset blocks and links to other
  // materials are left out, as in the UAT note journey.
  const everyBlock = JSON.parse(
    await readFile(
      path.join(
        directory,
        '../../../server/internal/materialdoc/testdata/every-block-note.json'
      ),
      'utf8'
    )
  ) as { value: Json[] };
  const value = everyBlock.value.filter(
    (node) => !['img', 'audio', 'file'].includes(String(node.type))
  );
  const stripRefs = (nodes: Json[]): Json[] =>
    nodes
      .filter((node) => node.type !== 'material_ref')
      .map((node) =>
        Array.isArray(node.children)
          ? { ...node, children: stripRefs(node.children as Json[]) }
          : node
      );
  const note = await api(
    page,
    `/api/workspaces/${workspace.id}/materials`,
    'POST',
    {
      content: { schemaVersion: 1, value: stripRefs(value) },
      kind: 'note',
      title: `${PREFIX} ${run} note`,
    }
  );
  const clone = await api(page, `/api/materials/${note.id}/clone`, 'POST');
  await api(page, `/api/materials/${clone.id}/sharing`, 'PATCH', {
    privacy: 'link',
  });
  const { items } = (await api(
    page,
    '/api/materials?kind=note&location=standalone&scope=owned&limit=100'
  )) as { items: Json[] };
  const notePath = items.find((item) => item.id === clone.id)?.sharePath;
  if (typeof notePath !== 'string') throw new Error('The note has no link');

  const token = (sharePath: unknown) => String(sharePath).split('/').pop();
  return [
    {
      kind: 'workspace',
      path: String(sharedWorkspace.sharePath),
      publicApi: `/api/public/workspaces/${workspace.id}/summary`,
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
    first: { age: first.headers.get('age'), status: status(first) },
    release: /<meta content="([0-9a-f]{40})" name="capy-release">/.exec(
      firstBody
    )?.[1],
    second: { age: second.headers.get('age'), status: status(second) },
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

type Metrics = {
  bytes: Record<string, number>;
  cls: number;
  fcp: number;
  lcp: number;
  requests: number;
  score: number;
  tbt: number;
  ttfb: number;
};

async function audit(port: number, url: string) {
  const result = await lighthouse(url, {
    logLevel: 'error',
    onlyCategories: ['performance'],
    output: 'html',
    port,
  });
  if (!result) throw new Error(`Lighthouse returned nothing for ${url}`);
  const { audits, categories, runtimeError } = result.lhr;
  if (runtimeError) throw new Error(`${url}: ${runtimeError.message}`);
  const items = (
    audits['resource-summary'].details as unknown as {
      items: { requestCount: number; resourceType: string; transferSize: number }[];
    }
  ).items;
  const metrics: Metrics = {
    bytes: Object.fromEntries(
      items.map((item) => [item.resourceType, item.transferSize])
    ),
    cls: audits['cumulative-layout-shift'].numericValue!,
    fcp: audits['first-contentful-paint'].numericValue!,
    lcp: audits['largest-contentful-paint'].numericValue!,
    requests: items.find((item) => item.resourceType === 'total')!.requestCount,
    score: categories.performance.score!,
    tbt: audits['total-blocking-time'].numericValue!,
    ttfb: audits['server-response-time'].numericValue!,
  };
  return { metrics, report: result.report as string };
}

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Runs Lighthouse RUNS times and keeps the median of each metric, plus the
 * report of the run whose LCP is the median. */
async function measure(port: number, url: (index: number) => string) {
  const runs: Awaited<ReturnType<typeof audit>>[] = [];
  for (let index = 0; index < RUNS; index++)
    runs.push(await audit(port, url(index)));
  const pick = (get: (m: Metrics) => number) =>
    median(runs.map(({ metrics }) => get(metrics)));
  const middle = runs.find(({ metrics }) => metrics.lcp === pick((m) => m.lcp))!;
  const types = Object.keys(runs[0].metrics.bytes);
  return {
    median: {
      bytes: Object.fromEntries(
        types.map((type) => [type, pick((m) => m.bytes[type] ?? 0)])
      ),
      cls: pick((m) => m.cls),
      fcp: pick((m) => m.fcp),
      lcp: pick((m) => m.lcp),
      requests: pick((m) => m.requests),
      score: pick((m) => m.score),
      tbt: pick((m) => m.tbt),
      ttfb: pick((m) => m.ttfb),
    } satisfies Metrics,
    report: middle.report,
    runs: runs.map(({ metrics }) => metrics),
  };
}

function summary(results: Awaited<ReturnType<typeof run>>) {
  const kb = (bytes = 0) => `${(bytes / 1024).toFixed(1)}`;
  const ms = (value: number) => `${Math.round(value)}`;
  const lines = [
    '### Shared pages on UAT',
    '',
    `Release \`${results.release ?? 'unknown'}\` · Lighthouse ${results.lighthouse} (mobile, simulated throttling) · ${results.chromium} · median of ${RUNS}`,
    '',
    '| Page | Edge | FCP ms | LCP ms | CLS | TBT ms | TTFB ms | Total KB | Document KB | Script KB | Requests | Score |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const page of results.pages)
    for (const edge of ['cold', 'warm'] as const) {
      const m = page[edge].median;
      lines.push(
        `| ${page.kind} | ${edge} | ${ms(m.fcp)} | ${ms(m.lcp)} | ${m.cls.toFixed(3)} | ${ms(m.tbt)} | ${ms(m.ttfb)} | ${kb(m.bytes.total)} | ${kb(m.bytes.document)} | ${kb(m.bytes.script)} | ${m.requests} | ${Math.round(m.score * 100)} |`
      );
    }
  lines.push('', '**Caching**', '');
  for (const page of results.pages)
    lines.push(
      `- ${page.kind}: first ${page.cache.first.status}, another visitor ${page.cache.second.status} (Age ${page.cache.second.age ?? '-'})${page.cache.failures.length ? ` — **FAILED:** ${page.cache.failures.join('; ')}` : ''}`
    );
  if (results.forged.length)
    lines.push(`- **FAILED:** ${results.forged.join('; ')}`);
  lines.push(
    '',
    'Budgets are report-only until signed off; caching failures fail the run.'
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
        cache: caches[index],
        // A unique query string is its own Workers Cache entry: a render.
        cold: await measure(LIGHTHOUSE_PORT, (i) => `${url}?perf=${id}-${i}`),
        kind: item.kind,
        warm: await measure(LIGHTHOUSE_PORT, () => url),
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

const browser = await chromium.launch();
const page = await browser.newPage({ baseURL: appUrl });
let failed = false;
try {
  await signIn(page, 'owner');
  const results = await run(page);
  await mkdir(out, { recursive: true });
  for (const item of results.pages)
    for (const edge of ['cold', 'warm'] as const)
      await writeFile(
        path.join(out, `${item.kind}-${edge}.report.html`),
        item[edge].report
      );
  const snapshot = {
    ...results,
    pages: results.pages.map(({ cold, warm, ...item }) => ({
      ...item,
      cold: { median: cold.median, runs: cold.runs },
      warm: { median: warm.median, runs: warm.runs },
    })),
    runs: RUNS,
  };
  await writeFile(
    path.join(out, 'share-pages.json'),
    `${JSON.stringify(snapshot, null, 2)}\n`
  );
  const markdown = summary(results);
  await writeFile(path.join(out, 'summary.md'), markdown);
  console.log(markdown);
  failed =
    results.forged.length > 0 ||
    results.pages.some((item) => item.cache.failures.length > 0);
} finally {
  await cleanUp(page).catch((error) => {
    console.error('Cleanup failed:', error);
    failed = true;
  });
  await browser.close();
}
process.exit(failed ? 1 : 0);
