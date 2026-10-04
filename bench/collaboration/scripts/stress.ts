/**
 * Collaboration stress test: STRESS_PEERS peers type into one Office room
 * (exchange-plan.docx) and one Plate room for STRESS_MINUTES, some of them
 * dropping offline and rejoining while they keep typing, against the e2e
 * Docker stack (deploy/docker-compose.e2e.yml plus docker-compose.stress.yml,
 * started and torn down through e2e/global-setup.ts).
 *
 * Checks (a failed one exits 1, a missed budget alone exits 2):
 * - every peer of a room ends with the same document, and so does a fresh
 *   peer that joins afterwards (the room converged on the server);
 * - every marker a peer typed is in that final document exactly once;
 * - the collaboration service logged no errors;
 * - p95 of marker latency (typed by one peer, seen by a watching peer that
 *   never drops) is within the provisional budget.
 *
 * Run: pnpm bench:stress (Docker required; E2E_PREBUILT_IMAGES=true reuses the
 * capy-e2e-* images, E2E_SKIP_COMPOSE=true with the E2E_* variables a running
 * stack). Results: bench/collaboration/.results/stress.json.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HocuspocusProvider,
  type HocuspocusProviderConfiguration,
} from '@hocuspocus/provider';
import * as Y from 'yjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PEERS = Number(process.env.STRESS_PEERS ?? 20);
const MINUTES = Number(process.env.STRESS_MINUTES ?? 3);
// Mean delay between one peer's edits.
const EDIT_MS = Number(process.env.STRESS_EDIT_MS ?? 1500);
// Per peer and second, the chance of dropping offline for 1-5 s.
const DROP_PER_SECOND = Number(process.env.STRESS_DROP_PER_SECOND ?? 0.02);
/**
 * Provisional: ~1.3x the slower room's median p95 of three local runs
 * (2026-10-04, M-series Mac, load 3-17: Office 26/26/15 ms, Plate 35/27/19 ms);
 * recalibrate from three runs of the Performance workflow's stress job.
 */
const P95_BUDGET_MS = Number(process.env.STRESS_P95_BUDGET_MS ?? 35);
const OUT = process.env.STRESS_OUT ?? path.join(root, 'bench/collaboration/.results');
const WORKSPACE = 'ws_e2e_edit';
const OWNER = 'u_owner';
const MARKER = /\[[op]\d{2}-\d{4}\]/g;

const randomPort = () => randomInt(20_000, 45_000);
process.env.E2E_API_PORT ??= String(randomPort());
process.env.E2E_COLLABORATION_PORT ??= String(randomPort());
process.env.E2E_DB_PORT ??= String(randomPort());
process.env.E2E_API_URL ??= `http://127.0.0.1:${process.env.E2E_API_PORT}`;
// The collaboration service only admits this origin (COLLABORATION_ALLOWED_ORIGINS).
process.env.E2E_BASE_URL ??= 'http://127.0.0.1:5174';
process.env.E2E_COMPOSE_PROJECT ??= `capy-stress-${randomBytes(3).toString('hex')}`;
process.env.E2E_AUTH_SECRET ??= randomBytes(32).toString('hex');
process.env.SHARE_LINK_SECRET ||= randomBytes(32).toString('hex');
process.env.STRESS_FAKE_S3 = path.join(root, 'bench/collaboration/scripts/fake-s3.mjs');
// The fake S3's certificate, for the name docker-compose.stress.yml gives it.
const tlsDir = mkdtempSync(path.join(tmpdir(), 'capy-stress-tls-'));
const openssl = spawnSync(
  'openssl',
  [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-subj', '/CN=s3.stress.backblazeb2.com',
    '-addext', 'subjectAltName=DNS:s3.stress.backblazeb2.com',
    '-keyout', path.join(tlsDir, 'key.pem'), '-out', path.join(tlsDir, 'cert.pem'),
  ],
  { encoding: 'utf8' }
);
if (openssl.status !== 0) throw new Error(`openssl failed: ${openssl.stderr}`);
// Readable by the images' non-root users.
for (const file of ['key.pem', 'cert.pem']) chmodSync(path.join(tlsDir, file), 0o644);
chmodSync(tlsDir, 0o755);
process.env.STRESS_TLS_DIR = tlsDir;
process.env.E2E_COMPOSE_OVERRIDES = path.join(
  root,
  'bench/collaboration/scripts/docker-compose.stress.yml'
);
const apiUrl = process.env.E2E_API_URL;
const origin = process.env.E2E_BASE_URL;
const headers = {
  'X-E2E-Secret': process.env.E2E_AUTH_SECRET,
  'X-E2E-User-Id': OWNER,
};

