/**
 * Collaboration stress test: STRESS_PEERS peers type into one Office room
 * (exchange-plan.docx) and one Plate room for STRESS_MINUTES, some of them
 * dropping offline and rejoining while they keep typing, against the e2e
 * Docker stack (deploy/docker-compose.e2e.yml plus docker-compose.stress.yml,
 * started and torn down through e2e/global-setup.ts). A second phase then does
 * the same with STRESS_LIMIT_PEERS peers in the near-limit rooms
 * (STRESS_LIMIT_ROOMS): the ~2 MB load-test note and a STRESS_TEXT_MIB text
 * source, reported but not budgeted, and run apart so their cost does not
 * move the first phase's latency.
 *
 * Checks (a failed one exits 1, a missed budget alone exits 2):
 * - every peer of a room ends with the same document, and so does a fresh
 *   peer that joins afterwards (the room converged on the server);
 * - every marker a peer typed is in that final document exactly once;
 * - the collaboration service logged no errors;
 * - p95 of marker latency (typed by one peer, seen by a watching peer that
 *   never drops) is within the provisional budget (first phase only).
 *
 * Run: pnpm bench:stress (Docker required; E2E_PREBUILT_IMAGES=true reuses the
 * capy-e2e-* images, E2E_SKIP_COMPOSE=true with the E2E_* variables a running
 * stack). Results: bench/collaboration/.results/stress.json.
 *
 * STRESS_TARGET=uat runs against the UAT deployment instead (see uatTarget),
 * with the UAT journeys' variables (deploy/.env.uat):
 *   node --env-file=deploy/.env.uat --import tsx bench/collaboration/scripts/stress.ts
 * STRESS_ROOMS rooms (2), alternately Office and Plate, get STRESS_PEERS peers
 * each. UAT and external stacks skip the near-limit phase unless
 * STRESS_LIMIT_ROOMS names it (a text source is indexed even when stored only).
 *
 * Capacity runs (bench/collaboration/reports/2026-10-05-prod-capacity.md):
 * - STRESS_STACK=external uses a stack someone else started and tears down
 *   (E2E_API_URL, seeded), and leaves its logs to that harness;
 * - STRESS_KINDS (office,plate) is the kinds the rooms cycle through;
 * - STRESS_OFFICE_FILES (the DOCX fixture) is the files, relative to the
 *   repository, Office rooms cycle through: DOCX and PPTX peers type into
 *   story text, XLSX peers write their own cells of the first sheet;
 * - STRESS_JOIN_CONCURRENCY caps peers joining at once (16 on UAT);
 * - STRESS_IDLE=true keeps the peers connected without typing;
 * - STRESS_UPLOAD_ORIGIN replaces the origin of presigned upload URLs (the
 *   local stack sets it to the fake S3's published port).
 *
 * The collaboration server is measured from outside, so the same scenarios
 * judge any implementation that speaks the protocol (Hocuspocus/Yjs sync,
 * the `checkpoint-request` stateless message and its `checkpoint-persisted`
 * receipt, `/healthz`): the CPU time and working set of its containers
 * through the Docker Engine API (the local stack's `collaboration` and
 * `server` services; STRESS_SERVER_CONTAINER and STRESS_API_CONTAINER on an
 * external stack), and its answer time to `/healthz` every 100 ms under load,
 * which a blocked event loop or a starved scheduler delays. Per phase that
 * gives CPU per typed marker and memory; the cost windows (STRESS_COST_ROOMS,
 * local default every room kind) then take one room kind at a time with
 * STRESS_COST_PEERS peers (5): CPU and memory to load the room, CPU per
 * update over STRESS_COST_SECONDS (30) of typing (its debounced saves
 * included) and CPU per explicit save, idle CPU taken out. On the local stack
 * STRESS_COLLABORATION_IMAGE swaps the server image (docker-compose.stress.yml).
 */
