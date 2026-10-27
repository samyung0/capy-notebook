import {
  type ProviderConstructorProps,
  registerProviderType,
  type UnifiedProvider,
} from '@platejs/yjs';
import { slateNodesToInsertDelta, yTextToSlateElement } from '@slate-yjs/core';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import { qk } from '@/api/client';
import { queryClient } from '@/api/queryClient';
import type { Material } from '@/api/types';
import {
  type ItemProvider,
  registerMockItemProvider,
} from '@/features/collaboration/itemRoom';
import type { PresenceConnection } from '@/features/collaboration/presence';
import type { RoomProviderConfig } from '@/features/collaboration/roomProvider';
import {
  registerMockSourceProvider,
  type SourceProvider,
  type SourceProviderConfig,
  sourceDocOptions,
} from '@/features/files/sourceProvider';
import { readCards, seedCards } from '@/features/flashcards/liveSet';
import {
  createMaterialDocument,
  createMaterialDocumentWithMetrics,
  flashcardsNode,
  isKnownElementType,
  type MaterialValue,
  quizNode,
} from '@/features/materials/document';
import {
  COLLABORATION_LATE_REASON,
  COLLABORATION_OUTDATED_REASON,
} from '@/features/notes/collaborationEvents';
import { withoutBlanks } from '@/features/questions/types';
import { validateQuestion } from '@/features/questions/validation';
import {
  itemParts,
  type ReaderList,
  readQuestions,
  seedQuiz,
} from '@/features/quizzes/liveQuiz';
import * as db from './db';

/** In-page stand-in for the collaboration sidecar. A room is one Y.Doc that
 * every participant (the app's editor, the source editor, chaos peers) merges
 * into; document and awareness updates fan out to the other participants. */

/** `origin` tags inbound updates the way Hocuspocus tags them with the
 * provider, so consumers can tell remote transactions from their own. A
 * participant with an `identity` is an editor in the room's presence; one
 * with `onPresence` hears the others', as the service sends it. */
interface Participant {
  awareness?: Awareness;
  document: Y.Doc;
  identity?: MockIdentity;
  onPresence?: (connections: PresenceConnection[]) => void;
  origin: object;
}

export type MockIdentity = Omit<PresenceConnection, 'clients'>;

/** The service's room presence (`send_presence`): every participant hears
 * the other editors, never itself. */
function announcePresence(room: Room) {
  for (const participant of room.participants) {
    participant.onPresence?.(
      [...room.participants].flatMap((other) =>
        other !== participant && other.identity
          ? [
              {
                ...other.identity,
                clients: other.awareness ? [other.awareness.clientID] : [],
              },
            ]
          : []
      )
    );
  }
}

export interface Room {
  checkpointFailed?: boolean;
  dirty: boolean;
  document: Y.Doc;
  format?: 'text' | 'docx' | 'xlsx' | 'pptx';
  name: string;
  participants: Set<Participant>;
  /** Updates since the last checkpoint, which appends them. */
  pending: Uint8Array[];
  retired?: boolean;
  target:
    | { kind: 'material'; id: string }
    | { kind: 'item'; id: string }
    | { kind: 'source'; id: string };
  version: number;
}

export const rooms = new Map<string, Room>();
// Encoded checkpoints outlive a room, like the other in-memory mock records.
// A checkpoint appends the room's updates since the last one instead of
// re-encoding the document: on a near-limit note that encode cost ~40ms of
// main thread per save at CPU x4, inside the save cycle the editor bench
// budgets, for work the real service does server-side.
interface Checkpoint {
  updates: Uint8Array[];
  version: number;
}
const checkpoints = new Map<string, Checkpoint>();

function checkpointState(checkpoint: Checkpoint): Uint8Array {
  if (checkpoint.updates.length !== 1)
    checkpoint.updates = [Y.mergeUpdates(checkpoint.updates)];
  return checkpoint.updates[0];
}
const REMOTE = 'mock-room';

/** The quiz and flashcard blocks whose materialId an update wrote, as the
 * service reads them (`child_writes` in collaboration-rs/crates/notes/src/children.rs). */
function writtenBlocks(document: Y.Doc, update: Uint8Array) {
  const blocks = new Set<Y.XmlText>();
  for (const struct of Y.decodeUpdate(update).structs) {
    if (!(struct instanceof Y.Item && struct.content instanceof Y.ContentAny))
      continue;
    let item: unknown;
    try {
      item = Y.getItem(document.store, struct.id);
    } catch {
      continue;
    }
    if (
      item instanceof Y.Item &&
      !item.deleted &&
      item.parentSub === 'materialId' &&
      item.parent instanceof Y.XmlText
    )
      blocks.add(item.parent);
  }
  return blocks;
}

/** The collaboration service's children pass (collaboration-rs/crates/server/src/children.rs)
 * for quiz and flashcard blocks a writer's update wrote: a block naming
 * another note's set gets the note's copy, a set already in another block gets
 * its own copy, an unknown one goes. Mock assets all belong to every note, so
 * images need nothing. */
function mockChildrenPass(room: Room, update: Uint8Array) {
  const note = db.materials.find((x) => x.id === room.target.id);
  const written = writtenBlocks(room.document, update);
  if (!(note && written.size)) return;
  const root = room.document.get('content', Y.XmlText);
  const ops = root.toDelta() as Array<{ insert: unknown }>;
  const refOf = (block: unknown) => {
    if (!(block instanceof Y.XmlText)) return '';
    const { materialId, type } = block.getAttributes() as Record<
      string,
      unknown
    >;
    return type === 'material_ref' && typeof materialId === 'string'
      ? materialId
      : '';
  };
  // Sets the blocks the update did not write already hold.
  const kept = new Set(
    ops
      .filter((op) => !written.has(op.insert as Y.XmlText))
      .map((op) => refOf(op.insert))
  );
  const changes: Array<() => void> = [];
  let index = 0;
  for (const op of ops) {
    const block = op.insert;
    const at = index;
    index += typeof block === 'string' ? block.length : 1;
    const materialId = refOf(block);
    if (!(materialId && written.has(block as Y.XmlText))) continue;
    const own =
      db.materials.find((x) => x.id === materialId)?.parentMaterialId ===
      note.id;
    if (own && !kept.has(materialId)) {
      kept.add(materialId);
      continue;
    }
    const copy = db.copyEmbeddedInto(note, materialId);
    if (copy) kept.add(copy);
    changes.push(() =>
      copy
        ? (block as Y.XmlText).setAttribute('materialId', copy)
        : root.delete(at, 1)
    );
  }
  if (!changes.length) return;
  room.document.transact(() => {
    for (const change of changes.reverse()) change();
  }, REMOTE);
}

