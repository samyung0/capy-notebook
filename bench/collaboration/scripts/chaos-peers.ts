/**
 * Chaos peers: synthetic collaborators that join a live room of the Rust
 * collaboration server over capy-sync 1, as browser tabs do, so the real
 * editor can be watched under presence, cursors, concurrent edits and peers
 * leaving and coming back. A note room gets Slate edits and cursors through
 * slate-yjs; a text source room gets inserts into its `source` text.
 *
 * Tokens are minted here with the collaboration secret, for a user who may
 * open the room (the server checks the user's access, so name a member).
 * Phase two's UAT collaboration load test is planned on top of this
 * (human/review-automation.md).
 *
 *   pnpm chaos:peers --material-id <id> --user <user id> [--peers 4]
 *   pnpm chaos:peers --room source:<file id>:epoch:<n> --user <user id>
 */
import { createHmac, randomBytes } from 'node:crypto';
import { CursorEditor, withCursors, withYjs, YjsEditor } from '@slate-yjs/core';
import { createSlateEditor, type NodeEntry, type Path, TextApi, type TNode } from 'platejs';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { RoomProvider } from '../../../src/features/collaboration/roomProvider';
import { CollabSocket } from '../../../src/features/collaboration/socket';

interface RangeMs {
  max: number;
  min: number;
}

interface ChaosOptions {
  access: 'read' | 'write';
  cursorMs: RangeMs;
  edits: boolean;
  idleMs: RangeMs;
  origin: string;
  peers: number;
  room: string;
  secret: string;
  sessionMs: RangeMs;
  url: string;
  user: string;
  writeMs: RangeMs;
}

const ROOM = /^(material:[^:]+:schema|source:[^:]+:epoch):([1-9][0-9]*)$/;
const PEER_NAMES = ['Avery', 'Blake', 'Casey', 'Drew', 'Eden', 'Finley', 'Gray', 'Harper', 'Indigo', 'Jules'];
const SNIPPETS = [' hmm', ' …', ' ok', ' +1', ' draft', ' note', '?', '!'];
/** Blocks a person types into; anything else (voids, tables, code) is left alone. */
const TEXT_BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote']);

function usage(): never {
  console.info(`Usage: chaos-peers --room <material:<id>:schema:<n> | source:<id>:epoch:<n>> --user <id> [options]
       chaos-peers --material-id <id> [--schema <n>] --user <id> [options]

Options:
  --user <id>             The user the tokens name; the server checks their access (required)
  --url <ws>              Collaboration WebSocket (default: env COLLABORATION_URL or ws://127.0.0.1:1234)
  --origin <origin>       One of COLLABORATION_ALLOWED_ORIGINS (default: http://localhost:5173)
  --secret <secret>       COLLABORATION_SECRET (default: env or dev-collaboration-secret)
  --peers <n>             Concurrent synthetic peers (default: 3)
  --access write|read     Token access (default: write)
  --edit-ms <a-b>         Delay between document edits (default: 700-2800)
  --cursor-ms <a-b>       Delay between cursor moves (default: 400-1400)
  --session-ms <a-b>      How long a peer stays connected (default: 6000-20000)
  --idle-ms <a-b>         Delay before a peer rejoins (default: 2000-8000)
  --no-edits              Cursors only (peers still join and leave)
  --help`);
  process.exit(0);
}

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function parseRange(raw: string): RangeMs {
  const [minRaw, maxRaw = minRaw] = raw.trim().split('-', 2);
  const min = Number(minRaw);
  const max = Number(maxRaw);
  if (!(Number.isFinite(min) && Number.isFinite(max)) || min < 0 || max < min)
    throw new Error(`invalid range: ${raw}`);
  return { max, min };
}