import { randomBytes, randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { cpus, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createClerkClient } from '@clerk/backend';
import {
  HocuspocusProvider,
  type HocuspocusProviderConfiguration,
} from '@hocuspocus/provider';
import * as Y from 'yjs';
import { buildBiologyLoadTestValue } from '../../../src/mocks/noteContent/loadTest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REMOTE = process.env.STRESS_TARGET === 'uat';
const EXTERNAL = process.env.STRESS_STACK === 'external';
if (process.env.STRESS_STACK && !EXTERNAL) throw new Error('STRESS_STACK must be external or unset');
const KINDS = (process.env.STRESS_KINDS ?? 'office,plate').split(',') as Kind[];
if (!KINDS.length || KINDS.some((kind) => kind !== 'office' && kind !== 'plate'))
  throw new Error('STRESS_KINDS must list office and plate');
// The second phase's rooms, one each: the near-limit note and a text source.
const LIMIT_KINDS = (
  process.env.STRESS_LIMIT_ROOMS ?? (REMOTE || EXTERNAL ? '' : 'note-limit,text')
)
  .split(',')
  .filter(Boolean) as Kind[];
if (LIMIT_KINDS.some((kind) => kind !== 'note-limit' && kind !== 'text'))
  throw new Error('STRESS_LIMIT_ROOMS must list note-limit and text');
// Fewer peers than the first phase: before the per-update bound, the service
// measures the whole near-limit note on every update (~50-90 ms CPU each).
const LIMIT_PEERS = Number(process.env.STRESS_LIMIT_PEERS ?? 5);
// Two of these (the near-limit phase and its cost window) with their saved
// states stay well inside the e2e owner's 100 MB Free storage quota.
const TEXT_MIB = Number(process.env.STRESS_TEXT_MIB ?? 4);
// The cost windows: one room kind at a time, measured on the server.
const COST_KINDS = (
  process.env.STRESS_COST_ROOMS ?? (REMOTE || EXTERNAL ? '' : 'office,plate,note-limit,text')
)
  .split(',')
  .filter(Boolean) as Kind[];
if (COST_KINDS.some((kind) => !['office', 'plate', 'note-limit', 'text'].includes(kind)))
  throw new Error('STRESS_COST_ROOMS must list office, plate, note-limit and text');
const COST_PEERS = Number(process.env.STRESS_COST_PEERS ?? 5);
const COST_SECONDS = Number(process.env.STRESS_COST_SECONDS ?? 30);
const COST_SAVES = 3;
const OFFICE_FILES = (
  process.env.STRESS_OFFICE_FILES ?? 'e2e/fixtures/files/rich-content/exchange-plan.docx'
).split(',');
if (process.env.STRESS_TARGET && !REMOTE) throw new Error('STRESS_TARGET must be uat or unset');
const ROOMS = Number(process.env.STRESS_ROOMS ?? 2);
const PEERS = Number(process.env.STRESS_PEERS ?? 20);
const MINUTES = Number(process.env.STRESS_MINUTES ?? 3);
// Mean delay between one peer's edits.
const EDIT_MS = Number(process.env.STRESS_EDIT_MS ?? 1500);
// Per peer and second, the chance of dropping offline for 1-5 s.
const DROP_PER_SECOND = Number(process.env.STRESS_DROP_PER_SECOND ?? 0.02);
// Idle connections: peers stay connected with awareness renewal and never type.
const IDLE = process.env.STRESS_IDLE === 'true';
/**
 * Local: ~1.3x the slower room's median p95 over three runs of the Performance
 * workflow (2026-10-04 runs 37200395852, 37200390235, 37200383976: Office
 * 34/33/34 ms, Plate 35/34/35 ms). The collaboration service merges
 * broadcasts over 30 ms windows (`flushDelay` in collaboration/src/server.ts),
 * which raised p95 from the earlier 3 to 9 ms and so this budget from 10 ms.
 * UAT: 1 s, the ceiling the 2026-10-04 capacity run used, network round trip
 * included.
 */
const P95_BUDGET_MS = Number(process.env.STRESS_P95_BUDGET_MS ?? (REMOTE ? 1000 : 45));
const OUT = process.env.STRESS_OUT ?? path.join(root, 'bench/collaboration/.results');
const MARKER = /\[[opnt]\d{2,3}-\d{4}\]/g;

type Kind = 'office' | 'plate' | 'note-limit' | 'text';
type Format = 'docx' | 'xlsx' | 'pptx' | 'plate' | 'text';
interface RoomToken {
  token: string;
  url: string;
  room: string;
}
interface Room {
  kind: Kind;
  format: Format;
  /** Text sources: where markers go, set once the peers joined (see
   * insertMarker). */
  anchors?: Y.RelativePosition[];
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
  /** Replaces the origin of presigned upload URLs, when they are not
   * reachable from here as given. */
  uploadOrigin?: string;
  setup(): Promise<void>;
  createRooms(kinds: Kind[]): Promise<Room[]>;
  /** Collaboration error lines logged since setup. */
  collaborationErrors(): string[];
  /** The server's containers this host can see: the collaboration service
   * and the API (gateway), which does the database side of every save. */
  serverContainers(): Containers;
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

interface Reservation {
  headers: Record<string, string>;
  uploadId: string;
  url: string;
}

/**
 * The app's direct upload: reserve, PUT the bytes to the presigned URL, then
 * complete. The target's `uploadOrigin` replaces the URL's origin (the local
 * fake S3 answers inside the Docker network under a B2 name, and on a
 * published port here).
 */
async function uploadSource(
  call: Call,
  workspace: string,
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
  fields: Record<string, string>
) {
  const route = `/api/workspaces/${workspace}/sources/uploads`;
  const contentType = name.endsWith('.txt') ? 'text/plain' : 'application/octet-stream';
  const reservation = (await call('POST', route, undefined, {
    batchId: `stress_${randomBytes(6).toString('hex')}`,
    batchTotal: 1,
    contentType,
    name,
    sizeBytes: bytes.byteLength,
    ...fields,
  })) as unknown as Reservation;
  const url = new URL(reservation.url);
  const putUrl = target.uploadOrigin
    ? `${target.uploadOrigin}${url.pathname}${url.search}`
    : reservation.url;
  const put = await fetch(putUrl, {
    body: bytes,
    headers: reservation.headers,
    method: 'PUT',
    signal: AbortSignal.timeout(120_000),
  });
  if (!put.ok) throw new Error(`PUT ${name}: ${put.status} ${await put.text()}`);
  return call('POST', `${route}/${reservation.uploadId}/complete`);
}

/** Lines of plain text up to `bytes`, the same on every run. */
function textSource(bytes: number) {
  const lines: string[] = [];
  let size = 0;
  for (let line = 1; size < bytes; line += 1) {
    const text = `Line ${line}: the field notes record the sample, the site and the weather before the next reading.\n`;
    lines.push(text);
    size += text.length;
  }
  return lines.join('').slice(0, bytes);
}

const plateNote = (paragraphs: number) => ({
  schemaVersion: 1,
  value: Array.from({ length: paragraphs }, (_, index) => ({
    children: [{ text: `Stress paragraph ${index + 1} has some text to type into.` }],
    id: `stress_p${index}`,
    type: 'p',
  })),
});

/** One workspace's rooms, a note or an uploaded source per kind. */
async function createWorkspaceRooms(
  call: Call,
  workspace: string,
  kinds: Kind[],
  uploadFields: Record<string, string> = {}
): Promise<Room[]> {
  const rooms: Room[] = [];
  let offices = 0;
  for (const kind of kinds) {
    let tokenPath: string;
    let format: Format = 'plate';
    if (kind === 'plate' || kind === 'note-limit') {
      const material = await call('POST', `/api/workspaces/${workspace}/materials`, undefined, {
        // The near-limit note is the app's load-test note (~2 MB, ~7,400 nodes).
        content:
          kind === 'plate' ? plateNote(5) : { schemaVersion: 1, value: buildBiologyLoadTestValue() },
        kind: 'note',
        title: `Stress ${randomBytes(3).toString('hex')}`,
      });
      tokenPath = `/api/materials/${material.id}/collaboration-token`;
    } else if (kind === 'text') {
      format = 'text';
      const uploaded = await uploadSource(
        call,
        workspace,
        `stress-${randomBytes(3).toString('hex')}.txt`,
        new TextEncoder().encode(textSource(TEXT_MIB * 1024 * 1024)),
        uploadFields
      );
      tokenPath = `/api/files/${uploaded.id}/collaboration-token`;
    } else {
      const file = OFFICE_FILES[offices++ % OFFICE_FILES.length];
      format = path.extname(file).slice(1) as Format;
      if (!['docx', 'xlsx', 'pptx'].includes(format)) throw new Error(`${file}: not an Office file`);
      const uploaded = await uploadSource(
        call,
        workspace,
        `stress-${randomBytes(3).toString('hex')}.${format}`,
        await readFile(path.join(root, file)),
        uploadFields
      );
      tokenPath = `/api/files/${uploaded.id}/collaboration-token`;
    }
    rooms.push({
      format,
      kind,
      seen: new Map(),
      token: async () => (await call('POST', tokenPath)) as unknown as RoomToken,
      typed: new Map(),
    });
  }
  return rooms;
}

const kindsFor = (count: number) =>
  Array.from({ length: count }, (_, index) => KINDS[index % KINDS.length]);

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
  // The fake S3's plain HTTP port on the host, for the presigned upload PUTs.
  process.env.STRESS_S3_PORT ??= String(randomPort());
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
    uploadOrigin: `http://127.0.0.1:${process.env.STRESS_S3_PORT}`,
    createRooms: (kinds) => createWorkspaceRooms(call, 'ws_e2e_edit', kinds),
    serverContainers() {
      const id = (service: string) => {
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
            'ps',
            '-q',
            service,
          ],
          { cwd: root, encoding: 'utf8' }
        );
        if (result.status !== 0 || !result.stdout.trim())
          throw new Error(`docker compose ps ${service} failed: ${result.stderr}`);
        return result.stdout.trim();
      };
      return { api: id('server'), collaboration: id('collaboration') };
    },
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