type Kind = 'office' | 'plate';
interface Room {
  kind: Kind;
  tokenPath: string;
  /** Markers typed into this room: when, and whether the peer was online. */
  typed: Map<string, { at: number; online: boolean }>;
  /** When the watching peer first saw each marker. */
  seen: Map<string, number>;
}

async function api(method: string, route: string, body?: BodyInit, json?: unknown) {
  const response = await fetch(`${apiUrl}${route}`, {
    body: json === undefined ? body : JSON.stringify(json),
    headers: {
      ...headers,
      ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    method,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`${method} ${route}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<Record<string, unknown>>;
}

async function createRooms(): Promise<Room[]> {
  const material = await api('POST', `/api/workspaces/${WORKSPACE}/materials`, undefined, {
    content: {
      schemaVersion: 1,
      value: Array.from({ length: 5 }, (_, index) => ({
        children: [{ text: `Stress paragraph ${index + 1} has some text to type into.` }],
        id: `stress_p${index}`,
        type: 'p',
      })),
    },
    kind: 'note',
    title: `Stress ${randomBytes(3).toString('hex')}`,
  });
  const bytes = await readFile(
    path.join(root, 'e2e/fixtures/files/rich-content/exchange-plan.docx')
  );
  const form = new FormData();
  form.append('file', new Blob([bytes]), 'exchange-plan.docx');
  form.append('name', `stress-${randomBytes(3).toString('hex')}.docx`);
  const file = await api('POST', `/api/workspaces/${WORKSPACE}/sources`, form);
  return [
    { kind: 'office', seen: new Map(), tokenPath: `/api/files/${file.id}/collaboration-token`, typed: new Map() },
    { kind: 'plate', seen: new Map(), tokenPath: `/api/materials/${material.id}/collaboration-token`, typed: new Map() },
  ];
}

/** The text a room's peers type into: the DOCX body story, or the Plate tree. */
function typingTarget(room: Room, doc: Y.Doc): Y.Text | null {
  if (room.kind === 'office') {
    const body = doc.getMap('stories').get('body');
    return body instanceof Y.Text ? body : null;
  }
  return doc.get('content', Y.XmlText);
}

/** The room's characters in document order (DOCX paragraph marks and Plate
 * element boundaries left out). */
function roomText(room: Room, doc: Y.Doc) {
  return runs(room, doc)
    .map((run) => run.value)
    .join('');
}

/**
 * Text runs a marker may go into: DOCX body runs, or Plate paragraph runs,
 * each with its Y.Text and the run's start index in it.
 */
function runs(room: Room, doc: Y.Doc) {
  const target = typingTarget(room, doc);
  if (!target) return [];
  const out: { text: Y.Text; start: number; value: string }[] = [];
  const collect = (text: Y.Text) => {
    let at = 0;
    for (const op of text.toDelta() as { insert: unknown }[]) {
      if (typeof op.insert === 'string') {
        out.push({ start: at, text, value: op.insert });
        at += op.insert.length;
      } else {
        if (room.kind === 'plate' && op.insert instanceof Y.XmlText) collect(op.insert);
        at += 1;
      }
    }
  };
  collect(target);
  return out;
}

/** Inside a run, never inside a marker already there, so markers stay whole. */
function insertMarker(room: Room, doc: Y.Doc, marker: string) {
  const candidates = runs(room, doc).filter((run) => run.value.length >= 2);
  if (!candidates.length) return false;
  const run = candidates[randomInt(candidates.length)];
  const blocked = new Set<number>();
  for (const match of run.value.matchAll(MARKER))
    for (let at = match.index + 1; at < match.index + match[0].length; at += 1) blocked.add(at);
  const offsets = Array.from({ length: run.value.length - 1 }, (_, i) => i + 1).filter(
    (offset) => !blocked.has(offset)
  );
  if (!offsets.length) return false;
  run.text.insert(run.start + offsets[randomInt(offsets.length)], marker);
  return true;
}

class OriginWebSocket extends WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    // Node's WebSocket takes headers; the browser one sends Origin itself.
    super(url, { headers: { Origin: origin }, protocols } as unknown as string[]);
  }
}

interface Peer {
  doc: Y.Doc;
  provider: HocuspocusProvider;
}

async function connect(room: Room, name: string): Promise<Peer> {
  const doc = new Y.Doc();
  const first = (await api('POST', room.tokenPath)) as { token: string; url: string; room: string };
  let token: string | null = first.token;
  const provider = new HocuspocusProvider({
    document: doc,
    name: first.room,
    // A reconnect asks the API for a fresh token, as the app does.
    token: async () => {
      const value = token ?? ((await api('POST', room.tokenPath)) as { token: string }).token;
      token = null;
      return value;
    },
    url: first.url,
    WebSocketPolyfill: OriginWebSocket,
  } as HocuspocusProviderConfiguration);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} did not sync in 60 s`)), 60_000);
    provider.on('synced', () => {
      clearTimeout(timer);
      resolve();
    });
    provider.on('authenticationFailed', ({ reason }: { reason: string }) =>
      reject(new Error(`${name}: authentication failed: ${reason}`))
    );
  });
  return { doc, provider };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms: number) {
  for (const started = Date.now(); Date.now() - started < ms; await sleep(250))
    if (check()) return true;
  return check();
}