function createRoom(
  name: string,
  target: Room['target'],
  docOptions?: ReturnType<typeof sourceDocOptions>
): Room {
  const document = new Y.Doc({ gc: true, guid: name, ...docOptions });
  let checkpoint = checkpoints.get(name);
  if (
    !checkpoint &&
    target.id.startsWith('mock-scenario-') &&
    typeof sessionStorage !== 'undefined'
  ) {
    const saved = sessionStorage.getItem(`capy.scenario.room.${name}`);
    if (saved) {
      const parsed = JSON.parse(saved) as { state: number[]; version: number };
      checkpoint = {
        updates: [new Uint8Array(parsed.state)],
        version: parsed.version,
      };
      checkpoints.set(name, checkpoint);
    }
  }
  if (checkpoint) Y.applyUpdate(document, checkpointState(checkpoint));
  const room: Room = {
    dirty: false,
    document,
    name,
    participants: new Set(),
    pending: [],
    target,
    version: checkpoint?.version ?? 0,
  };
  document.on('update', (update: Uint8Array, origin: unknown) => {
    room.dirty = true;
    room.pending.push(update);
    for (const participant of room.participants) {
      if (participant !== origin)
        Y.applyUpdate(participant.document, update, participant.origin);
    }
    if (
      target.kind === 'material' &&
      room.participants.has(origin as Participant)
    )
      setTimeout(() => mockChildrenPass(room, update));
  });
  rooms.set(name, room);
  return room;
}

function materialRoom(name: string, initialValue: MaterialValue): Room {
  const existing = rooms.get(name);
  if (existing) return existing;
  const materialId = name.split(':')[1] ?? '';
  const room = createRoom(name, { id: materialId, kind: 'material' });
  if (!checkpoints.has(name)) {
    room.document
      .get('content', Y.XmlText)
      .applyDelta(slateNodesToInsertDelta(initialValue));
    room.dirty = false;
  }
  return room;
}

/** Whether a room's text holds an element of a type the embed catalog does
 * not list (the collaboration server's `plate::unlisted_type`). */
function holdsUnlistedType(text: Y.XmlText): boolean {
  return (text.toDelta() as { insert: unknown }[]).some(({ insert }) => {
    if (!(insert instanceof Y.XmlText)) return false;
    const type = insert.getAttribute('type');
    return (
      (typeof type === 'string' && !isKnownElementType(type)) ||
      holdsUnlistedType(insert)
    );
  });
}

/** Source rooms use the sidecar's `source:<fileId>:epoch:<n>` name and hold
 * the file text in `Y.Text('source')`, like the sidecar seeds them. */
export function sourceRoomName(fileId: string, epoch: number) {
  return `source:${fileId}:epoch:${epoch}`;
}

export function sourceRoom(
  fileId: string,
  epoch: number,
  text: string,
  state?: Uint8Array,
  format: Room['format'] = 'text'
): Room {
  const name = sourceRoomName(fileId, epoch);
  const existing = rooms.get(name);
  if (existing) return existing;
  const room = createRoom(
    name,
    { id: fileId, kind: 'source' },
    sourceDocOptions(format)
  );
  room.format = format;
  if (!checkpoints.has(name)) {
    if (state) Y.applyUpdate(room.document, state);
    else room.document.getText('source').insert(0, text);
  }
  room.dirty = false;
  if (fileId.startsWith('mock-scenario-')) rememberCheckpoint(room);
  return room;
}

function persistMaterial(room: Room) {
  const root = yTextToSlateElement(room.document.get('content', Y.XmlText));
  const { document, metrics } = createMaterialDocumentWithMetrics(
    root.children as MaterialValue
  );
  const contentBytes = new TextEncoder().encode(
    JSON.stringify(document)
  ).byteLength;
  const material = db.materials.find((row) => row.id === room.target.id);
  if (material && room.dirty) {
    material.content = document as Material['content'];
    material.contentBytes = contentBytes;
    material.maxDepth = metrics.maxDepth;
    material.nodeCount = metrics.nodeCount;
    material.updatedAt = new Date().toISOString();
  }
  // Keep mounted editors on Yjs; the next detail read refreshes the projection.
  if (room.dirty) {
    void queryClient.invalidateQueries({
      queryKey: qk.material(room.target.id),
      refetchType: 'none',
    });
  }
  return { contentBytes, ...metrics };
}

/** Every writer uses the same mock persistence path, including headless peers
 * and the last participant leaving before its editor's debounce fires. */
export function checkpointRoom(room: Room) {
  if (room.retired) return;
  if (room.target.kind === 'item') persistItem(room);
  const metrics =
    room.target.kind === 'material' ? persistMaterial(room) : undefined;
  if (room.dirty) room.version += 1;
  rememberCheckpoint(room);
  room.dirty = false;
  return metrics;
}

function rememberCheckpoint(room: Room) {
  checkpoints.set(room.name, {
    updates: [...(checkpoints.get(room.name)?.updates ?? []), ...room.pending],
    version: room.version,
  });
  room.pending = [];
  if (
    room.target.id.startsWith('mock-scenario-') &&
    typeof sessionStorage !== 'undefined'
  ) {
    sessionStorage.setItem(
      `capy.scenario.room.${room.name}`,
      JSON.stringify({
        state: [...Y.encodeStateAsUpdate(room.document)],
        version: room.version,
      })
    );
  }
}

export function sourceRoomState(room: Room): string {
  return base64(Y.encodeStateAsUpdate(room.document));
}

/** A source's last saved state, as the server's lock-free viewer read
 * (`source-session?view=true`) returns it: the latest epoch's checkpoint once
 * a save landed, null while the published bytes are current. Saving does not
 * publish: the file's link keeps its bytes. */