/**
 * A seeded e2e-style stack another harness runs (capacity runs on one box):
 * E2E_API_URL, E2E_AUTH_SECRET and E2E_BASE_URL name it. That harness reads
 * the collaboration logs and tears the stack down.
 */
function externalTarget(): Target {
  const api = required('E2E_API_URL');
  const headers = { 'X-E2E-Secret': required('E2E_AUTH_SECRET'), 'X-E2E-User-Id': 'u_owner' };
  const call: Call = (...args) => request(api, headers, ...args);
  return {
    origin: required('E2E_BASE_URL'),
    async setup() {
      const health = await fetch(`${api}/healthz`, { signal: AbortSignal.timeout(10_000) });
      if (!health.ok) throw new Error(`API unhealthy: ${health.status}`);
    },
    // One seeded owner workspace per generator keeps each under 100 files.
    uploadOrigin: process.env.STRESS_UPLOAD_ORIGIN,
    createRooms: (kinds) =>
      // Store-only uploads, as on UAT: no ingest job, so no per-user ingest lease cap.
      createWorkspaceRooms(call, process.env.STRESS_WORKSPACE ?? 'ws_e2e_edit', kinds, {
        parseMode: 'none',
      }),
    collaborationErrors: () => [],
    serverContainers: () => ({
      api: process.env.STRESS_API_CONTAINER || undefined,
      collaboration: process.env.STRESS_SERVER_CONTAINER || undefined,
    }),
    cleanUp: async () => {},
  };
}

