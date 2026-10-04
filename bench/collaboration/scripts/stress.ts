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
 *
 * STRESS_TARGET=uat runs against the UAT deployment instead (see uatTarget),
 * with the UAT journeys' variables (deploy/.env.uat):
 *   node --env-file=deploy/.env.uat --import tsx bench/collaboration/scripts/stress.ts
 * STRESS_ROOMS rooms (2), alternately Office and Plate, get STRESS_PEERS peers
 * each.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createClerkClient } from '@clerk/backend';
import {
  HocuspocusProvider,
  type HocuspocusProviderConfiguration,
} from '@hocuspocus/provider';
import * as Y from 'yjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REMOTE = process.env.STRESS_TARGET === 'uat';
if (process.env.STRESS_TARGET && !REMOTE) throw new Error('STRESS_TARGET must be uat or unset');
const ROOMS = Number(process.env.STRESS_ROOMS ?? 2);
const PEERS = Number(process.env.STRESS_PEERS ?? 20);
const MINUTES = Number(process.env.STRESS_MINUTES ?? 3);
// Mean delay between one peer's edits.
const EDIT_MS = Number(process.env.STRESS_EDIT_MS ?? 1500);
// Per peer and second, the chance of dropping offline for 1-5 s.
const DROP_PER_SECOND = Number(process.env.STRESS_DROP_PER_SECOND ?? 0.02);
/**
 * Local: ~1.3x the slower room's median p95 over three runs of the Performance
 * workflow (2026-10-04: Office 5/5/3 ms, Plate 8/9/5 ms). Milliseconds with a
 * wide relative spread, so the CI job keeps continue-on-error. UAT: 1 s, the
 * ceiling the 2026-10-04 capacity run used, network round trip included.
 */
const P95_BUDGET_MS = Number(process.env.STRESS_P95_BUDGET_MS ?? (REMOTE ? 1000 : 10));
const OUT = process.env.STRESS_OUT ?? path.join(root, 'bench/collaboration/.results');
const MARKER = /\[[op]\d{2}-\d{4}\]/g;

type Kind = 'office' | 'plate';
interface RoomToken {
  token: string;
  url: string;
  room: string;
}
interface Room {
  kind: Kind;
  /** A fresh room token, as the app asks for one on every (re)connect. */
  token: () => Promise<RoomToken>;
  /** Markers typed into this room: when, and whether the peer was online. */
  typed: Map<string, { at: number; online: boolean }>;
  /** When the watching peer first saw each marker. */
  seen: Map<string, number>;
}
/** Where the rooms live: the local e2e stack or UAT. */
interface Target {
  /** The app origin the collaboration service admits. */
  origin: string;
  setup(): Promise<void>;
  createRooms(count: number): Promise<Room[]>;
  /** Collaboration error lines logged since setup. */
  collaborationErrors(): string[];
  cleanUp(): Promise<void>;
}
type Call = (
  method: string,
  route: string,
  body?: BodyInit,
  json?: unknown
) => Promise<Record<string, unknown>>;