function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);
}

const online = ({ provider }: Peer) =>
  (provider.configuration.websocketProvider as { status: string }).status === 'connected';

async function stressRoom(room: Room) {
  const watcher = await connect(room, `${room.kind} watcher`);
  // Only the inserted text of each change is scanned, so the watcher's cost
  // stays flat as the room grows and the latency is the server's.
  const target = typingTarget(room, watcher.doc);
  if (!target) throw new Error(`${room.kind}: no text to type into`);
  target.observeDeep((events) => {
    const now = Date.now();
    for (const event of events)
      for (const op of event.delta)
        if (typeof op.insert === 'string')
          for (const [marker] of op.insert.matchAll(MARKER))
            if (!room.seen.has(marker)) room.seen.set(marker, now);
  });
  const peers = await Promise.all(
    Array.from({ length: PEERS }, (_, index) => connect(room, `${room.kind} peer ${index}`))
  );
  const deadline = Date.now() + MINUTES * 60_000;
  let drops = 0;
  await Promise.all(
    peers.map(async (peer, index) => {
      let sequence = 0;
      let offlineUntil = 0;
      while (Date.now() < deadline) {
        await sleep(randomInt(EDIT_MS / 2, (EDIT_MS * 3) / 2));
        const now = Date.now();
        if (offlineUntil && now >= offlineUntil) {
          offlineUntil = 0;
          void peer.provider.connect();
        } else if (!offlineUntil && Math.random() < (DROP_PER_SECOND * EDIT_MS) / 1000) {
          // Keeps typing offline; the edits go out on reconnect.
          drops += 1;
          offlineUntil = now + randomInt(1000, 5000);
          peer.provider.disconnect();
        }
        const marker = `[${room.kind[0]}${String(index).padStart(2, '0')}-${String(sequence).padStart(4, '0')}]`;
        // Timed only when the peer is connected and synced: one typed while
        // reconnecting also waits for the token, the socket and the sync.
        const live = !offlineUntil && online(peer) && peer.provider.isSynced;
        if (insertMarker(room, peer.doc, marker)) {
          room.typed.set(marker, { at: Date.now(), online: live });
          sequence += 1;
        }
      }
    })
  );
  const everyone = [watcher, ...peers];
  // Brings back peers that ended offline. A close still in flight leaves the
  // status connected for a moment, so this retries until the socket is up.
  const settled = await until(() => {
    for (const peer of peers) if (!online(peer)) void peer.provider.connect();
    return everyone.every(
      (peer) => online(peer) && peer.provider.isSynced && !peer.provider.hasUnsyncedChanges
    );
  }, 120_000);
  const texts = () => everyone.map(({ doc }) => roomText(room, doc));
  const converged = await until(() => new Set(texts()).size === 1, 60_000);
  const fresh = await connect(room, `${room.kind} late joiner`);
  const final = roomText(room, fresh.doc);
  const counts = new Map<string, number>();
  for (const [marker] of final.matchAll(MARKER)) counts.set(marker, (counts.get(marker) ?? 0) + 1);
  const missing = [...room.typed.keys()].filter((marker) => !counts.has(marker));
  const doubled = [...counts].filter(([, count]) => count > 1).map(([marker]) => marker);
  // Markers typed offline wait for the reconnect; only online ones are timed.
  // For a missing marker: how many peers still hold it (a loss on the server
  // when its own peer has it, synced).
  const heldBy = missing.slice(0, 5).map((marker) => ({
    marker,
    peers: everyone.filter(({ doc }) => roomText(room, doc).includes(marker)).length,
  }));
  const latencies = [...room.typed].flatMap(([marker, { at, online }]) => {
    const seen = room.seen.get(marker);
    return seen === undefined || !online ? [] : [seen - at];
  });
  for (const { doc, provider } of [...everyone, fresh]) {
    provider.destroy();
    doc.destroy();
  }
  return {
    converged: settled && converged && texts().every((text) => text === final),
    doubled: doubled.length,
    drops,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    latencyMaxMs: percentile(latencies, 100),
    missing: missing.length,
    missingSample: heldBy,
    room: room.kind,
    typed: room.typed.size,
  };
}