export function savedSourceState(fileId: string): string | null {
  let latest: { checkpoint: Checkpoint; epoch: number } | null = null;
  for (const [name, checkpoint] of checkpoints) {
    const match = /^source:(.+):epoch:(\d+)$/.exec(name);
    const epoch = Number(match?.[2]);
    if (match?.[1] === fileId && (!latest || epoch > latest.epoch))
      latest = { checkpoint, epoch };
  }
  return latest && latest.checkpoint.version > 0
    ? base64(checkpointState(latest.checkpoint))
    : null;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

/** Joins the participant to the room: merges both ways, then relays document
 * and awareness updates until the returned leave function runs. The room is
 * dropped with its last participant. */
export function join(room: Room, participant: Participant) {
  if (rooms.get(room.name) !== room) {
    throw new Error(`Mock room ${room.name} is no longer active`);
  }
  const forward = (update: Uint8Array, origin: unknown) => {
    if (origin !== participant.origin)
      Y.applyUpdate(room.document, update, participant);
  };
  Y.applyUpdate(
    room.document,
    Y.encodeStateAsUpdate(participant.document),
    participant
  );
  Y.applyUpdate(
    participant.document,
    Y.encodeStateAsUpdate(room.document),
    participant.origin
  );
  participant.document.on('update', forward);

  const awareness = participant.awareness;
  const relay = (
    {
      added,
      removed,
      updated,
    }: { added: number[]; removed: number[]; updated: number[] },
    origin: unknown
  ) => {
    if (origin === REMOTE || !awareness) return;
    const update = encodeAwarenessUpdate(awareness, [
      ...added,
      ...updated,
      ...removed,
    ]);
    for (const other of room.participants) {
      if (other !== participant && other.awareness)
        applyAwarenessUpdate(other.awareness, update, REMOTE);
    }
  };
  if (awareness) {
    awareness.on('update', relay);
    // Existing presence, so a late joiner sees cursors already in the room.
    for (const other of room.participants) {
      if (other.awareness && other !== participant) {
        applyAwarenessUpdate(
          awareness,
          encodeAwarenessUpdate(other.awareness, [
            ...other.awareness.getStates().keys(),
          ]),
          REMOTE
        );
      }
    }
  }
  room.participants.add(participant);
  announcePresence(room);
  return () => {
    if (!room.participants.delete(participant)) return;
    participant.onPresence?.([]);
    announcePresence(room);
    participant.document.off('update', forward);
    if (awareness) {
      awareness.off('update', relay);
      // Like Hocuspocus on disconnect: the others forget this client, and this
      // client forgets the others but keeps its own state.
      for (const other of room.participants) {
        if (other.awareness)
          removeAwarenessStates(other.awareness, [awareness.clientID], REMOTE);
      }
      removeAwarenessStates(
        awareness,
        [...awareness.getStates().keys()].filter(
          (client) => client !== awareness.clientID
        ),
        REMOTE
      );
    }
    if (room.participants.size === 0) {
      const changed = room.dirty;
      if (
        !room.retired &&
        !room.checkpointFailed &&
        !failedSourceSaves.has(room.target.id)
      ) {
        if (changed) checkpointRoom(room);
        else rememberCheckpoint(room);
      }
      rooms.delete(room.name);
      room.document.destroy();
      if (changed && room.target.kind === 'material') {
        void queryClient.invalidateQueries({
          queryKey: qk.material(room.target.id),
        });
      }
    }
  };
}

// The collaboration service as the browser reaches it: not while offline,
// nor while a journey marks it unreachable (kept across a reload, so a
// reopened editor can wait for it).
const UNREACHABLE = 'capy.mock.collaboration.unreachable';
const REACHABILITY = 'capy:mock-collaboration-reachability';
/** How many times this tab's source providers joined a room. */
const SOURCE_JOINS = 'capy.mock.sourceJoins';
// Unit tests run without a window: always reachable there.
const browser = typeof window !== 'undefined';
// The Office bench's co-editor case edits a source room as a second peer
// (bench/editor/scripts/runtime.office.ts); only in its load-test build.
if (browser && import.meta.env.VITE_LOAD_TEST_SEED === 'true')
  (window as Window & { __capyMockRooms?: typeof rooms }).__capyMockRooms =
    rooms;
function reachable() {
  return (
    !browser ||
    (navigator.onLine && sessionStorage.getItem(UNREACHABLE) !== 'true')
  );
}
/** Another editor of a note, headless (e2e): its own document and presence in
 * the note's mock room, to write blocks and set awareness as a peer would. */
export function mockNotePeer(materialId: string) {
  const room = rooms.get(mockMaterialRoom(materialId));
  if (!room) throw new Error(`Mock room for ${materialId} is not open`);
  const document = new Y.Doc();
  const awareness = new Awareness(document);
  const leave = join(room, { awareness, document, origin: {} });
  const root = document.get('content', Y.XmlText);
  const indexOf = (id: string) =>
    (root.toDelta() as Array<{ insert: unknown }>).findIndex(
      (op) =>
        op.insert instanceof Y.XmlText && op.insert.getAttribute('id') === id
    );
  return {
    append: (blocks: MaterialValue) =>
      root.applyDelta([
        { retain: root.length },
        ...slateNodesToInsertDelta(blocks),
      ]),
    awareness,
    /** The peer's own document, for edits inside a block (a figure's map). */
    document,
    leave,
    /** Deletes the top-level block `id`, or the one at an index. */
    remove: (block: string | number) =>
      root.delete(typeof block === 'number' ? block : indexOf(block), 1),
    /** Puts `block` where the top-level block `id` is. */
    replace: (id: string, block: MaterialValue[number]) => {
      const index = indexOf(id);
      document.transact(() => {
        root.delete(index, 1);
        root.applyDelta([
          { retain: index },
          ...slateNodesToInsertDelta([block]),
        ]);
      });
    },
  };
}

function openRoom(targetId: string) {
  const room = [...rooms.values()].find(
    (candidate) => candidate.target.id === targetId && !candidate.retired
  );
  if (!room) throw new Error(`No mock room is open for ${targetId}`);
  return room;
}

/** Another editor in the open mock room of a material or file, there for
 * the room's presence (screenshots, e2e), with `state` as its awareness (an
 * Office cursor); returns its leave. */
export function mockPresencePeer(
  targetId: string,
  identity: MockIdentity,
  state?: Record<string, unknown>
) {
  const document = new Y.Doc();
  const awareness = state ? new Awareness(document) : undefined;
  const leave = join(openRoom(targetId), {
    awareness,
    document,
    identity,
    origin: {},
  });
  // Set once joined, so the room relays it to the others.
  awareness?.setLocalState(state ?? null);
  return leave;
}

/** This tab's own awareness in a file's open mock room (its Office cursor),
 * for a peer to copy in screenshots and e2e. */
export function mockOwnAwareness(targetId: string) {
  const room = openRoom(targetId);
  for (const provider of sourceProviders)
    if (provider.room === room) return provider.awareness.getLocalState();
  return null;
}

export function setCollaborationReachable(value: boolean) {
  if (value) sessionStorage.removeItem(UNREACHABLE);
  else sessionStorage.setItem(UNREACHABLE, 'true');
  window.dispatchEvent(new Event(REACHABILITY));
}

// A journey's spent open budget (Epo 2026-10-20): a note room's join waits,
// told `onSlowed`, until the flag clears.
const SLOWED = 'capy.mock.collaboration.slowed';

export function setCollaborationSlowed(value: boolean) {
  if (value) sessionStorage.setItem(SLOWED, 'true');
  else sessionStorage.removeItem(SLOWED);
  window.dispatchEvent(new Event(REACHABILITY));
}

// A note whose collaboration-token requests hang, or answer after `delayMs`
// (the join's 30 s, Epo 2026-10-23); kept across page loads, so a first open
// starts held.
const TOKENS_HELD = 'capy.mock.collaboration.tokensHeld';

export function holdNoteTokens(materialId: string | null, delayMs?: number) {
  if (materialId)
    sessionStorage.setItem(
      TOKENS_HELD,
      JSON.stringify({ delayMs: delayMs ?? null, materialId })
    );
  else sessionStorage.removeItem(TOKENS_HELD);
}

/** How long a note's token request waits: null at once, Infinity for ever. */
export function noteTokenDelay(materialId: string): number | null {
  if (!browser) return null;
  const held = JSON.parse(sessionStorage.getItem(TOKENS_HELD) ?? 'null') as {
    delayMs: number | null;
    materialId: string;
  } | null;
  if (held?.materialId !== materialId) return null;
  return held.delayMs ?? Number.POSITIVE_INFINITY;
}

// A note's current room schema, as the service's material_yjs_documents
// row names it (1 until a room moves).
const SCHEMA = 'capy.scenario.schema.';
export function mockMaterialRoom(materialId: string) {
  const schema = browser
    ? Number(sessionStorage.getItem(`${SCHEMA}${materialId}`) ?? 1)
    : 1;
  return `material:${materialId}:schema:${schema}`;
}

/**
 * The service moved a note's room to its next schema while a client was
 * away: a discard of unsaved room state keeps the saved state.
 */
export function moveMockMaterialRoom(materialId: string) {
  const old = mockMaterialRoom(materialId);
  const schema = Number(old.split(':').at(-1)) + 1;
  const next = `material:${materialId}:schema:${schema}`;
  sessionStorage.setItem(`${SCHEMA}${materialId}`, String(schema));
  const live = rooms.get(old);
  if (live) {
    if (live.dirty) checkpointRoom(live);
    if (!live.participants.size) {
      rooms.delete(old);
      live.document.destroy();
    }
    live.retired = true;
  }
  const saved = checkpoints.get(old);
  if (saved) {
    checkpoints.set(next, {
      updates: [...saved.updates],
      version: saved.version,
    });
    const stored = sessionStorage.getItem(`capy.scenario.room.${old}`);
    if (stored) sessionStorage.setItem(`capy.scenario.room.${next}`, stored);
  }
}

interface MockCollaborationOptions {
  /** As the room provider's: no JOIN until it settles (Q360). */
  beforeJoin?: () => Promise<void> | undefined;
  initialValue: MaterialValue;
  materialId: string;
  name: string;
  onAuthenticationFailed?: (event: { reason: string }) => void;
  onPresence?: (connections: PresenceConnection[]) => void;
  onSlowed?: (slowed: boolean) => void;
  onStateless?: (event: { payload: string }) => void;
  /** As the room provider's: the room's state vector before the sync. */
  onStep1?: (stateVector: Uint8Array) => void;
  /** As the room provider's: the stored version the session's JOIN names
   * for drafts it applies (in-place GC). */
  unsentFrom?: number;
}

/** What each note session named (in-place GC), for the late-path e2e: its
 * JOIN version (`unsentFrom`, null for a new session) and the late merge's
 * marks (`unsentFrom()` calls). */
const sessionVersions = new Map<
  string,
  { joins: (number | null)[]; marks: number[]; reported: number }
>();
const versionsOf = (materialId: string) => {
  let versions = sessionVersions.get(materialId);
  if (!versions) {
    versions = { joins: [], marks: [], reported: 0 };
    sessionVersions.set(materialId, versions);
  }
  return versions;
};

/** The JOIN versions and late-merge marks a note's sessions named. */
export function mockSessionVersions(materialId: string) {
  const { joins, marks } = versionsOf(materialId);
  return { joins: [...joins], marks: [...marks] };
}

/** The stored version a note's sessions report from now (as stores the
 * mock does not run would raise it). */
export function setMockReportedVersion(materialId: string, version: number) {
  versionsOf(materialId).reported = version;
}

const outdated = { reason: COLLABORATION_OUTDATED_REASON };
// Set by refuseThisBuild(): a note room refuses every join until the page
// reloads (the reloaded page is the new build).
let buildRefused = false;
// Notes collected past this tab's sessions (in-place GC): a session that
// joined before is answered `collaboration-late` on every join, a new one
// joins, unless every session is late (lateSessions).
const lateMaterials = new Map<string, 'joined' | 'every'>();

class MockCollaborationProvider implements UnifiedProvider {
  readonly awareness: UnifiedProvider['awareness'];
  readonly document: Y.Doc;
  // The room channel the editor reaches through the wrapper, as the capy
  // provider's (a held draft send closes and reopens it, Q327).
  readonly provider: {
    connect: () => void;
    disconnect: () => void;
    readonly reportedVersion: number;
    sendStateless: (payload: string) => void;
    unsentFrom: (version: number) => void;
  };
  readonly type = 'mock';
  isConnected = false;
  isSynced = false;

  private readonly onConnect?: () => void;
  private readonly onDisconnect?: () => void;
  private readonly onError?: (error: Error) => void;
  private readonly onSyncChange?: (isSynced: boolean) => void;
  private readonly options: MockCollaborationOptions;
  private room?: Room;
  private leave?: () => void;
  // Connected unless disconnected on purpose: a lost service reconnects.
  private wanted = false;
  /** This session joined its room before (`lateSessions`). */
  private joined = false;
  // The page's beforeJoin holding the JOIN (a held draft send, Q360).
  private waiting: Promise<void> | null = null;
  private readonly onReachability = () => {
    if (!reachable()) this.drop();
    else if (this.wanted) this.connect();
  };

  constructor({
    awareness,
    doc,
    onConnect,
    onDisconnect,
    onError,
    onSyncChange,
    options,
  }: ProviderConstructorProps<MockCollaborationOptions>) {
    if (!(awareness && doc)) {
      throw new Error('The mock collaboration provider requires a Y.Doc');
    }
    this.awareness = awareness;
    this.document = doc;
    this.onConnect = onConnect;
    this.onDisconnect = onDisconnect;
    this.onError = onError;
    this.onSyncChange = onSyncChange;
    this.options = options;
    const versions = versionsOf(options.materialId);
    versions.joins.push(options.unsentFrom ?? null);
    this.provider = {
      connect: () => this.connect(),
      disconnect: () => this.disconnect(),
      get reportedVersion() {
        return versions.reported;
      },
      sendStateless: (payload: string) => this.handleStateless(payload),
      unsentFrom: (version: number) => {
        versions.marks.push(version);
      },
    };
    if (browser)
      for (const type of ['online', 'offline', REACHABILITY])
        window.addEventListener(type, this.onReachability);
  }

  connect = () => {
    this.wanted = true;
    if (this.isConnected || this.waiting) return;
    // As the room provider: the JOIN waits until it settles, and a connect
    // meanwhile asks nothing more.
    const before = this.options.beforeJoin?.();
    if (before) {
      this.waiting = before;
      void before.then(() => {
        if (this.waiting !== before) return;
        this.waiting = null;
        if (this.wanted) this.connect();
      });
      return;
    }
    if (!reachable()) return;
    if (buildRefused) {
      this.options.onAuthenticationFailed?.(outdated);
      return;
    }
    // The room moved while this editor was away: its token request names the
    // new room, and the editor remounts onto it (NoteEditorCore's token()).
    if (this.options.name !== mockMaterialRoom(this.options.materialId)) {
      void queryClient.invalidateQueries({
        queryKey: ['material', this.options.materialId, 'collaboration-token'],
      });
      return;
    }
    if (browser && sessionStorage.getItem(SLOWED) === 'true') {
      this.options.onSlowed?.(true);
      return;
    }
    if (roomJoinsHeld) return;
    const late = lateMaterials.get(this.options.materialId);
    if (late === 'every' || (late === 'joined' && this.joined)) {
      this.options.onAuthenticationFailed?.({
        reason: COLLABORATION_LATE_REASON,
      });
      return;
    }
    const room = materialRoom(this.options.name, this.options.initialValue);
    this.room = room;
    materialProviders.add(this);
    // As the service: its step 1, the room's vector, before anything syncs.
    this.options.onStep1?.(Y.encodeStateVector(room.document));
    this.leave = join(room, {
      awareness: this.awareness,
      document: this.document,
      onPresence: this.options.onPresence,
      origin: this,
    });
    this.isConnected = true;
    this.isSynced = true;
    this.joined = true;
    this.onConnect?.();
    this.onSyncChange?.(true);
    // As the collaboration server joins a writer of a document holding a
    // block this version cannot edit: read-only, saying why (decision 5).
    if (holdsUnlistedType(room.document.get('content', Y.XmlText)))
      this.options.onStateless?.({
        payload: JSON.stringify({
          code: 'unsupported_block',
          room: this.options.name,
          type: 'room-read-only',
        }),
      });
  };

  disconnect = () => {
    this.wanted = false;
    this.waiting = null;
    this.drop();
  };

  private drop() {
    if (!this.isConnected) return;
    materialProviders.delete(this);
    this.leave?.();
    this.leave = undefined;
    this.room = undefined;
    this.isConnected = false;
    this.isSynced = false;
    this.onSyncChange?.(false);
    this.onDisconnect?.();
  }

  destroy = () => {
    if (browser)
      for (const type of ['online', 'offline', REACHABILITY])
        window.removeEventListener(type, this.onReachability);
    this.disconnect();
  };

  announceOutdated() {
    this.disconnect();
    this.options.onAuthenticationFailed?.(outdated);
  }

  /** The service closed this note's channel (an eviction): the editor
   * rejoins at once, as its reconnector does on the shared socket. */
  evicted(materialId: string) {
    if (this.options.materialId !== materialId || !this.isConnected) return;
    this.drop();
    this.connect();
  }

  /** A room event the service sends this note's editors. */
  announce(materialId: string, event: Record<string, unknown>) {
    if (this.options.materialId !== materialId || !this.isConnected) return;
    if (event.type === 'document-rejected' && this.room)
      this.room.retired = true;
    this.options.onStateless?.({
      payload: JSON.stringify({
        materialId,
        room: this.options.name,
        ...event,
      }),
    });
  }

  announceReadOnly() {
    // The service refused this writer's pending update: nothing after the
    // last checkpoint reaches the durable room.
    if (this.room) this.room.retired = true;
    this.options.onStateless?.({
      payload: JSON.stringify({
        room: this.options.name,
        type: 'room-read-only',
      }),
    });
  }

  private handleStateless(payload: string) {
    if (!this.room) return;
    let event: { id?: unknown; type?: unknown };
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (event.type !== 'checkpoint-request' || typeof event.id !== 'string') {
      return;
    }
    try {
      const metrics = checkpointRoom(this.room);
      this.options.onStateless?.({
        payload: JSON.stringify({
          checkpointIds: [event.id],
          limitCode: null,
          materialId: this.options.materialId,
          metrics,
          type: 'checkpoint-persisted',
          yjsVersion: this.room.version,
        }),
      });
      this.options.onStateless?.({
        payload: JSON.stringify({
          materialId: this.options.materialId,
          type: 'projection-updated',
          yjsVersion: this.room.version,
        }),
      });
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/** Source editing counterpart: the session handler seeded the room, so
 * connecting is a merge plus a `synced` on the next microtask. A checkpoint
 * saves without publishing; View reads it through the viewer's session. */
class MockSourceProvider implements SourceProvider {
  readonly awareness: Awareness;
  /** A DOCX editor's layout worker id (Q219): the mock room checks none. */
  readonly workerClientId = crypto.getRandomValues(new Uint32Array(1))[0] || 2;
  // The in-page room applies updates synchronously.
  readonly hasUnsyncedChanges = false;
  isAuthenticated = true;
  private readonly config: SourceProviderConfig;
  private readonly leave: () => void;
  readonly room: Room;

  constructor(config: SourceProviderConfig) {
    const room = rooms.get(config.name);
    if (room?.target.kind !== 'source') {
      throw new Error(`Unknown mock source room ${config.name}`);
    }
    this.config = config;
    this.room = room;
    this.awareness = new Awareness(config.document);
    this.leave = join(room, {
      awareness: this.awareness,
      document: config.document,
      onPresence: config.onPresence,
      origin: this,
    });
    // Counted for the e2e that checks an open at the size limit never joins.
    if (browser)
      sessionStorage.setItem(
        SOURCE_JOINS,
        String(Number(sessionStorage.getItem(SOURCE_JOINS) ?? 0) + 1)
      );
    sourceProviders.add(this);
    // A held JOIN is never answered on the open socket: no sync, no close.
    if (!roomJoinsHeld)
      queueMicrotask(() => config.onSynced?.({ state: true }));
  }

  sendStateless(payload: string) {
    let event: { id?: unknown; type?: unknown };
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (event.type !== 'checkpoint-request' || typeof event.id !== 'string')
      return;
    const fileId = this.room.target.id;
    if (refusedSourceSaves.delete(fileId)) {
      // Refused for good: the room goes back to its last checkpoint (it is
      // never saved again) and the client keeps its edits for recovery.
      this.room.retired = true;
      const refusal = JSON.stringify({
        checkpointIds: [event.id],
        epoch: Number(this.config.name.split(':')[3]),
        fileId,
        recoverable: false,
        type: 'source-checkpoint-failed',
      });
      queueMicrotask(() => this.config.onStateless?.({ payload: refusal }));
      return;
    }
    if (failedSourceSaves.delete(fileId)) {
      this.room.checkpointFailed = true;
      const receipt = JSON.stringify({
        checkpointIds: [event.id],
        epoch: Number(this.config.name.split(':')[3]),
        fileId,
        recoverable: true,
        type: 'source-checkpoint-failed',
      });
      queueMicrotask(() => this.config.onStateless?.({ payload: receipt }));
      return;
    }
    this.room.checkpointFailed = false;
    checkpointRoom(this.room);
    const epoch = Number(this.config.name.split(':')[3]);
    const receipt = JSON.stringify({
      checkpoint: this.room.version,
      checkpointIds: [event.id],
      epoch,
      fileId,
      type: 'checkpoint-persisted',
    });
    // A round trip, so the receipt lands after the request returns.
    const send = () => this.config.onStateless?.({ payload: receipt });
    if (heldSaveReceipts) heldSaveReceipts.push(send);
    else queueMicrotask(send);
  }

  // The in-page room never closes a connection by itself.
  connect() {}

  disconnect() {
    sourceProviders.delete(this);
    this.isAuthenticated = false;
    this.leave();
    this.config.onDisconnect?.();
  }

  destroy() {
    if (this.isAuthenticated) this.disconnect();
  }

  announceOutdated() {
    this.disconnect();
    this.config.onAuthenticationFailed?.(outdated);
  }

  announceReadOnly() {
    // As for a note: the refused update never reaches the durable room.
    this.room.retired = true;
    this.config.onStateless?.({
      payload: JSON.stringify({
        room: this.config.name,
        type: 'room-read-only',
      }),
    });
  }

  announcePaused(fileId: string) {
    if (this.room.target.id !== fileId) return;
    this.config.onStateless?.({
      payload: JSON.stringify({ fileId, type: 'source-editing-paused' }),
    });
  }

  announceEpoch(fileId: string, newEpoch: number) {
    if (this.room.target.id !== fileId) return;
    this.room.retired = true;
    this.config.onStateless?.({
      payload: JSON.stringify({
        fileId,
        newEpoch,
        type: 'source-epoch-changed',
      }),
    });
  }
}

const sourceProviders = new Set<MockSourceProvider>();
const materialProviders = new Set<MockCollaborationProvider>();
const itemProviders = new Set<MockItemProvider>();
/** A deploy that raised the client protocol: every open room's socket drops
 * and the room refuses this build (`collaboration-outdated`) when it joins
 * again, as a note room does every later join until the page reloads. */
export function refuseThisBuild() {
  buildRefused = true;
  for (const provider of [
    ...materialProviders,
    ...sourceProviders,
    ...itemProviders,
  ])
    provider.announceOutdated();
}
/** The service discarded unsaved state in an open note's room (a writer's
 * update it threw away): the room moves to its next schema with its saved
 * state and closes its editors' channels, whose rejoin names the next room
 * and swaps the editor onto it (Epo 2026-10-22's room swap). */
export function discardMockMaterialRoom(materialId: string) {
  const providers = [...materialProviders];
  moveMockMaterialRoom(materialId);
  for (const provider of providers) provider.evicted(materialId);
}
/** The text the open room of a note holds now (null when none is open),
 * for e2e checks of what reached the room. */
export function mockNoteRoomText(materialId: string): string | null {
  const room = rooms.get(mockMaterialRoom(materialId));
  return room ? room.document.get('content', Y.XmlText).toString() : null;
}
/** A collection left this tab's sessions of a note behind (in-place GC):
 * from now on each answers its next join `collaboration-late`, and a new
 * session joins as usual (`every`: a new one is late too, which the late path
 * takes for a failure); null ends it. */
export function lateSessions(materialId: string | null, every = false) {
  if (materialId) lateMaterials.set(materialId, every ? 'every' : 'joined');
  else lateMaterials.clear();
}
/** The room refuses an open note's update for good (over a limit): its
 * editors keep their unsaved edits as a refused draft. The service refuses
 * the update on entry; the mock applied it already, so its room is retired
 * and the next join loads the last checkpoint, without the update. */
export function rejectMockNoteUpdate(materialId: string) {
  for (const provider of [...materialProviders])
    provider.announce(materialId, {
      code: 'document_size_exceeded',
      type: 'document-rejected',
    });
}
/** The collaboration service's refusal once the account freezes: every open
 * room turns read-only for its writer. */
export function announceReadOnly() {
  for (const provider of [...materialProviders, ...sourceProviders])
    provider.announceReadOnly();
}
const failedSourceSaves = new Set<string>();
export function failNextSourceSave(fileId: string) {
  failedSourceSaves.add(fileId);
}
const refusedSourceSaves = new Set<string>();
export function refuseNextSourceSave(fileId: string) {
  refusedSourceSaves.add(fileId);
}
// Save receipts held back, as a room whose store is busy (a peer's save
// running) sends them late; null when receipts go at once.
let heldSaveReceipts: (() => void)[] | null = null;
export function holdSourceSaveReceipts(hold: boolean) {
  if (hold) {
    heldSaveReceipts ??= [];
    return;
  }
  const held = heldSaveReceipts ?? [];
  heldSaveReceipts = null;
  for (const send of held) send();
}
let roomJoinsHeld = false;
/** Note, Office and text room JOINs from now on are never answered, the
 * socket staying open (the join's 30 s, then its error); joins already in
 * rooms are untouched. */
export function holdRoomJoins(hold: boolean) {
  roomJoinsHeld = hold;
}
let sourceSessionsHeld = false;
/** Office and text edit opens' source-session requests from now on hang. */
export function holdSourceSessions(hold: boolean) {
  sourceSessionsHeld = hold;
}
export const sourceSessionHeld = () => sourceSessionsHeld;
export function announceSourceEpoch(fileId: string, epoch: number) {
  for (const provider of [...sourceProviders])
    provider.announceEpoch(fileId, epoch);
}
/** The maintenance window paused Office editing: open editors keep their
 * view read-only under the paused banner. */
export function announceSourcePaused(fileId: string) {
  for (const provider of [...sourceProviders]) provider.announcePaused(fileId);
}
export function resetScenarioRooms() {
  roomJoinsHeld = false;
  lateMaterials.clear();
  sessionVersions.clear();
  sourceSessionsHeld = false;
  failedSourceSaves.clear();
  refusedSourceSaves.clear();
  holdSourceSaveReceipts(false);
  for (const [name, room] of rooms) {
    if (!room.target.id.startsWith('mock-scenario-')) continue;
    if (room.participants.size)
      throw new Error('Close the scenario editor before resetting its room');
    room.document.destroy();
    rooms.delete(name);
  }
  for (const name of checkpoints.keys()) {
    if (name.includes(':mock-scenario-')) checkpoints.delete(name);
  }
  for (const key of Object.keys(sessionStorage))
    if (key.startsWith('capy.scenario.room.') || key.startsWith(SCHEMA))
      sessionStorage.removeItem(key);
  sessionStorage.removeItem(UNREACHABLE);
}

/** A quiz's other document's room name (`keys:` for `material:`, and back). */
const peerName = (name: string) =>
  name.startsWith('keys:')
    ? `material:${name.slice(5)}`
    : `keys:${name.slice('material:'.length)}`;

/** A document's state from its live room or its checkpoint. */
function docOf(name: string): Y.Doc {
  const live = rooms.get(name);
  if (live) return live.document;
  const doc = new Y.Doc();
  const checkpoint = checkpoints.get(name);
  if (checkpoint) Y.applyUpdate(doc, checkpointState(checkpoint));
  return doc;
}

/* The readers' lists of matching options and ordering items, outside Yjs
 * (D3 as revised 2026-10-10), as the service keeps them: per quiz, part id to
 * its kind and (entry id, text) in the readers' order. A set change shuffles
 * afresh; a text change keeps the order. */
type HeldList = { entries: { id: string; text: string }[]; kind: string };
const readerLists = new Map<string, Map<string, HeldList>>();
const readers = new Map<string, Set<MockItemProvider>>();

function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const asList = (held: HeldList): ReaderList => ({
  items: held.entries.map((entry) => entry.text),
  kind: held.kind as ReaderList['kind'],
});

/** Follows the keys document; returns the parts whose list changed. */
function followReaderLists(contentName: string) {
  const held = readerLists.get(contentName) ?? new Map<string, HeldList>();
  readerLists.set(contentName, held);
  const parts = itemParts(docOf(peerName(contentName)));
  const changed: Record<string, ReaderList | null> = {};
  const present = new Set(parts.map((part) => part.part));
  for (const id of [...held.keys()])
    if (!present.has(id)) {
      held.delete(id);
      changed[id] = null;
    }
  for (const part of parts) {
    const current = held.get(part.part);
    const texts = new Map(part.entries.map((entry) => [entry.id, entry.text]));
    const sameSet =
      current?.kind === part.kind &&
      current.entries.length === part.entries.length &&
      current.entries.every((entry) => texts.has(entry.id));
    const next: HeldList = {
      entries: sameSet
        ? (current as HeldList).entries.map((entry) => ({
            id: entry.id,
            text: texts.get(entry.id) ?? '',
          }))
        : shuffled(part.entries),
      kind: part.kind,
    };
    if (JSON.stringify(next) === JSON.stringify(current)) continue;
    held.set(part.part, next);
    changed[part.part] = asList(next);
  }
  return changed;
}

/** The service's `quiz-items` push after a keys change. */
function pushReaderLists(contentName: string) {
  const changed = followReaderLists(contentName);
  if (!Object.keys(changed).length) return;
  const payload = JSON.stringify({
    full: false,
    parts: changed,
    type: 'quiz-items',
  });
  for (const provider of readers.get(contentName) ?? [])
    provider.stateless(payload);
}

/** The full lists a channel joining the content room hears. */
function fullReaderLists(contentName: string) {
  followReaderLists(contentName);
  const parts = Object.fromEntries(
    [...(readerLists.get(contentName) ?? [])].map(([id, held]) => [
      id,
      asList(held),
    ])
  );
  return JSON.stringify({ full: true, parts, type: 'quiz-items' });
}

/** Kinds whose room holds a Plate note document: a note a live View reads,
 * a standalone diagram's editor. */
const plateKind = (kind: Material['kind']) =>
  kind === 'note' || kind === 'mindmap' || kind === 'diagram';

/** A live item's room (live-items): seeded from the mock row as the service
 * bootstraps one (a quiz's two documents together; a note document, a
 * Mermaid source a text), written back to it as the service projects. */
function itemRoom(name: string): Room {
  const existing = rooms.get(name);
  if (existing) return existing;
  const materialId = name.split(':')[1] ?? '';
  const room = createRoom(name, { id: materialId, kind: 'item' });
  const material = db.materials.find((row) => row.id === materialId);
  if (!checkpoints.has(name) && material?.kind === 'flashcards')
    seedCards(room.document, db.cardsFromMaterial(material));
  if (!checkpoints.has(name) && material && plateKind(material.kind))
    room.document
      .get('content', Y.XmlText)
      .applyDelta(slateNodesToInsertDelta(material.content.value));
  if (!checkpoints.has(name) && material?.kind === 'quiz') {
    const content = new Y.Doc();
    const keys = new Y.Doc();
    seedQuiz(content, keys, db.quizFromMaterial(material).questions);
    const own = name.startsWith('keys:') ? keys : content;
    Y.applyUpdate(room.document, Y.encodeStateAsUpdate(own));
    const other = name.startsWith('keys:') ? content : keys;
    checkpoints.set(peerName(name), {
      updates: [Y.encodeStateAsUpdate(other)],
      version: 0,
    });
  }
  room.dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  room.document.on('update', () => {
    if (material?.kind === 'quiz' && name.startsWith('keys:'))
      queueMicrotask(() => pushReaderLists(peerName(name)));
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (rooms.get(name) === room) checkpointRoom(room);
    }, 300);
  });
  return room;
}

/** The projection: a set's cards, or a quiz's complete questions (D4). */
function persistItem(room: Room) {
  const material = db.materials.find((row) => row.id === room.target.id);
  if (!(material && room.dirty)) return;
  if (plateKind(material.kind)) {
    persistMaterial(room);
    return;
  }
  if (material.kind === 'quiz') {
    const contentName = room.name.startsWith('keys:')
      ? peerName(room.name)
      : room.name;
    const complete = readQuestions(
      docOf(contentName),
      docOf(peerName(contentName))
    )
      .map(withoutBlanks)
      .filter((question) => {
        try {
          validateQuestion(question);
          return true;
        } catch {
          return false;
        }
      });
    material.content = createMaterialDocument([
      quizNode({ questions: complete }, material.id),
    ]) as Material['content'];
    material.revision += 1;
    material.updatedAt = new Date().toISOString();
    db.refreshMaterialContentBytes(material);
    void queryClient.invalidateQueries({ queryKey: qk.material(material.id) });
    void queryClient.invalidateQueries({ queryKey: qk.quiz(material.id) });
    return;
  }
  const cards = readCards(room.document);
  material.content = createMaterialDocument([
    flashcardsNode(cards, material.id),
  ]) as Material['content'];
  material.revision += 1;
  material.updatedAt = new Date().toISOString();
  db.refreshMaterialContentBytes(material);
  for (const card of cards)
    db.flashcardCards[card.id] ??= { materialId: material.id };
  void queryClient.invalidateQueries({ queryKey: qk.material(material.id) });
}

class MockItemProvider implements ItemProvider {
  private readonly leave: () => void;
  private readonly config: RoomProviderConfig;
  private joined = true;

  constructor(config: RoomProviderConfig) {
    this.config = config;
    itemProviders.add(this);
    const room = itemRoom(config.name);
    this.leave = join(room, {
      document: config.document,
      onPresence: config.onPresence,
      origin: this,
    });
    const quiz =
      config.name.startsWith('material:') &&
      db.materials.find((row) => row.id === room.target.id)?.kind === 'quiz';
    if (quiz) {
      const listening = readers.get(config.name) ?? new Set();
      listening.add(this);
      readers.set(config.name, listening);
    }
    queueMicrotask(() => {
      config.onSynced?.({ state: true });
      if (quiz) this.stateless(fullReaderLists(config.name));
    });
  }

  stateless(payload: string) {
    if (this.joined) this.config.onStateless?.({ payload });
  }

  /** A checkpoint request: the in-page room holds every edit already. */
  sendStateless(payload: string) {
    const request = JSON.parse(payload) as { id?: string; type?: string };
    if (request.type !== 'checkpoint-request' || !request.id) return;
    const receipt = JSON.stringify({
      checkpointIds: [request.id],
      materialId: this.config.name.split(':')[1],
      type: 'checkpoint-persisted',
    });
    queueMicrotask(() => this.stateless(receipt));
  }

  connect() {}

  wake() {}

  announceOutdated() {
    this.disconnect();
    this.config.onAuthenticationFailed?.(outdated);
  }

  disconnect() {
    if (!this.joined) return;
    this.joined = false;
    itemProviders.delete(this);
    readers.get(this.config.name)?.delete(this);
    this.leave();
    this.config.onDisconnect?.();
  }

  destroy() {
    this.disconnect();
  }
}

export function registerMockCollaborationProvider() {
  registerProviderType('mock', MockCollaborationProvider);
  registerMockSourceProvider((config) => new MockSourceProvider(config));
  registerMockItemProvider((config) => new MockItemProvider(config));
}