const UAT = {
  api: 'https://uat-api.capynotebook.com',
  app: 'https://app.uat.capynotebook.com',
  collab: 'wss://uat-collab.capynotebook.com',
};

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for STRESS_TARGET=uat or STRESS_STACK=external`);
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
    async createRooms(kinds) {
      const pairs = Array.from({ length: Math.ceil(kinds.length / 2) }, (_, index) =>
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
    // Behind SSH and Cloudflare: only the /healthz probe reaches it.
    serverContainers: () => ({}),
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

const target = REMOTE ? await uatTarget() : EXTERNAL ? externalTarget() : await localTarget();

/**
 * What a room's peers type into: the DOCX body story, the PPTX stories, the
 * XLSX sheets (each peer writes cells of the first sheet), the text source or
 * the Plate tree.
 */
function typingTarget(room: Room, doc: Y.Doc): Y.Text | Y.Map<unknown> | null {
  if (room.format === 'docx') {
    const body = doc.getMap('stories').get('body');
    return body instanceof Y.Text ? body : null;
  }
  if (room.format === 'pptx') return doc.getMap('pptx:stories');
  if (room.format === 'xlsx') return doc.getMap('xlsx:sheets');
  if (room.format === 'text') return doc.getText('source');
  return doc.get('content', Y.XmlText);
}

/** The cell contents of the first XLSX sheet. */
function xlsxContents(doc: Y.Doc) {
  const sheets = doc.getMap('xlsx:sheets');
  const first = [...sheets.keys()].sort()[0];
  const sheet = first === undefined ? undefined : sheets.get(first);
  const contents = sheet instanceof Y.Map ? sheet.get('contents') : undefined;
  return contents instanceof Y.Map ? (contents as Y.Map<unknown>) : null;
}

/** The text of an XLSX cell's stored content, or ''. */
function cellText(content: unknown) {
  if (typeof content !== 'string') return '';
  const { value } = JSON.parse(content) as { value?: { kind?: string; value?: unknown } };
  return value?.kind === 'text' && typeof value.value === 'string' ? value.value : '';
}

/** The room's characters in document order (DOCX paragraph marks and Plate
 * element boundaries left out; XLSX cells in key order). */
function roomText(room: Room, doc: Y.Doc) {
  if (room.format === 'xlsx') {
    const contents = xlsxContents(doc);
    if (!contents) return '';
    return [...contents.keys()]
      .sort()
      .map((key) => cellText(contents.get(key)))
      .join('');
  }
  return runs(room, doc)
    .map((run) => run.value)
    .join('');
}

/**
 * Text runs a marker may go into: DOCX body runs, PPTX story runs, or Plate
 * paragraph runs, each with its Y.Text and the run's start index in it.
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
        if (room.format === 'plate' && op.insert instanceof Y.XmlText) collect(op.insert);
        at += 1;
      }
    }
  };
  // PPTX stories sit in a map, in key order so every peer reads the same text.
  const walk = (type: unknown) => {
    if (type instanceof Y.Text) collect(type);
    else if (type instanceof Y.Map)
      for (const key of [...type.keys()].sort()) walk(type.get(key));
    else if (type instanceof Y.Array) for (const item of type.toArray()) walk(item);
  };
  walk(target);
  return out;
}

// XLSX: each peer writes its own column of cells, one marker per cell, so
// concurrent writes never replace each other.
const XLSX_COLUMN_BASE = 40;
const XLSX_ROWS_PER_PEER = 2000;

/** A line start every ~4 KiB of the seeded text: anchors for text markers. */
function textAnchors(doc: Y.Doc) {
  const text = doc.getText('source');
  const value = text.toString();
  const anchors: Y.RelativePosition[] = [];
  for (let at = value.indexOf('\n', 4096); at >= 0 && at + 1 < value.length; at = value.indexOf('\n', at + 4096))
    anchors.push(Y.createRelativePositionFromTypeIndex(text, at + 1));
  return anchors;
}

/** Inside a run, never inside a marker already there, so markers stay whole. */
function insertMarker(room: Room, doc: Y.Doc, marker: string, peer: number, sequence: number) {
  if (room.format === 'text') {
    // Right before a seeded character: after every marker already there, so
    // never inside one, and no scan of a text of several MiB per marker.
    if (!room.anchors?.length) return false;
    const at = Y.createAbsolutePositionFromRelativePosition(
      room.anchors[randomInt(room.anchors.length)],
      doc
    );
    if (!at) return false;
    doc.getText('source').insert(at.index, marker);
    return true;
  }
  if (room.format === 'xlsx') {
    const contents = xlsxContents(doc);
    if (!contents || sequence >= XLSX_ROWS_PER_PEER) return false;
    // The engine's stable cell identity: base row and column points.
    const key = JSON.stringify([
      { run: 'base', offset: 1 + sequence },
      { run: 'base', offset: XLSX_COLUMN_BASE + peer },
    ]);
    contents.set(key, JSON.stringify({ value: { kind: 'text', value: marker }, formula: null }));
    return true;
  }
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
const JOIN_CONCURRENCY = Number(
  process.env.STRESS_JOIN_CONCURRENCY ?? (REMOTE ? 16 : Number.POSITIVE_INFINITY)
);

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

const DOCKER_SOCKET = process.env.DOCKER_HOST?.startsWith('unix://')
  ? process.env.DOCKER_HOST.slice('unix://'.length)
  : '/var/run/docker.sock';
const round = (value: number, places = 1) => Math.round(value * 10 ** places) / 10 ** places;

/** CPU time and working set of a container, whatever runs in it. */
interface Usage {
  cpuMs: number;
  memoryMB: number;
}
type Containers = Partial<Record<'api' | 'collaboration', string>>;
type Usages = Partial<Record<'api' | 'collaboration', Usage>>;

/** A container's usage from the Docker Engine API, as `docker stats` reads it
 * (memory without the inactive page cache). */
function containerUsage(container: string): Promise<Usage> {
  return new Promise((resolve, reject) => {
    httpGet(
      { path: `/containers/${container}/stats?stream=false&one-shot=true`, socketPath: DOCKER_SOCKET },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          if (response.statusCode !== 200)
            return reject(new Error(`docker stats ${container}: ${response.statusCode} ${body}`));
          const stats = JSON.parse(body) as {
            cpu_stats: { cpu_usage: { total_usage: number } };
            memory_stats: { usage: number; stats?: Record<string, number> };
          };
          const cache = stats.memory_stats.stats?.inactive_file ?? stats.memory_stats.stats?.total_inactive_file ?? 0;
          resolve({
            cpuMs: stats.cpu_stats.cpu_usage.total_usage / 1e6,
            memoryMB: round((stats.memory_stats.usage - cache) / 1024 / 1024),
          });
        });
      }
    ).on('error', reject);
  });
}

async function usageOf(containers: Containers) {
  const out: Usages = {};
  for (const [name, id] of Object.entries(containers) as [keyof Containers, string | undefined][])
    if (id) out[name] = await containerUsage(id);
  return out;
}

/** Per container: CPU ms between two samples, less `idle` ms per second. */
function cpuBetween(from: Usages, to: Usages, idle: Partial<Record<keyof Usages, number>> = {}, ms = 0) {
  const out: Partial<Record<keyof Usages, number>> = {};
  for (const name of Object.keys(to) as (keyof Usages)[])
    if (from[name]) out[name] = to[name]!.cpuMs - from[name]!.cpuMs - (idle[name] ?? 0) * (ms / 1000);
  return out;
}

/** Per container: memory MB from one sample to another. */
function memoryBetween(from: Usages, to: Usages) {
  const out: Partial<Record<keyof Usages, number>> = {};
  for (const name of Object.keys(to) as (keyof Usages)[])
    if (from[name]) out[name] = round(to[name]!.memoryMB - from[name]!.memoryMB);
  return out;
}

/**
 * Until every container's CPU stays under max(50, 2x `idle`) ms per second
 * for three 2 s windows in a row (60 s at most): a room's load, a store or an
 * unload finished. Returns when the quiet run began (null if it never came),
 * the last sample and each container's quietest window as its idle rate.
 */
async function quiet(containers: Containers, idle: Partial<Record<keyof Usages, number>> = {}) {
  const started = Date.now();
  let run: { at: number; usage: Usages }[] = [{ at: started, usage: await usageOf(containers) }];
  const idleOf = () =>
    perContainer(cpuBetween(run[0].usage, run[1].usage), (_, name) =>
      Math.min(...run.slice(1).map((sample, index) => cpuBetween(run[index].usage, sample.usage)[name]! / 2))
    );
  if (!Object.keys(run[0].usage).length) return { idle: {}, ms: 0, usage: run[0].usage };
  while (Date.now() - started < 60_000) {
    await sleep(2000);
    const sample = { at: Date.now(), usage: await usageOf(containers) };
    const busy = Object.entries(cpuBetween(run.at(-1)!.usage, sample.usage)).some(
      ([name, ms]) => ms / 2 > Math.max(50, 2 * (idle[name as keyof Usages] ?? 0))
    );
    run = busy ? [sample] : [...run, sample];
    if (run.length > 3) return { idle: idleOf(), ms: run[0].at - started, usage: sample.usage };
  }
  return { idle: run.length > 1 ? idleOf() : {}, ms: null, usage: run.at(-1)!.usage };
}

/** `/healthz` beside a room token's WebSocket URL. */
function healthUrl(socketUrl: string) {
  const url = new URL(socketUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/healthz';
  url.search = '';
  return url.toString();
}

/**
 * The server's answer time to /healthz every 100 ms until stopped: under
 * load it grows with whatever holds the server's event loop or scheduler.
 * The client's own loop delay (clientLoopDelayMs) bounds what it can see.
 */
function probeHealth(url: string) {
  const answers: number[] = [];
  let failures = 0;
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      const started = performance.now();
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        await response.arrayBuffer();
        if (response.ok) answers.push(performance.now() - started);
        else failures += 1;
      } catch {
        failures += 1;
      }
      await sleep(100);
    }
  })();
  return async () => {
    stopped = true;
    await done;
    return {
      failures,
      maxMs: percentile(answers, 100),
      p50Ms: percentile(answers, 50),
      p99Ms: percentile(answers, 99),
      samples: answers.length,
    };
  };
}

/** The app's explicit save: a `checkpoint-request`, resolved by the server's
 * `checkpoint-persisted` receipt naming it (rejected by any other answer). */
function checkpoint(room: Room, peer: Peer) {
  const id = `stress-${randomBytes(6).toString('hex')}`;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`${room.kind}: no receipt for ${id} in 60 s`)), 60_000);
    const onStateless = ({ payload }: { payload: string }) => {
      let event: { checkpointIds?: unknown; type?: unknown };
      try {
        event = JSON.parse(payload);
      } catch {
        return;
      }
      if (!Array.isArray(event.checkpointIds) || !event.checkpointIds.includes(id)) return;
      finish(event.type === 'checkpoint-persisted' ? undefined : new Error(`${room.kind}: ${payload.slice(0, 200)}`));
    };
    const finish = (error?: Error) => {
      clearTimeout(timer);
      peer.provider.off('stateless', onStateless);
      if (error) reject(error);
      else resolve();
    };
    peer.provider.on('stateless', onStateless);
    // Source rooms save at once only when asked to flush, as the app's Save does.
    peer.provider.sendStateless(
      JSON.stringify({ id, type: 'checkpoint-request', ...(room.format === 'plate' ? {} : { flush: true }) })
    );
  });
}

const median = (values: number[]) => (values.length ? percentile(values, 50) : null);
const perContainer = <T>(
  values: Partial<Record<keyof Usages, number>>,
  map: (value: number, name: keyof Usages) => T
) => Object.fromEntries(Object.entries(values).map(([name, value]) => [name, map(value, name as keyof Usages)]));

/**
 * One room kind alone on the server, per container (collaboration, API):
 * - `idleCpuMsPerS`: the quiet server before the room, taken out below;
 * - `loadCpuMs`, `loadS`, `memoryMBPerRoom`: loading the room for its peers
 *   until the server goes quiet, and the working set it added;
 * - `cpuMsPerUpdate`: COST_SECONDS of typing by COST_PEERS peers, the
 *   debounced saves and projections it causes included (until quiet);
 * - `cpuMsPerSave` and `saveMs`: the median of COST_SAVES explicit saves of a
 *   one-marker edit, each from a quiet server until it is quiet again (CPU)
 *   or until the receipt (time).
 */
async function costOf(kind: Kind, containers: Containers) {
  // The previous window's room may still be storing or unloading; its quiet
  // windows give the idle rate taken out below.
  const { idle } = await quiet(containers);
  const [room] = await target.createRooms([kind]);
  const before = await usageOf(containers);
  const joined = Date.now();
  const peers = await Promise.all(
    Array.from({ length: COST_PEERS }, (_, index) => connect(room, `${kind} cost ${index}`))
  );
  if (room.format === 'text') room.anchors = textAnchors(peers[0].doc);
  const settling = Date.now();
  const loaded = await quiet(containers, idle);
  const loadMs = Date.now() - joined;
  // Until the server went quiet, not the quiet windows after it.
  const loadS = loaded.ms === null ? null : round((settling - joined + loaded.ms) / 1000);
  const stopHealth = probeHealth(healthUrl((await room.token()).url));
  const started = Date.now();
  let updates = 0;
  await Promise.all(
    peers.map(async (peer, index) => {
      for (let sequence = 0; Date.now() - started < COST_SECONDS * 1000; ) {
        await sleep(randomInt(EDIT_MS / 2, (EDIT_MS * 3) / 2));
        const marker = `[${kind[0]}${String(index).padStart(2, '0')}-${String(sequence).padStart(4, '0')}]`;
        if (insertMarker(room, peer.doc, marker, index, sequence)) {
          sequence += 1;
          updates += 1;
        }
      }
    })
  );
  await until(() => peers.every(settledPeer), 60_000);
  // Until the stores and projections the typing caused are done. Not an
  // explicit save: a note's checkpoint request that lands while its store
  // runs, with no edit after, is never answered (the store claimed its
  // receipts when it began), so it would hang here.
  const typed = (await quiet(containers, idle)).usage;
  const typingMs = Date.now() - started;
  const healthz = await stopHealth();
  const saves: { cpu: Partial<Record<keyof Usages, number>>; ms: number }[] = [];
  for (let save = 0; save < COST_SAVES; save += 1) {
    const from = await usageOf(containers);
    const at = Date.now();
    // The edit schedules a store and the request waits for it, both from a
    // quiet room, so the store claims the request's receipt.
    insertMarker(room, peers[0].doc, `[${kind[0]}99-${String(save).padStart(4, '0')}]`, 99, save);
    await checkpoint(room, peers[0]);
    const ms = Date.now() - at;
    // The save's whole cost: the store and what follows it (a note's projection).
    const after = await quiet(containers, idle);
    saves.push({ cpu: cpuBetween(from, after.usage, idle, Date.now() - at), ms });
  }
  for (const { doc, provider } of peers) {
    provider.destroy();
    doc.destroy();
  }
  const server = perContainer(idle, (idleCpuMsPerS, name) => ({
    cpuMsPerSave: round(median(saves.map(({ cpu }) => cpu[name]!))!),
    cpuMsPerUpdate: round(cpuBetween(loaded.usage, typed, idle, typingMs)[name]! / Math.max(1, updates), 2),
    idleCpuMsPerS: round(idleCpuMsPerS),
    loadCpuMs: Math.round(cpuBetween(before, loaded.usage, idle, loadMs)[name]!),
    memoryMBAfterTyping: memoryBetween(before, typed)[name]!,
    // The loaded room with its peers connected, over the server before it.
    memoryMBPerRoom: memoryBetween(before, loaded.usage)[name]!,
  }));
  return {
    healthz,
    // Null when the server never went quiet after the load (60 s).
    loadS,
    peers: COST_PEERS,
    saveMs: median(saves.map(({ ms }) => ms)),
    server,
    typingS: round(typingMs / 1000),
    updates,
  };
}

async function stressRoom(room: Room, peerCount: number) {
  const watcher = await connect(room, `${room.kind} watcher`);
  // Before anyone types: the anchors name characters of the seeded text.
  if (room.format === 'text') room.anchors = textAnchors(watcher.doc);
  // Only the inserted text of each change is scanned, so the watcher's cost
  // stays flat as the room grows and the latency is the server's.
  const target = typingTarget(room, watcher.doc);
  if (!target) throw new Error(`${room.kind}: no text to type into`);
  target.observeDeep((events) => {
    const now = Date.now();
    const scan = (text: string) => {
      for (const [marker] of text.matchAll(MARKER))
        if (!room.seen.has(marker)) room.seen.set(marker, now);
    };
    for (const event of events) {
      // XLSX cells are map entries; text changes come as deltas.
      if (event.target instanceof Y.Map) {
        for (const [key, change] of event.changes.keys)
          if (change.action !== 'delete') scan(cellText(event.target.get(key)));
      } else
        for (const op of event.delta) if (typeof op.insert === 'string') scan(op.insert);
    }
  });
  const peers = await Promise.all(
    Array.from({ length: peerCount }, (_, index) => connect(room, `${room.kind} peer ${index}`))
  );
  const deadline = Date.now() + MINUTES * 60_000;
  let drops = 0;
  await Promise.all(
    peers.map(async (peer, index) => {
      let sequence = 0;
      let offlineUntil = 0;
      if (IDLE) await sleep(deadline - Date.now());
      while (!IDLE && Date.now() < deadline) {
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
        if (insertMarker(room, peer.doc, marker, index, sequence)) {
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
    format: room.format,
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

/**
 * One phase: its rooms, created when it starts, typed into together; with
 * the server's CPU and memory over the phase and its /healthz answer times.
 */
async function runPhase(kinds: Kind[], peerCount: number, containers: Containers) {
  const rooms = await target.createRooms(kinds);
  // The client's own event-loop delay: high values mean this process, not
  // the server, delayed the markers it timed.
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  const before = await usageOf(containers);
  const stopHealth = probeHealth(healthUrl((await rooms[0].token()).url));
  loopDelay.enable();
  const settled = await Promise.allSettled(rooms.map((room) => stressRoom(room, peerCount)));
  loopDelay.disable();
  const healthz = await stopHealth();
  const after = await usageOf(containers);
  const typed = settled.reduce((sum, room) => sum + (room.status === 'fulfilled' ? room.value.typed : 0), 0);
  const memory = memoryBetween(before, after);
  return {
    loopDelayMs: {
      max: Math.round(loopDelay.max / 1e6),
      p50: Math.round(loopDelay.percentile(50) / 1e6),
      p99: Math.round(loopDelay.percentile(99) / 1e6),
    },
    rooms,
    // Joins, typing, settling and late joiners alike, per typed marker.
    server: {
      healthz,
      ...perContainer(cpuBetween(before, after), (cpuMs, name) => ({
        cpuMs: Math.round(cpuMs),
        cpuMsPerMarker: round(cpuMs / Math.max(1, typed), 2),
        memoryMB: { after: after[name]!.memoryMB, before: before[name]!.memoryMB, growth: memory[name]! },
      })),
    },
    settled,
  };
}

let exitCode = 1;
try {
  await target.setup();
  const containers = target.serverContainers();
  const main = await runPhase(kindsFor(ROOMS), PEERS, containers);
  // After the budgeted rooms, so their latency stays comparable run to run.
  const limit = LIMIT_KINDS.length ? await runPhase(LIMIT_KINDS, LIMIT_PEERS, containers) : null;
  // One room kind at a time, last: what each costs the server.
  const cost: Record<string, Awaited<ReturnType<typeof costOf>>> = {};
  const costFailures: string[] = [];
  for (const kind of COST_KINDS) {
    try {
      cost[kind] = await costOf(kind, containers);
    } catch (error) {
      costFailures.push(`cost ${kind}: ${String(error).slice(0, 300)}`);
    }
  }
  const rooms = [...main.rooms, ...(limit?.rooms ?? [])];
  const settledRooms = [...main.settled, ...(limit?.settled ?? [])];
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
    ...costFailures,
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
          // The near-limit rooms are report-only.
          budgeted: KINDS.includes(kind),
        },
      ];
    })
  );
  const budgetMisses = Object.entries(byKind).flatMap(([kind, { budgeted, latencyP95Ms }]) =>
    budgeted && (latencyP95Ms ?? Number.POSITIVE_INFINITY) > P95_BUDGET_MS
      ? [`${kind}: p95 ${latencyP95Ms} ms over the ${P95_BUDGET_MS} ms budget`]
      : []
  );
  const report = {
    budgetMisses,
    budgetP95Ms: P95_BUDGET_MS,
    byKind,
    clientLoopDelayMs: main.loopDelayMs,
    // Per room kind, alone on the server (costOf).
    cost,
    costPeers: COST_KINDS.length ? COST_PEERS : null,
    costSeconds: COST_KINDS.length ? COST_SECONDS : null,
    collaborationErrors: errors.length,
    collaborationErrorSample: errors.slice(0, 10),
    editMs: EDIT_MS,
    failures,
    limitClientLoopDelayMs: limit?.loopDelayMs ?? null,
    limitPeers: limit ? LIMIT_PEERS : null,
    minutes: MINUTES,
    peers: PEERS,
    rooms: results.map(({ latencies: _, ...room }) => room),
    runner: { cpuModel: cpus()[0]?.model ?? 'unknown', cpus: cpus().length },
    // The collaboration server over each phase, measured from outside.
    server: {
      containers: Object.keys(containers).filter((name) => containers[name as keyof Containers]),
      limit: limit?.server ?? null,
      main: main.server,
    },
    target: REMOTE ? 'uat' : 'local',
    textMiB: LIMIT_KINDS.includes('text') ? TEXT_MIB : null,
    tokenFailures: tokenFailures.length,
    tokenFailureSample: tokenFailures.slice(0, 5),
  };
  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, 'stress.json'), `${JSON.stringify(report, null, 2)}\n`);
  // Capacity harnesses merge several generator processes' latencies.
  if (EXTERNAL)
    await writeFile(
      path.join(OUT, 'latencies.json'),
      JSON.stringify(
        Object.fromEntries(
          [...new Set(results.map(({ format }) => format))].map((format) => [
            format,
            results.filter((room) => room.format === format).flatMap((room) => room.latencies),
          ])
        )
      )
    );
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