async function request(
  base: string,
  headers: Record<string, string>,
  method: string,
  route: string,
  body?: BodyInit,
  json?: unknown
) {
  const response = await fetch(`${base}${route}`, {
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
  return response.status === 204
    ? {}
    : (response.json() as Promise<Record<string, unknown>>);
}

/** The note and the uploaded DOCX of one workspace, kinds alternating. */
async function createWorkspaceRooms(
  call: Call,
  workspace: string,
  kinds: Kind[],
  uploadFields: Record<string, string> = {}
): Promise<Room[]> {
  const docx = await readFile(
    path.join(root, 'e2e/fixtures/files/rich-content/exchange-plan.docx')
  );
  const rooms: Room[] = [];
  for (const kind of kinds) {
    let tokenPath: string;
    if (kind === 'plate') {
      const material = await call('POST', `/api/workspaces/${workspace}/materials`, undefined, {
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
      tokenPath = `/api/materials/${material.id}/collaboration-token`;
    } else {
      const form = new FormData();
      form.append('file', new Blob([docx]), 'exchange-plan.docx');
      form.append('name', `stress-${randomBytes(3).toString('hex')}.docx`);
      for (const [name, value] of Object.entries(uploadFields)) form.append(name, value);
      const file = await call('POST', `/api/workspaces/${workspace}/sources`, form);
      tokenPath = `/api/files/${file.id}/collaboration-token`;
    }
    rooms.push({
      kind,
      seen: new Map(),
      token: async () => (await call('POST', tokenPath)) as unknown as RoomToken,
      typed: new Map(),
    });
  }
  return rooms;
}

const kindsFor = (count: number) =>
  Array.from({ length: count }, (_, index): Kind => (index % 2 ? 'plate' : 'office'));

/** Error lines of collaboration logs: JSON level error, or text error lines. */
function errorLines(logs: string) {
  return logs.split('\n').filter((line) => {
    try {
      return (JSON.parse(line) as { level?: string }).level === 'error';
    } catch {
      // Text logs (the e2e stack sets no APP_ENV), uncaught errors, stacks.
      return /^error\b|Error:|Unhandled/.test(line);
    }
  });
}

/**
 * The e2e Docker stack through e2e/global-setup.ts, with
 * docker-compose.stress.yml's fake S3 for the DOCX; every room lives in the
 * seeded editable workspace and every peer is its owner.
 */
async function localTarget(): Promise<Target> {
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
  const headers = {
    'X-E2E-Secret': process.env.E2E_AUTH_SECRET,
    'X-E2E-User-Id': 'u_owner',
  };
  const call: Call = (...args) => request(process.env.E2E_API_URL!, headers, ...args);
  const { default: setup } = await import('../../../e2e/global-setup');
  const { default: teardown } = await import('../../../e2e/global-teardown');
  return {
    origin: process.env.E2E_BASE_URL,
    setup,
    createRooms: (count) => createWorkspaceRooms(call, 'ws_e2e_edit', kindsFor(count)),
    collaborationErrors() {
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
      return errorLines(result.stdout);
    },
    async cleanUp() {
      try {
        await teardown();
      } finally {
        rmSync(tlsDir, { force: true, recursive: true });
      }
    },
  };
}

const UAT = {
  api: 'https://uat-api.capynotebook.com',
  app: 'https://app.uat.capynotebook.com',
  collab: 'wss://uat-collab.capynotebook.com',
};

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for STRESS_TARGET=uat`);
  return value;
}

/** One disposable Clerk user with a Frontend API session (native client). */
interface UatUser {
  id: string;
  email: string;
  sessionId: string;
  /** The native client's credential, sent as Authorization to the FAPI. */
  client: string;
  jwt: string;
  jwtAt: number;
  refreshing?: Promise<string>;
  workspace?: string;
}

/**
 * The UAT deployment with the UAT journeys' configuration and identities
 * (e2e/uat/journeys): Clerk test-mode users created with the backend API and
 * the run id in their private metadata, signed in with a sign-in ticket under
 * Clerk's testing token, as createSecondaryActor does in a browser, here over
 * the Frontend API as a native client. Each Office and Plate room pair gets
 * its own user and workspace, so no user nears the gateway's per-user limit.
 *
 * Nothing it creates reaches the ingest host: the workspace's auto process is
 * off before its note exists (no note index), and the DOCX is a store-only
 * upload (parseMode none), never parsed and published export-only by the
 * collaboration service. Cleanup deletes the workspaces, then the users.
 *
 * Collaboration errors come from the host's logs over SSH (STRESS_UAT_SSH,
 * user@host, with STRESS_UAT_SSH_KEY when the agent has no key).
 */
async function uatTarget(): Promise<Target> {
  if (required('UAT_TARGET_AUTHORIZED') !== 'true')
    throw new Error('UAT_TARGET_AUTHORIZED must be exactly true');
  if (required('UAT_CLERK_TEST_MODE') !== 'true')
    throw new Error('UAT_CLERK_TEST_MODE must be exactly true');
  for (const [name, expected] of [
    ['UAT_API_URL', UAT.api],
    ['UAT_APP_URL', UAT.app],
    ['UAT_COLLAB_URL', UAT.collab],
  ])
    if (required(name).replace(/\/$/, '') !== expected)
      throw new Error(`${name} must select ${expected}`);
  const domain = required('UAT_ACTOR_EMAIL_DOMAIN');
  const ssh = required('STRESS_UAT_SSH');
  const sshArgs = [
    '-o', 'BatchMode=yes',
    ...(process.env.STRESS_UAT_SSH_KEY ? ['-i', process.env.STRESS_UAT_SSH_KEY] : []),
    ssh,
  ];
  const onHost = (command: string) => {
    const result = spawnSync('ssh', [...sshArgs, command], {
      encoding: 'utf8',
      maxBuffer: 256 << 20,
    });
    if (result.status !== 0) throw new Error(`ssh ${command}: ${result.stderr}`);
    return result;
  };
  const collaboration = '$(docker ps -q --filter name=^collaboration-)';
  // Store and authentication failures are counted but not always logged.
  const failureCounters = () =>
    Object.fromEntries(
      onHost(
        `docker exec ${collaboration} node -e 'fetch("http://127.0.0.1:1234/metrics").then((r) => r.text()).then(console.log)'`
      )
        .stdout.split('\n')
        .filter((line) => /_failures_total /.test(line))
        .map((line) => {
          const [name, value] = line.split(' ');
          return [name, Number(value)];
        })
    );
  let countersBefore: Record<string, number> = {};
  const clerk = createClerkClient({ secretKey: required('CLERK_SECRET_KEY') });
  const fapi = `https://${Buffer.from(
    required('CLERK_PUBLISHABLE_KEY').replace(/^pk_(test|live)_/, ''),
    'base64'
  )
    .toString()
    .replace(/\$$/, '')}`;
  const run = `stress${randomBytes(4).toString('hex')}`;
  const users: UatUser[] = [];
  let since = '';
  let testing = await clerk.testingTokens.createTestingToken();
  const testingToken = async () => {
    if (testing.expiresAt * 1000 < Date.now() + 5000)
      testing = await clerk.testingTokens.createTestingToken();
    return testing.token;
  };
  const manifest = () =>
    writeFile(
      path.join(OUT, 'uat-resources.json'),
      `${JSON.stringify({ run, users: users.map(({ email, id, workspace }) => ({ email, id, workspace })) }, null, 2)}\n`
    );

  async function signUp(label: string): Promise<UatUser> {
    const email = `uat-${run}-${label}-${randomBytes(4).toString('hex')}+clerk_test@${domain}`;
    const created = await clerk.users.createUser({
      emailAddress: [email],
      password: `Uat!${randomBytes(24).toString('base64url')}7`,
      privateMetadata: { capyUatRunId: run },
    });
    const pending = { email, id: created.id } as UatUser;
    users.push(pending);
    await manifest();
    const ticket = await clerk.signInTokens.createSignInToken({
      expiresInSeconds: 60,
      userId: created.id,
    });
    let response: Response;
    // Clerk limits sign-ins per IP; setup waits out its Retry-After.
    for (let attempt = 1; ; attempt += 1) {
      response = await fetch(
        `${fapi}/v1/client/sign_ins?_is_native=1&__clerk_testing_token=${await testingToken()}`,
        {
          body: new URLSearchParams({ strategy: 'ticket', ticket: ticket.token }),
          // Origin makes the session token's azp the app, as in the browser.
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: UAT.app },
          method: 'POST',
          signal: AbortSignal.timeout(30_000),
        }
      );
      if (response.status !== 429 || attempt === 5) break;
      await sleep(1000 * Number(response.headers.get('retry-after') ?? 10));
    }
    const body = (await response.json()) as {
      response?: { status?: string; created_session_id?: string };
      client?: { sessions?: { id: string; last_active_token?: { jwt?: string } }[] };
    };
    const sessionId = body.response?.created_session_id;
    const jwt = body.client?.sessions?.find(({ id }) => id === sessionId)?.last_active_token?.jwt;
    const client = response.headers.get('authorization');
    if (!response.ok || body.response?.status !== 'complete' || !sessionId || !jwt || !client)
      throw new Error(`${label}: Clerk ticket sign-in failed (${response.status})`);
    return Object.assign(pending, { client, jwt, jwtAt: Date.now(), sessionId });
  }

  // Session tokens live 60 s; a native client refreshes with its credential
  // alone (the FAPI refuses Origin and Authorization together).
  function bearer(user: UatUser) {
    if (Date.now() - user.jwtAt < 40_000) return Promise.resolve(user.jwt);
    user.refreshing ??= (async () => {
      try {
        const response = await fetch(
          `${fapi}/v1/client/sessions/${user.sessionId}/tokens?_is_native=1&__clerk_testing_token=${await testingToken()}`,
          { headers: { Authorization: user.client }, method: 'POST', signal: AbortSignal.timeout(30_000) }
        );
        const { jwt } = (await response.json()) as { jwt?: string };
        if (!response.ok || !jwt) throw new Error(`Clerk session refresh failed (${response.status})`);
        Object.assign(user, { jwt, jwtAt: Date.now() });
        return jwt;
      } finally {
        user.refreshing = undefined;
      }
    })();
    return user.refreshing;
  }

  const callAs =
    (user: UatUser): Call =>
    async (...args) =>
      request(UAT.api, { Authorization: `Bearer ${await bearer(user)}` }, ...args);

  return {
    origin: UAT.app,
    async setup() {
      await mkdir(OUT, { recursive: true });
      const health = await fetch(`${UAT.api}/healthz`, { signal: AbortSignal.timeout(10_000) });
      if (!health.ok) throw new Error(`UAT API unhealthy: ${health.status}`);
      console.error(`uat run ${run}, release ${health.headers.get('x-capy-release')}`);
      since = new Date().toISOString();
      countersBefore = failureCounters();
    },
    async createRooms(count) {
      const kinds = kindsFor(count);
      const pairs = Array.from({ length: Math.ceil(count / 2) }, (_, index) =>
        kinds.slice(index * 2, index * 2 + 2)
      );
      // One sign-in at a time, under Clerk's per-IP limit.
      const signedUp: UatUser[] = [];
      for (const index of pairs.keys()) signedUp.push(await signUp(`u${index}`));
      const rooms = await Promise.all(
        pairs.map(async (pairKinds, index) => {
          const user = signedUp[index];
          const call = callAs(user);
          await call('GET', '/api/me');
          const workspace = await call('POST', '/api/workspaces', undefined, {
            name: `Stress ${run} ${index}`,
          });
          user.workspace = String(workspace.id);
          await manifest();
          // Off before the note exists: a new workspace note is dirty from creation.
          const patched = await call('PATCH', `/api/workspaces/${user.workspace}`, undefined, {
            autoProcess: false,
          });
          if (patched.autoProcess !== false)
            throw new Error(`${user.workspace}: auto process is still on`);
          return createWorkspaceRooms(call, user.workspace, pairKinds, { parseMode: 'none' });
        })
      );
      return rooms.flat();
    },
    collaborationErrors() {
      const logs = onHost(`docker logs --since ${since} ${collaboration}`);
      const counters = Object.entries(failureCounters()).flatMap(([name, value]) =>
        value > (countersBefore[name] ?? 0)
          ? [`${name} +${value - (countersBefore[name] ?? 0)}`]
          : []
      );
      return [...errorLines(`${logs.stdout}\n${logs.stderr}`), ...counters];
    },
    async cleanUp() {
      const failures: string[] = [];
      for (const user of users) {
        try {
          if (user.workspace && user.jwt)
            await callAs(user)('DELETE', `/api/workspaces/${user.workspace}`);
        } catch (error) {
          failures.push(`${user.workspace}: ${String(error)}`);
        }
        try {
          // The journeys' ownership check before a Clerk deletion.
          const clerkUser = await clerk.users.getUser(user.id);
          if (
            clerkUser.privateMetadata.capyUatRunId !== run ||
            !clerkUser.emailAddresses.some(({ emailAddress }) => emailAddress === user.email)
          )
            throw new Error('ownership does not match the run');
          await clerk.users.deleteUser(user.id);
        } catch (error) {
          failures.push(`${user.id}: ${String(error)}`);
        }
      }
      if (failures.length) {
        console.error(`UAT cleanup left resources (see ${OUT}/uat-resources.json):\n${failures.join('\n')}`);
        throw new Error('UAT cleanup failed');
      }
    },
  };
}

const target = REMOTE ? await uatTarget() : await localTarget();

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
    super(url, { headers: { Origin: target.origin }, protocols } as unknown as string[]);
  }
}

interface Peer {
  doc: Y.Doc;
  provider: HocuspocusProvider;
}

// Joins at most this many peers at once on UAT, so a step ramps up instead of
// sending every token request and initial sync in the same instant.
let joining = 0;
/** Reconnect token requests that failed (a peer then stays offline). */
const tokenFailures: string[] = [];
const joinQueue: (() => void)[] = [];
const JOIN_CONCURRENCY = REMOTE ? 16 : Number.POSITIVE_INFINITY;

async function connect(room: Room, name: string): Promise<Peer> {
  while (joining >= JOIN_CONCURRENCY) await new Promise<void>((resolve) => joinQueue.push(resolve));
  joining += 1;
  try {
    return await join(room, name);
  } finally {
    joining -= 1;
    joinQueue.shift()?.();
  }
}

async function join(room: Room, name: string): Promise<Peer> {
  const doc = new Y.Doc();
  const first = await room.token();
  let token: string | null = first.token;
  const provider = new HocuspocusProvider({
    document: doc,
    name: first.room,
    // A reconnect asks the API for a fresh token, as the app does.
    token: async () => {
      try {
        const value = token ?? (await room.token()).token;
        token = null;
        return value;
      } catch (error) {
        tokenFailures.push(`${name}: ${String(error).slice(0, 200)}`);
        throw error;
      }
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

const status = ({ provider }: Peer) =>
  (provider.configuration.websocketProvider as { status: string }).status;
const online = (peer: Peer) => status(peer) === 'connected';
const settledPeer = (peer: Peer) =>
  online(peer) && peer.provider.isSynced && !peer.provider.hasUnsyncedChanges;

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
  // status connected for a moment, so this retries until the socket is up;
  // only a disconnected one, since connect() restarts a connection still
  // opening, which over a real network takes longer than this poll.
  const settled = await until(() => {
    for (const peer of peers) if (status(peer) === 'disconnected') void peer.provider.connect();
    return everyone.every(settledPeer);
  }, 120_000);
  const unsettled = everyone.filter((peer) => !settledPeer(peer)).length;
  const texts = () => everyone.map(({ doc }) => roomText(room, doc));
  const converged = await until(() => new Set(texts()).size === 1, 60_000);
  // A late joiner that cannot sync fails the room but keeps the report: the
  // markers are then counted in the watcher's copy.
  let fresh: Peer | undefined;
  let lateJoinError: string | null = null;
  try {
    fresh = await connect(room, `${room.kind} late joiner`);
  } catch (error) {
    lateJoinError = error instanceof Error ? error.message : String(error);
  }
  const final = roomText(room, (fresh ?? watcher).doc);
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
  for (const { doc, provider } of [...everyone, ...(fresh ? [fresh] : [])]) {
    provider.destroy();
    doc.destroy();
  }
  return {
    converged: settled && converged && texts().every((text) => text === final),
    doubled: doubled.length,
    drops,
    latencies,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    latencyMaxMs: percentile(latencies, 100),
    lateJoinError,
    missing: missing.length,
    missingSample: heldBy,
    // Peers still offline, unsynced or holding unsent changes after 120 s.
    unsettled,
    room: room.kind,
    typed: room.typed.size,
  };
}

let cleaned: Promise<void> | undefined;
// Once, from the end of the run or from a signal.
function cleanUp() {
  cleaned ??= target.cleanUp();
  return cleaned;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    console.error(`${signal}: cleaning up`);
    void cleanUp().finally(() => process.exit(130));
  });

// The client's own event-loop delay: high values mean this process, not the
// server, delayed the markers it timed.
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
let exitCode = 1;
try {
  await target.setup();
  const rooms = await target.createRooms(ROOMS);
  loopDelay.enable();
  const settledRooms = await Promise.allSettled(rooms.map(stressRoom));
  loopDelay.disable();
  const results = settledRooms.flatMap((room) => (room.status === 'fulfilled' ? [room.value] : []));
  // An unreadable log is a failure of its own; the room results still count.
  let errors: string[];
  try {
    errors = target.collaborationErrors();
  } catch (error) {
    errors = [`collaboration errors unreadable: ${String(error).slice(0, 300)}`];
  }
  const failures = [
    ...settledRooms.flatMap((room, index) =>
      room.status === 'rejected'
        ? [`${rooms[index].kind} ${index}: ${String(room.reason).slice(0, 300)}`]
        : []
    ),
    ...results.flatMap((room, index) => [
      ...(room.lateJoinError ? [`${room.room} ${index}: ${room.lateJoinError}`] : []),
      ...(room.converged ? [] : [`${room.room} ${index}: peers did not converge`]),
      ...(room.missing ? [`${room.room} ${index}: ${room.missing} typed markers missing`] : []),
      ...(room.doubled ? [`${room.room} ${index}: ${room.doubled} markers duplicated`] : []),
    ]),
    ...(errors.length ? [`collaboration logged ${errors.length} errors`] : []),
  ];
  const kinds = [...new Set(results.map(({ room }) => room))];
  // Per room kind over every room of that kind, each marker counted once.
  const byKind = Object.fromEntries(
    kinds.map((kind) => {
      const latencies = results.filter(({ room }) => room === kind).flatMap((room) => room.latencies);
      return [
        kind,
        {
          latencyMaxMs: percentile(latencies, 100),
          latencyP50Ms: percentile(latencies, 50),
          latencyP95Ms: percentile(latencies, 95),
          latencyP99Ms: percentile(latencies, 99),
          rooms: results.filter(({ room }) => room === kind).length,
          timed: latencies.length,
        },
      ];
    })
  );
  const budgetMisses = Object.entries(byKind).flatMap(([kind, { latencyP95Ms }]) =>
    (latencyP95Ms ?? Number.POSITIVE_INFINITY) > P95_BUDGET_MS
      ? [`${kind}: p95 ${latencyP95Ms} ms over the ${P95_BUDGET_MS} ms budget`]
      : []
  );
  const report = {
    budgetMisses,
    budgetP95Ms: P95_BUDGET_MS,
    byKind,
    clientLoopDelayMs: {
      max: Math.round(loopDelay.max / 1e6),
      p50: Math.round(loopDelay.percentile(50) / 1e6),
      p99: Math.round(loopDelay.percentile(99) / 1e6),
    },
    collaborationErrors: errors.length,
    collaborationErrorSample: errors.slice(0, 10),
    editMs: EDIT_MS,
    failures,
    minutes: MINUTES,
    peers: PEERS,
    rooms: results.map(({ latencies: _, ...room }) => room),
    target: REMOTE ? 'uat' : 'local',
    tokenFailures: tokenFailures.length,
    tokenFailureSample: tokenFailures.slice(0, 5),
  };
  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, 'stress.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  for (const problem of [...failures, ...budgetMisses]) console.error(`FAIL ${problem}`);
  exitCode = failures.length ? 1 : budgetMisses.length ? 2 : 0;
} catch (error) {
  // Logged here, since a failing cleanUp would replace it.
  console.error(error);
} finally {
  await cleanUp();
}
process.exit(exitCode);
