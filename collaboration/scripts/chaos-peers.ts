/**
 * Dev chaos harness: connect synthetic Hocuspocus peers to a live room so the
 * real editor can exercise presence, cursors, and concurrent Yjs merges.
 *
 * Requires a running collaboration sidecar (same COLLABORATION_SECRET / origin
 * allowlist as the app). Tokens are minted locally — no Go API session needed.
 *
 * Example:
 *   pnpm --filter @capy-notebook/collaboration chaos -- \
 *     --material-id mat_abc --peers 4
 */
import { randomBytes } from 'node:crypto';
import {
  HocuspocusProvider,
  type HocuspocusProviderConfiguration,
} from '@hocuspocus/provider';
import {
  CursorEditor,
  withCursors,
  withYjs,
  YjsEditor,
  yTextToSlateElement,
} from '@slate-yjs/core';
import { createEditor, Editor, Text, Transforms } from 'slate';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import {
  MATERIAL_ROOM_PATTERN,
  materialRoom,
  mintCollaborationToken,
} from '../src/auth.js';

interface RangeMs {
  max: number;
  min: number;
}

interface ChaosOptions {
  access: 'comment' | 'write';
  cursorMs: RangeMs;
  edits: boolean;
  idleMs: RangeMs;
  origin: string;
  peers: number;
  room: string;
  secret: string;
  sessionMs: RangeMs;
  url: string;
  writeMs: RangeMs;
}

type CursorEditorBound = ReturnType<typeof createEditor> &
  YjsEditor &
  CursorEditor<{ color: string; name: string }>;

const PEER_NAMES = [
  'Avery',
  'Blake',
  'Casey',
  'Drew',
  'Eden',
  'Finley',
  'Gray',
  'Harper',
  'Indigo',
  'Jules',
];

const SNIPPETS = [' hmm', ' …', ' ok', ' +1', ' draft', ' note', '?', '!'];

function usage(): never {
  console.info(`Usage: chaos-peers --room material:<id>:schema:<n> [options]
       chaos-peers --material-id <id> [--schema <n>] [options]

Options:
  --url <ws>              Collaboration WebSocket (default: ws://127.0.0.1:1234)
  --origin <origin>       Must match COLLABORATION_ALLOWED_ORIGINS (default: http://localhost:5173)
  --secret <secret>       COLLABORATION_SECRET (default: env or dev-collaboration-secret)
  --peers <n>             Concurrent synthetic peers (default: 3)
  --access write|comment  Token access (default: write)
  --edit-ms <a-b>         Delay between document edits (default: 700-2800)
  --cursor-ms <a-b>       Delay between cursor moves (default: 400-1400)
  --session-ms <a-b>      How long a peer stays connected (default: 6s-20s)
  --idle-ms <a-b>         Delay before a peer rejoins (default: 2s-8s)
  --no-edits              Awareness/cursors only (still joins/leaves)
  --help

Open the material in the app with VITE_USE_MSW=false (or a hybrid that still
hits the real collab sidecar), then run this against the same room.`);
  process.exit(0);
}

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function parseRange(raw: string): RangeMs {
  const value = raw.trim();
  if (!value.includes('-')) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error(`invalid range: ${raw}`);
    return { max: n, min: n };
  }
  const [minRaw, maxRaw] = value.split('-', 2);
  const min = Number(minRaw);
  const max = Number(maxRaw);
  if (!(Number.isFinite(min) && Number.isFinite(max)) || min < 0 || max < min) {
    throw new Error(`invalid range: ${raw}`);
  }
  return { max, min };
}