function collaborationErrors() {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '-f',
      path.join(root, 'deploy/docker-compose.e2e.yml'),
      '-f',
      process.env.E2E_COMPOSE_OVERRIDES!,
      '-p',
      process.env.E2E_COMPOSE_PROJECT!,
      'logs',
      '--no-color',
      '--no-log-prefix',
      'collaboration',
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20 }
  );
  if (result.status !== 0) throw new Error(`docker compose logs failed: ${result.stderr}`);
  return result.stdout.split('\n').filter((line) => {
    try {
      return (JSON.parse(line) as { level?: string }).level === 'error';
    } catch {
      // Text logs (the e2e stack sets no APP_ENV), uncaught errors, stacks.
      return /^error\b|Error:|Unhandled/.test(line);
    }
  });
}

const { default: setup } = await import('../../../e2e/global-setup');
const { default: teardown } = await import('../../../e2e/global-teardown');

let cleaned: Promise<void> | undefined;
// Once, from the end of the run or from a signal.
function cleanUp() {
  cleaned ??= (async () => {
    try {
      await teardown();
    } finally {
      rmSync(tlsDir, { force: true, recursive: true });
    }
  })();
  return cleaned;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    console.error(`${signal}: tearing the stack down`);
    void cleanUp().finally(() => process.exit(130));
  });

let exitCode = 1;
try {
  await setup();
  const rooms = await createRooms();
  const results = await Promise.all(rooms.map(stressRoom));
  const errors = collaborationErrors();
  const failures = [
    ...results.flatMap((room) => [
      ...(room.converged ? [] : [`${room.room}: peers did not converge`]),
      ...(room.missing ? [`${room.room}: ${room.missing} typed markers missing`] : []),
      ...(room.doubled ? [`${room.room}: ${room.doubled} markers duplicated`] : []),
    ]),
    ...(errors.length ? [`collaboration logged ${errors.length} errors`] : []),
  ];
  const budgetMisses = results.flatMap((room) =>
    (room.latencyP95Ms ?? Number.POSITIVE_INFINITY) > P95_BUDGET_MS
      ? [`${room.room}: p95 ${room.latencyP95Ms} ms over the provisional ${P95_BUDGET_MS} ms budget`]
      : []
  );
  const report = {
    budgetMisses,
    budgetP95Ms: P95_BUDGET_MS,
    collaborationErrors: errors.length,
    collaborationErrorSample: errors.slice(0, 10),
    editMs: EDIT_MS,
    failures,
    minutes: MINUTES,
    peers: PEERS,
    rooms: results,
  };
  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, 'stress.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  for (const problem of [...failures, ...budgetMisses]) console.error(`FAIL ${problem}`);
  exitCode = failures.length ? 1 : budgetMisses.length ? 2 : 0;
} finally {
  await cleanUp();
}
process.exit(exitCode);