const pick = (range: RangeMs) => range.min + Math.floor(Math.random() * (range.max - range.min + 1));
const sample = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function cursorColor(seed: string) {
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 72% 48%)`;
}

function parseOptions(argv: string[]): ChaosOptions {
  const args = argv.filter((value) => value !== '--');
  if (args.includes('--help') || args.includes('-h')) usage();
  const materialId = flagValue(args, '--material-id');
  const room =
    flagValue(args, '--room') ??
    (materialId ? `material:${materialId}:schema:${flagValue(args, '--schema') ?? '1'}` : undefined);
  const user = flagValue(args, '--user') ?? process.env.CHAOS_USER_ID?.trim();
  if (!room || !user) usage();
  if (!ROOM.test(room)) throw new Error(`invalid room name: ${room}`);
  const access = flagValue(args, '--access') ?? 'write';
  if (access !== 'write' && access !== 'read') throw new Error('--access must be write or read');
  const peers = Number(flagValue(args, '--peers') ?? '3');
  if (!Number.isSafeInteger(peers) || peers < 1 || peers > 32)
    throw new Error('--peers must be an integer from 1 to 32');
  return {
    access,
    cursorMs: parseRange(flagValue(args, '--cursor-ms') ?? '400-1400'),
    edits: !(args.includes('--no-edits') || access === 'read'),
    idleMs: parseRange(flagValue(args, '--idle-ms') ?? '2000-8000'),
    origin: flagValue(args, '--origin') ?? process.env.COLLABORATION_ORIGIN?.trim() ?? 'http://localhost:5173',
    peers,
    room,
    secret: flagValue(args, '--secret') ?? process.env.COLLABORATION_SECRET?.trim() ?? 'dev-collaboration-secret',
    sessionMs: parseRange(flagValue(args, '--session-ms') ?? '6000-20000'),
    url: flagValue(args, '--url') ?? process.env.COLLABORATION_URL?.trim() ?? 'ws://127.0.0.1:1234',
    user,
    writeMs: parseRange(flagValue(args, '--edit-ms') ?? '700-2800'),
  };
}

/** The HS256 room token the Go API mints (`collaboration-rs` `auth::verify`). */
function mintToken(options: ChaosOptions, name: string): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    access: options.access,
    aud: 'capy-collaboration',
    // The Yjs client id the session writes under, fresh per token (Q213).
    clientId: randomBytes(4).readUInt32BE(0) || 1,
    exp: now + 3600,
    iat: now,
    iss: 'capy-api',
    jti: `chaos_${randomBytes(8).toString('hex')}`,
    name,
    room: options.room,
    schema: Number(options.room.split(':').at(-1)),
    sub: options.user,
  };
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
  const signature = createHmac('sha256', options.secret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

let origin = 'http://localhost:5173';
class OriginWebSocket extends WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    // Node's WebSocket takes headers; the browser one sends Origin itself.
    super(url, { headers: { Origin: origin }, protocols } as unknown as string[]);
  }
}
// The room provider opens its sockets with the global constructor.
globalThis.WebSocket = OriginWebSocket;

type PeerEditor = ReturnType<typeof createSlateEditor> & YjsEditor & CursorEditor<{ color: string; name: string }>;

/** Text leaves of plain text blocks, where a person types. */
function textEntries(editor: PeerEditor): NodeEntry[] {
  return [
    ...editor.api.nodes({
      at: [],
      match: (node: TNode, path: Path) =>
        TextApi.isText(node) && TEXT_BLOCKS.has(String((editor.children[path[0]] as TNode | undefined)?.type)),
    }),
  ];
}

function randomEdit(editor: PeerEditor, name: string) {
  const entries = textEntries(editor);
  if (entries.length === 0 || Math.random() < 0.25) {
    editor.tf.insertNodes(
      { children: [{ text: `${name}${sample(SNIPPETS)}` }], id: `p_${randomBytes(4).toString('hex')}`, type: 'p' },
      { at: [editor.children.length] }
    );
  } else {
    const [node, path] = sample(entries);
    const text = TextApi.isText(node) ? node.text : '';
    editor.tf.insertText(sample(SNIPPETS), { at: { offset: Math.floor(Math.random() * (text.length + 1)), path } });
  }
  YjsEditor.flushLocalChanges(editor);
}

function moveCursor(editor: PeerEditor) {
  const entries = textEntries(editor);
  if (entries.length === 0) {
    CursorEditor.sendCursorPosition(editor, null);
    return;
  }
  const [node, path] = sample(entries);
  const length = TextApi.isText(node) ? node.text.length : 0;
  const point = { offset: Math.floor(Math.random() * (length + 1)), path };
  CursorEditor.sendCursorPosition(editor, { anchor: point, focus: point });
}

function randomSourceEdit(text: Y.Text, name: string) {
  const snippet = Math.random() < 0.2 ? `\n${name}${sample(SNIPPETS)}` : sample(SNIPPETS);
  text.insert(Math.floor(Math.random() * (text.length + 1)), snippet);
}

/** One synthetic collaborator: joins, edits and moves its cursor for a
 * session, leaves, and comes back after an idle spell. */
class ChaosPeer {
  private destroyed = false;
  private document: Y.Doc | null = null;
  private editor: PeerEditor | null = null;
  private provider: RoomProvider | null = null;
  private readonly name: string;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly options: ChaosOptions,
    private readonly slot: number
  ) {
    this.name = `${PEER_NAMES[slot % PEER_NAMES.length]} ${slot + 1}`;
  }

  private schedule(fn: () => void, ms: number) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.destroyed) fn();
    }, ms);
    this.timers.add(timer);
  }

  async join() {
    if (this.destroyed) return;
    const document = new Y.Doc();
    const note = this.options.room.startsWith('material:');
    const awareness = note ? new Awareness(document) : null;
    let failed: (error: Error) => void = () => undefined;
    let synced: () => void = () => undefined;
    const provider = new RoomProvider({
      awareness,
      document,
      name: this.options.room,
      onAuthenticationFailed: ({ reason }) => failed(new Error(`authentication failed: ${reason}`)),
      onSynced: ({ state }) => {
        if (state) synced();
      },
      // Each peer is a browser tab of its own: its own socket.
      socket: CollabSocket.create(this.options.url),
      token: async () => mintToken(this.options, this.name),
      url: this.options.url,
    });
    this.document = document;
    this.provider = provider;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('did not sync within 15 s')), 15_000);
        synced = () => {
          clearTimeout(timer);
          resolve();
        };
        failed = (error) => {
          clearTimeout(timer);
          reject(error);
        };
        provider.connect();
      });
    } catch (error) {
      console.error(`[peer ${this.slot}] ${error instanceof Error ? error.message : String(error)}`);
      await this.leave();
      return;
    }
    if (this.destroyed) return;
    if (awareness) {
      const data = { color: cursorColor(`${this.name}${this.slot}`), name: this.name };
      // Cursors are sent by hand: autoSend would send the headless editor's
      // null selection after every change. Plate's editor is not a Slate
      // BaseEditor by type, so the slate-yjs wrappers take a cast.
      const editor = withCursors(
        withYjs(createSlateEditor() as never, document.get('content', Y.XmlText), { autoConnect: false }),
        awareness,
        { autoSend: false, data }
      ) as unknown as PeerEditor;
      YjsEditor.connect(editor);
      CursorEditor.sendCursorData(editor, data);
      this.editor = editor;
      const cursors = () => {
        if (!this.editor) return;
        moveCursor(this.editor);
        this.schedule(cursors, pick(this.options.cursorMs));
      };
      this.schedule(cursors, pick(this.options.cursorMs));
    }
    console.info(`[peer ${this.slot}] joined as ${this.name}`);
    const edits = () => {
      try {
        if (this.editor) randomEdit(this.editor, this.name);
        else if (this.document) randomSourceEdit(this.document.getText('source'), this.name);
      } catch (error) {
        console.warn(`[peer ${this.slot}] edit failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.schedule(edits, pick(this.options.writeMs));
    };
    if (this.options.edits) this.schedule(edits, pick(this.options.writeMs));
    this.schedule(() => void this.leave(), pick(this.options.sessionMs));
  }

  async leave() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.editor && YjsEditor.connected(this.editor)) {
      CursorEditor.sendCursorPosition(this.editor, null);
      YjsEditor.disconnect(this.editor);
    }
    this.editor = null;
    this.provider?.destroy();
    this.provider = null;
    this.document?.destroy();
    this.document = null;
    if (this.destroyed) return;
    console.info(`[peer ${this.slot}] left`);
    this.schedule(() => void this.join(), pick(this.options.idleMs));
  }

  async destroy() {
    this.destroyed = true;
    await this.leave();
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  origin = options.origin;
  const { secret: _secret, ...shown } = options;
  console.info(JSON.stringify(shown, null, 2));
  const peers = Array.from({ length: options.peers }, (_, slot) => new ChaosPeer(options, slot));
  await Promise.all(
    peers.map(async (peer, index) => {
      await sleep(index * 250);
      await peer.join();
    })
  );
  const shutdown = async () => {
    console.info('shutting down chaos peers…');
    await Promise.all(peers.map((peer) => peer.destroy()));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