function pickRange(range: RangeMs): number {
  if (range.min === range.max) return range.min;
  return range.min + Math.floor(Math.random() * (range.max - range.min + 1));
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function cursorColor(seed: string) {
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return `hsl(${hash % 360} 72% 48%)`;
}

function randomId(prefix: string) {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

function createOriginWebSocket(origin: string) {
  return class OriginWebSocket extends WebSocket {
    constructor(url: string | URL) {
      super(url, { headers: { Origin: origin } });
    }
  };
}

function parseOptions(argv: string[]): ChaosOptions {
  const args = argv.filter((value) => value !== '--');
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) usage();

  const materialId = flagValue(args, '--material-id');
  const schemaRaw = flagValue(args, '--schema');
  const roomFlag = flagValue(args, '--room');
  let room = roomFlag;
  if (!room && materialId) {
    room = materialRoom(materialId, Number(schemaRaw ?? '1'));
  }
  if (!room) usage();
  if (!MATERIAL_ROOM_PATTERN.test(room)) {
    throw new Error(`invalid room name: ${room}`);
  }

  const accessRaw = flagValue(args, '--access') ?? 'write';
  if (accessRaw !== 'write' && accessRaw !== 'comment') {
    throw new Error('--access must be write or comment');
  }

  const peers = Number(flagValue(args, '--peers') ?? '3');
  if (!Number.isSafeInteger(peers) || peers < 1 || peers > 32) {
    throw new Error('--peers must be an integer from 1 to 32');
  }

  return {
    access: accessRaw,
    cursorMs: parseRange(flagValue(args, '--cursor-ms') ?? '400-1400'),
    edits: !(hasFlag(args, '--no-edits') || accessRaw === 'comment'),
    idleMs: parseRange(flagValue(args, '--idle-ms') ?? '2000-8000'),
    origin:
      flagValue(args, '--origin') ??
      process.env.COLLABORATION_ORIGIN?.trim() ??
      'http://localhost:5173',
    peers,
    room,
    secret:
      flagValue(args, '--secret') ??
      process.env.COLLABORATION_SECRET?.trim() ??
      'dev-collaboration-secret',
    sessionMs: parseRange(flagValue(args, '--session-ms') ?? '6000-20000'),
    url:
      flagValue(args, '--url') ??
      process.env.COLLABORATION_URL?.trim() ??
      'ws://127.0.0.1:1234',
    writeMs: parseRange(flagValue(args, '--edit-ms') ?? '700-2800'),
  };
}

function synced(provider: HocuspocusProvider) {
  return new Promise<void>((resolve, reject) => {
    if (provider.synced) {
      resolve();
      return;
    }
    const timeout = setTimeout(
      () => reject(new Error('provider did not sync within 15s')),
      15_000
    );
    provider.on('synced', () => {
      clearTimeout(timeout);
      resolve();
    });
    provider.on('authenticationFailed', ({ reason }) => {
      clearTimeout(timeout);
      reject(new Error(`authentication failed: ${reason}`));
    });
  });
}

function bindEditor(
  document: Y.Doc,
  awareness: NonNullable<HocuspocusProvider['awareness']>,
  data: { color: string; name: string }
): CursorEditorBound {
  const sharedRoot = document.get('content', Y.XmlText);
  const baseEditor = createEditor();
  baseEditor.children = (
    yTextToSlateElement(sharedRoot) as {
      children: typeof baseEditor.children;
    }
  ).children;
  const editor = withCursors(
    withYjs(baseEditor, sharedRoot, { autoConnect: false }),
    awareness,
    { autoSend: true, data }
  );
  YjsEditor.connect(editor);
  CursorEditor.sendCursorData(editor, data);
  return editor;
}

function applyRandomEdit(editor: CursorEditorBound, peerName: string) {
  const textEntries = [
    ...Editor.nodes(editor, {
      at: [],
      match: (node) => Text.isText(node),
    }),
  ];
  if (textEntries.length === 0) {
    Transforms.insertNodes(
      editor,
      {
        children: [{ text: `${peerName} was here` }],
        id: randomId('p'),
        type: 'p',
      } as never,
      { at: [editor.children.length] }
    );
    YjsEditor.flushLocalChanges(editor);
    return;
  }

  const roll = Math.random();
  if (roll < 0.25) {
    Transforms.insertNodes(
      editor,
      {
        children: [
          {
            text: `${peerName}${SNIPPETS[Math.floor(Math.random() * SNIPPETS.length)]}`,
          },
        ],
        id: randomId('p'),
        type: 'p',
      } as never,
      { at: [editor.children.length] }
    );
  } else {
    const [node, path] =
      textEntries[Math.floor(Math.random() * textEntries.length)];
    const text = Text.isText(node) ? node.text : '';
    const offset = Math.floor(Math.random() * (text.length + 1));
    const snippet = SNIPPETS[Math.floor(Math.random() * SNIPPETS.length)];
    Transforms.insertText(editor, snippet, { at: { offset, path } });
  }
  YjsEditor.flushLocalChanges(editor);
}

function moveCursor(editor: CursorEditorBound) {
  const textEntries = [
    ...Editor.nodes(editor, {
      at: [],
      match: (node) => Text.isText(node),
    }),
  ];
  if (textEntries.length === 0) {
    CursorEditor.sendCursorPosition(editor, null);
    return;
  }
  const [, path] = textEntries[Math.floor(Math.random() * textEntries.length)];
  const node = Editor.node(editor, path)[0];
  const length = Text.isText(node) ? node.text.length : 0;
  const offset = Math.floor(Math.random() * (length + 1));
  const point = { offset, path };
  CursorEditor.sendCursorPosition(editor, { anchor: point, focus: point });
}

class ChaosPeer {
  private destroyed = false;
  private document: Y.Doc | null = null;
  private editor: CursorEditorBound | null = null;
  private readonly options: ChaosOptions;
  private provider: HocuspocusProvider | null = null;
  private readonly slot: number;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(options: ChaosOptions, slot: number) {
    this.options = options;
    this.slot = slot;
  }

  private schedule(fn: () => void, ms: number) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.destroyed) fn();
    }, ms);
    this.timers.add(timer);
  }

  private clearTimers() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private token(userId: string, name: string) {
    return mintCollaborationToken({
      access: this.options.access,
      name,
      room: this.options.room,
      secret: this.options.secret,
      userId,
    });
  }

  async join() {
    if (this.destroyed) return;
    const name = `${PEER_NAMES[this.slot % PEER_NAMES.length]} ${this.slot + 1}`;
    const userId = `chaos_${this.slot}_${randomBytes(3).toString('hex')}`;
    const color = cursorColor(userId);
    const document = new Y.Doc();
    this.document = document;
    // WebSocketPolyfill is accepted by the internal websocket constructor even
    // though the public provider config type only exposes url | websocketProvider.
    const provider = new HocuspocusProvider({
      document,
      name: this.options.room,
      onAuthenticationFailed: ({ reason }) => {
        console.warn(`[peer ${this.slot}] auth failed: ${reason}`);
      },
      token: () => this.token(userId, name),
      url: this.options.url,
      WebSocketPolyfill: createOriginWebSocket(this.options.origin),
    } as HocuspocusProviderConfiguration);
    this.provider = provider;

    try {
      await synced(provider);
    } catch (error) {
      console.error(
        `[peer ${this.slot}] failed to sync:`,
        error instanceof Error ? error.message : error
      );
      provider.destroy();
      document.destroy();
      this.provider = null;
      this.document = null;
      this.scheduleRejoin();
      return;
    }

    if (this.destroyed) {
      provider.destroy();
      document.destroy();
      this.provider = null;
      this.document = null;
      return;
    }

    if (!provider.awareness) {
      console.error(`[peer ${this.slot}] provider has no awareness`);
      provider.destroy();
      document.destroy();
      this.provider = null;
      this.document = null;
      this.scheduleRejoin();
      return;
    }

    this.editor = bindEditor(document, provider.awareness, { color, name });
    console.info(`[peer ${this.slot}] joined as ${name}`);

    const loopEdits = () => {
      if (this.destroyed || !this.editor || !this.options.edits) return;
      try {
        applyRandomEdit(this.editor, name);
      } catch (error) {
        console.warn(
          `[peer ${this.slot}] edit failed:`,
          error instanceof Error ? error.message : error
        );
      }
      this.schedule(loopEdits, pickRange(this.options.writeMs));
    };
    const loopCursors = () => {
      if (this.destroyed || !this.editor) return;
      try {
        moveCursor(this.editor);
      } catch (error) {
        console.warn(
          `[peer ${this.slot}] cursor failed:`,
          error instanceof Error ? error.message : error
        );
      }
      this.schedule(loopCursors, pickRange(this.options.cursorMs));
    };

    if (this.options.edits) {
      this.schedule(loopEdits, pickRange(this.options.writeMs));
    }
    this.schedule(loopCursors, pickRange(this.options.cursorMs));
    this.schedule(() => {
      void this.leave();
    }, pickRange(this.options.sessionMs));
  }

  async leave() {
    this.clearTimers();
    const editor = this.editor;
    const provider = this.provider;
    const document = this.document;
    this.editor = null;
    this.provider = null;
    this.document = null;
    if (editor && YjsEditor.connected(editor)) {
      CursorEditor.sendCursorPosition(editor, null);
      YjsEditor.disconnect(editor);
    }
    provider?.destroy();
    document?.destroy();
    if (this.destroyed) return;
    console.info(`[peer ${this.slot}] left`);
    this.scheduleRejoin();
  }

  private scheduleRejoin() {
    this.schedule(() => {
      void this.join();
    }, pickRange(this.options.idleMs));
  }

  async destroy() {
    this.destroyed = true;
    await this.leave();
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  console.info(
    JSON.stringify(
      {
        access: options.access,
        edits: options.edits,
        origin: options.origin,
        peers: options.peers,
        room: options.room,
        url: options.url,
      },
      null,
      2
    )
  );

  const peers = Array.from(
    { length: options.peers },
    (_, slot) => new ChaosPeer(options, slot)
  );
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
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
