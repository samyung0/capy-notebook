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
import { BOARD_CATALOG } from '@/api/board.generated';
import { qk } from '@/api/client';
import { queryClient } from '@/api/queryClient';
import type { Material } from '@/api/types';
import {
  encodeCaret,
  readBoardPresence,
} from '@/features/canvas/boardPresence';
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
  COLLABORATION_NOT_FOUND_REASON,
  COLLABORATION_OUTDATED_REASON,
} from '@/features/notes/collaborationEvents';
import '@/features/notes/figureBinding';
import { MAX_PRESENCE_BYTES } from '@/features/notes/notePresence';
import { withoutBlanks } from '@/features/questions/types';
import { validateQuestion } from '@/features/questions/validation';
import {
  itemParts,
  type ReaderList,
  readQuestions,
  seedQuiz,
} from '@/features/quizzes/liveQuiz';
import { base64ToBytes, bytesToBase64 } from '@/lib/base64';
import {
  isMockCanvas,
  mockCanvasAccess,
  narrowMockCanvas,
  projectMockCanvas,
  unshareMockCanvas,
} from './canvas';
import * as db from './db';
import { draftQuizQuestions } from './extraction';

/** In-page stand-in for the collaboration sidecar. A room is one Y.Doc that
 * every participant (the app's editor, the source editor, chaos peers) merges
 * into; document and awareness updates fan out to the other participants. */

/** `origin` tags inbound updates the way Hocuspocus tags them with the
 * provider, so consumers can tell remote transactions from their own. A
 * participant with an `identity` is an editor in the room's presence; one
 * with `onPresence` hears the others', as the service sends it. */
interface Participant {
  /** A board room's channel: a `read` one that writes is closed. */
  access?: 'read' | 'write';
  awareness?: Awareness;
  document: Y.Doc;
  identity?: MockIdentity;
  onPresence?: (connections: PresenceConnection[]) => void;
  /** A board room refused this participant's update, which never reached
   * it: sent on a read channel, or taking the board over its cap. */
  onRefused?: (why: 'read-only' | 'size') => void;
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
  /** A board room's state in bytes, estimated as the service does: measured
   * when the room opens and when an update would pass the cap, and grown by
   * each update's size in between. */
  bytes?: number;
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
    | { kind: 'board'; id: string }
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
    // A device copy of a load-test or scenario note merges with its reseeded
    // room: the same items, not a second copy of the note.
    if (
      import.meta.env.VITE_LOAD_TEST_SEED === 'true' ||
      materialId.startsWith('mock-scenario-')
    )
      room.document.clientID = 7;
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
  if (room.target.kind === 'board') projectBoard(room);
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
  if (room.target.kind === 'board') keepBoard(room);
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
    if (origin === participant.origin) return;
    const refused =
      room.target.kind === 'material'
        ? refusedNoteUpdates.get(room.target.id)
        : undefined;
    if (refused) {
      // Refused on entry: the room never holds it.
      refusedNoteUpdates.delete(room.target.id);
      queueMicrotask(() => rejectMockNoteUpdate(room.target.id, refused));
      return;
    }
    if (
      room.target.kind === 'board' &&
      !admitsBoardUpdate(room, participant, update)
    )
      return;
    Y.applyUpdate(room.document, update, participant);
  };
  // What the JOIN brings is admitted as any update is: a board room takes
  // nothing from a read channel and nothing past its cap.
  const brought =
    room.target.kind === 'board' ? broughtToBoard(room, participant) : null;
  if (!brought || admitsBoardUpdate(room, participant, brought))
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
    if (!relaysPresence(room, awareness)) return;
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
      if (
        other.awareness &&
        other !== participant &&
        relaysPresence(room, other.awareness)
      ) {
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

/** Another editor of the open mock note with its caret `offset` characters
 * into the note's first block, sent as a tab sends it (notePresence.ts), for
 * e2e; returns its leave. */
export function mockPeerCaret(
  targetId: string,
  identity: MockIdentity,
  offset: number
) {
  const document = new Y.Doc();
  const awareness = new Awareness(document);
  const leave = join(openRoom(targetId), {
    awareness,
    document,
    identity,
    origin: {},
  });
  const root = document.get('content', Y.XmlText);
  const [first] = root.toDelta() as { insert: unknown }[];
  const block = first?.insert instanceof Y.XmlText ? first.insert : root;
  const position = Y.createRelativePositionFromTypeIndex(block, offset);
  awareness.setLocalState({
    s: bytesToBase64(Y.encodeRelativePosition(position)),
  });
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

// A note whose collaboration-token requests hang until let go, or answer after
// `delayMs` (the join's 30 s, Epo 2026-10-23); kept across page loads, so a first
// open starts held.
const TOKENS_HELD = 'capy.mock.collaboration.tokensHeld';
const TOKENS_LET_GO = 'capy:mock-collaboration-tokens-let-go';

export function holdNoteTokens(materialId: string | null, delayMs?: number) {
  if (materialId)
    sessionStorage.setItem(
      TOKENS_HELD,
      JSON.stringify({ delayMs: delayMs ?? null, materialId })
    );
  else {
    sessionStorage.removeItem(TOKENS_HELD);
    window.dispatchEvent(new Event(TOKENS_LET_GO));
  }
}

/** Waits as long as a note's token request is held: at once when it isn't. */
export async function noteTokenHold(materialId: string) {
  if (!browser) return;
  const held = JSON.parse(sessionStorage.getItem(TOKENS_HELD) ?? 'null') as {
    delayMs: number | null;
    materialId: string;
  } | null;
  if (held?.materialId !== materialId) return;
  await new Promise<void>((resolve) => {
    if (held.delayMs === null)
      window.addEventListener(TOKENS_LET_GO, () => resolve(), { once: true });
    else setTimeout(resolve, held.delayMs);
  });
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
const refused = { reason: COLLABORATION_NOT_FOUND_REASON };
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

  announceRefused() {
    this.disconnect();
    this.options.onAuthenticationFailed?.(refused);
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
  private leave: () => void;
  room: Room;
  /** A drain closed the channel on an open socket (`announceMoved`): the
   * reconnect's `connect` joins the room again, reopened from its
   * checkpoint once the last participant left. */
  private drained = false;
  socketStatus?: 'connected';

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

  // The in-page room never closes a connection by itself; after a drain
  // the reconnect joins again.
  connect() {
    if (!this.drained) return;
    this.drained = false;
    this.socketStatus = undefined;
    this.isAuthenticated = true;
    sourceProviders.add(this);
    this.room = sourceRoom(
      this.room.target.id,
      Number(this.config.name.split(':')[3]),
      '',
      undefined,
      this.room.format
    );
    this.leave = join(this.room, {
      awareness: this.awareness,
      document: this.config.document,
      onPresence: this.config.onPresence,
      origin: this,
    });
    queueMicrotask(() => this.config.onSynced?.({ state: true }));
  }

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

  announceRefused() {
    this.disconnect();
    this.config.onAuthenticationFailed?.(refused);
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

  /** A Move (Q454): the room names it, then drains and closes the channel
   * on the open socket, and the tab rejoins. */
  announceMoved(fileId: string, workspaceId: string) {
    if (this.room.target.id !== fileId) return;
    this.config.onStateless?.({
      payload: JSON.stringify({
        evictionId: crypto.randomUUID(),
        fileId,
        mode: 'drain',
        room: this.config.name,
        type: 'file-moved',
        workspaceId,
      }),
    });
    this.drained = true;
    this.socketStatus = 'connected';
    this.config.onClose?.({ code: 0, reason: 'socket closed' });
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
/** A note room as a spec checks it: its top-level block types, whether a
 * participant wrote since it loaded, and its whole state. */
export function mockNoteRoomState(materialId: string) {
  const room = rooms.get(mockMaterialRoom(materialId));
  if (!room) return null;
  const root = room.document.get('content', Y.XmlText);
  return {
    blocks: (root.toDelta() as { insert: unknown }[]).map(({ insert }) =>
      insert instanceof Y.XmlText ? String(insert.getAttribute('type')) : ''
    ),
    dirty: room.dirty,
    state: Array.from(Y.encodeStateAsUpdate(room.document)),
  };
}

export function lateSessions(materialId: string | null, every = false) {
  if (materialId) lateMaterials.set(materialId, every ? 'every' : 'joined');
  else lateMaterials.clear();
}
/** The room refuses an open note's update for good (over a limit, or
 * `unassigned`: written under an id the room never recorded): its editors
 * keep their unsaved edits as a refused draft. The service refuses the
 * update on entry; the mock applied it already, so its room is retired and
 * the next join loads the last checkpoint, without the update. */
export function rejectMockNoteUpdate(
  materialId: string,
  code: NoteRefusal = 'document_size_exceeded'
) {
  for (const provider of [...materialProviders])
    provider.announce(materialId, { code, type: 'document-rejected' });
}
type NoteRefusal = 'document_size_exceeded' | 'unassigned';
const refusedNoteUpdates = new Map<string, NoteRefusal>();
/** The room refuses the next update a tab of the note sends, on entry, as
 * the service does: the room never holds it (unlike `rejectMockNoteUpdate`,
 * which refuses after the mock applied it). */
export function refuseNextMockNoteUpdate(
  materialId: string,
  code: NoteRefusal = 'unassigned'
) {
  refusedNoteUpdates.set(materialId, code);
}
/** A draft group the service admitted (the e2e `/drafts` stub, Q436): its
 * update goes into the note's open room as the service applies it. */
export function admitMockNoteDrafts(materialId: string, update: Uint8Array) {
  const room = rooms.get(mockMaterialRoom(materialId));
  if (!room) throw new Error(`Mock room for ${materialId} is not open`);
  Y.applyUpdate(room.document, update);
}
/** Every open room refuses this reader when it rejoins: it was hidden from
 * them, or they lost their access. Returns how many there were. */
export function refuseOpenRooms() {
  const open = [...materialProviders, ...sourceProviders, ...itemProviders];
  for (const provider of open) provider.announceRefused();
  return open.length;
}
/** The collaboration service's refusal once the account freezes, or a writer
 * lowered to a reader: every open room turns read-only for its writer. Returns
 * how many there were. */
export function announceReadOnly() {
  const open = [...materialProviders, ...sourceProviders, ...itemProviders];
  for (const provider of open) provider.announceReadOnly();
  return open.length;
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
/** A Move of an open source file to `workspaceId` (Q454): the mock file row
 * moves, then every open room of it says so and drains. */
export function announceSourceMoved(fileId: string, workspaceId: string) {
  const file = db.files.find((row) => row.id === fileId);
  if (file) {
    file.workspaceId = workspaceId;
    file.topicId = null;
  }
  for (const provider of [...sourceProviders])
    provider.announceMoved(fileId, workspaceId);
}
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
    seedQuiz(
      content,
      keys,
      draftQuizQuestions.get(material.id) ??
        db.quizFromMaterial(material).questions
    );
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

  announceRefused() {
    this.disconnect();
    this.config.onAuthenticationFailed?.(refused);
  }

  announceReadOnly() {
    this.config.onStateless?.({
      payload: JSON.stringify({
        room: this.config.name,
        type: 'room-read-only',
      }),
    });
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

/* A canvas's board room (Epo 2026-11-18), as the service runs one: seeded with
 * the editor's own first state, relaying each update to the other participants
 * under their provider's origin, closing a read channel that writes and the
 * writer whose update takes the board over its cap, and answering a
 * checkpoint request with its receipt. Its state is kept across a reload (the
 * tab's sessionStorage), as the service stores it. A presence state is
 * relayed when the board's field list admits it (`relaysPresence`). */

const BOARD_MAX = BOARD_CATALOG.limits.CANVAS_BOARD_MAX;
const BOARD_STATE = 'capy.mock.board.';

/** The editor's own first state (`boardFirstState.ts`), which the service
 * seeds a canvas's room with. Loaded when the first board room opens: the
 * board's modules stay out of the mocks' own. */
const firstStateModule = import.meta.glob<{
  boardFirstState: () => Uint8Array;
}>('/src/features/blocksuite/boardFirstState.ts');
async function boardFirstState() {
  const [load] = Object.values(firstStateModule);
  return (await load()).boardFirstState();
}

/** The service's presence check (`Fields::Board`, `on_awareness`): a board
 * room keeps and relays a participant's state only when every field is one a
 * board lists, within its bounds and the room's 4 KiB; any other is dropped
 * and the sender hears nothing. A removal always goes. Other rooms relay
 * what comes. */
function relaysPresence(room: Room, awareness: Awareness) {
  const state = awareness.getLocalState();
  if (room.target.kind !== 'board' || state === null) return true;
  return (
    readBoardPresence(state) !== null &&
    new TextEncoder().encode(JSON.stringify(state)).length <= MAX_PRESENCE_BYTES
  );
}

/** The service's admission of a board update: whether the room takes it. */
function admitsBoardUpdate(
  room: Room,
  participant: Participant,
  update: Uint8Array
) {
  const refuse = (why: 'read-only' | 'size') => {
    queueMicrotask(() => participant.onRefused?.(why));
    return false;
  };
  if (!update.byteLength) return true;
  if (participant.access === 'read') return refuse('read-only');
  const measured = () => Y.encodeStateAsUpdate(room.document).byteLength;
  room.bytes ??= measured();
  if (room.bytes + update.byteLength > BOARD_MAX) {
    room.bytes = measured();
    if (room.bytes + update.byteLength > BOARD_MAX) return refuse('size');
  }
  room.bytes += update.byteLength;
  return true;
}

/** What a joining document holds that its board room does not, as one update;
 * an empty one when it brings nothing (a fresh tab, a tab back from a drop
 * that drew nothing meanwhile). */
function broughtToBoard(room: Room, participant: Participant) {
  const probe = new Y.Doc();
  Y.applyUpdate(probe, Y.encodeStateAsUpdate(room.document));
  let brought: Uint8Array = new Uint8Array();
  probe.on('update', (update: Uint8Array) => {
    brought = update;
  });
  Y.applyUpdate(probe, Y.encodeStateAsUpdate(participant.document));
  probe.destroy();
  return brought;
}

/** The service's projection: the images the board holds, each id once, in
 * order, at the room's stored version. */
function projectBoard(room: Room) {
  if (!room.dirty) return;
  const ids = new Set<string>();
  for (const block of room.document.getMap<unknown>('blocks').values()) {
    if (!(block instanceof Y.Map)) continue;
    if (block.get('sys:flavour') !== 'affine:image') continue;
    const id: unknown = block.get('prop:sourceId');
    if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)) ids.add(id);
  }
  projectMockCanvas(room.target.id, room.version + 1, [...ids].sort());
}

/** A board room's stored state, kept for the tab: a reload opens it again.
 * A tab's sessionStorage holds about 5 MB, less than a board near its cap
 * takes as text: such a board is kept for the page's life alone, and its
 * older copy goes so a reload cannot open a stale one. */
function keepBoard(room: Room) {
  if (!browser) return;
  const key = BOARD_STATE + room.name;
  try {
    sessionStorage.setItem(
      key,
      JSON.stringify({
        state: bytesToBase64(Y.encodeStateAsUpdate(room.document)),
        version: room.version,
      })
    );
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'QuotaExceededError'))
      throw error;
    sessionStorage.removeItem(key);
  }
}

function boardRoom(name: string, firstState: Uint8Array): Room {
  const existing = rooms.get(name);
  if (existing) return existing;
  const kept = browser ? sessionStorage.getItem(BOARD_STATE + name) : null;
  if (kept && !checkpoints.has(name)) {
    const { state, version } = JSON.parse(kept) as {
      state: string;
      version: number;
    };
    checkpoints.set(name, { updates: [base64ToBytes(state)], version });
  }
  const room = createRoom(name, {
    id: name.split(':')[1] ?? '',
    kind: 'board',
  });
  // A first open: the page and its canvas, under the seed's own client id.
  if (!checkpoints.has(name)) Y.applyUpdate(room.document, firstState);
  room.dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  room.document.on('update', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (rooms.get(name) === room) checkpointRoom(room);
    }, 300);
  });
  return room;
}

const boardProviders = new Set<MockBoardProvider>();

class MockBoardProvider implements ItemProvider {
  private readonly config: RoomProviderConfig;
  private leave: (() => void) | null = null;
  /** The channel the tab holds in the room now; none while it is out. */
  channel: 'read' | 'write' | null = null;
  /** Connected unless disconnected on purpose. */
  private wanted = false;
  private joining = false;
  private down = false;
  private previousToken: string | undefined;
  /** The room holds an update of this tab's as soon as it took it: nothing
   * stays unacknowledged, and the room is asked for its receipt. */
  private readonly sent = (_: Uint8Array, origin: unknown) => {
    if (origin === this) return;
    queueMicrotask(() => {
      if (this.leave) this.config.onUnsyncedChanges?.({ number: 0 });
    });
  };

  constructor(config: RoomProviderConfig) {
    this.config = config;
    boardProviders.add(this);
  }

  get materialId() {
    return this.config.name.split(':')[1] ?? '';
  }

  /** What the tab says of itself, relayed or not; null while it says nothing. */
  get presence() {
    return this.config.awareness?.getLocalState() ?? null;
  }

  connect() {
    this.wanted = true;
    void this.join();
  }

  /** A JOIN, as the room provider's: a fresh token first, whose refusal is
   * the join's; then the room, by the access the mock user has now. */
  private async join() {
    if (this.leave || this.joining || this.down) return;
    this.joining = true;
    try {
      let firstState: Uint8Array;
      try {
        this.previousToken = await this.config.token(this.previousToken);
        firstState = await boardFirstState();
      } catch (error) {
        if (this.wanted)
          this.config.onAuthenticationFailed?.({
            reason: `Failed to get token: ${error instanceof Error ? error.message : String(error)}`,
          });
        return;
      }
      if (!this.wanted || this.down) return;
      const access = mockCanvasAccess(this.materialId);
      if (!access) {
        this.config.onAuthenticationFailed?.(refused);
        return;
      }
      const write = access === 'write';
      this.channel = access;
      this.leave = join(boardRoom(this.config.name, firstState), {
        access,
        // A viewer sends no presence and hears none.
        awareness: (write && this.config.awareness) || undefined,
        document: this.config.document,
        onPresence: write ? this.config.onPresence : undefined,
        onRefused: (why) => this.refusedUpdate(why),
        origin: this,
      });
      this.config.document.on('update', this.sent);
      this.config.onSynced?.({ state: true });
    } finally {
      this.joining = false;
    }
  }

  private refusedUpdate(why: 'read-only' | 'size') {
    if (!this.leave) return;
    if (why === 'size') {
      this.config.onStateless?.({
        payload: JSON.stringify({
          code: 'document_size_exceeded',
          limits: { maxContentBytes: BOARD_MAX },
          room: this.config.name,
          type: 'document-rejected',
        }),
      });
      this.close(4400, 'document rejected');
      return;
    }
    this.close(4400, 'read-only connection sent a document update');
  }

  /** The service closed this channel alone. */
  close(code: number, reason: string) {
    if (!this.leave) return;
    this.drop();
    this.config.onClose?.({ code, reason });
  }

  /** The tab's socket dropped, or is back (`mockBoardSocket`): while it is
   * down nothing is sent or heard, and the tab joins again as it returns. */
  socket(up: boolean) {
    this.down = !up;
    if (up) {
      if (this.wanted) void this.join();
    } else this.close(1006, 'socket closed');
  }

  /** A checkpoint request: the room stores now and answers its receipt. */
  sendStateless(payload: string) {
    const request = JSON.parse(payload) as { id?: string; type?: string };
    if (request.type !== 'checkpoint-request' || !request.id) return;
    const room = rooms.get(this.config.name);
    if (!(room && this.leave)) return;
    checkpointRoom(room);
    const receipt = JSON.stringify({
      checkpointIds: [request.id],
      materialId: this.materialId,
      type: 'checkpoint-persisted',
      yjsVersion: room.version,
    });
    queueMicrotask(() => {
      if (this.leave) this.config.onStateless?.({ payload: receipt });
    });
  }

  wake() {}

  private drop() {
    this.config.document.off('update', this.sent);
    this.leave?.();
    this.leave = null;
    this.channel = null;
  }

  disconnect() {
    this.wanted = false;
    if (!this.leave) return;
    this.drop();
    this.config.onDisconnect?.();
  }

  destroy() {
    this.disconnect();
    boardProviders.delete(this);
  }
}

/** The open board room of a canvas. */
function openBoard(materialId: string) {
  const room = rooms.get(`material:${materialId}:schema:1`);
  if (!room) throw new Error(`Mock board room for ${materialId} is not open`);
  return room;
}

/** Another person on a canvas, headless (e2e): its own document and presence
 * in the canvas's mock room, to draw and set awareness as a peer would. With
 * an `identity` the room's presence names them, so their marks are drawn. */
export function mockBoardPeer(materialId: string, identity?: MockIdentity) {
  const document = new Y.Doc();
  const awareness = new Awareness(document);
  const leave = join(openBoard(materialId), {
    access: 'write',
    awareness,
    document,
    identity,
    origin: {},
  });
  /** The canvas's elements by id, as the board's surface block keeps them. */
  const canvas = () => {
    for (const block of document.getMap<unknown>('blocks').values()) {
      if (!(block instanceof Y.Map)) continue;
      if (block.get('sys:flavour') !== 'affine:surface') continue;
      const elements: unknown = block.get('prop:elements');
      const value = elements instanceof Y.Map ? elements.get('value') : null;
      if (value instanceof Y.Map) return value as Y.Map<Y.Map<unknown>>;
    }
    throw new Error('The board room holds no canvas');
  };
  return {
    /** Draws a canvas element with these fields under `id` (`type`, `xywh`,
     * `index`…, as the board stores one). */
    add: (id: string, fields: Record<string, unknown>) => {
      const element = new Y.Map<unknown>();
      // A connector's label is a text of its own.
      for (const [key, value] of Object.entries({ ...fields, id }))
        element.set(
          key,
          key === 'text' && typeof value === 'string'
            ? new Y.Text(value)
            : value
        );
      canvas().set(id, element);
    },
    awareness,
    /** A caret `index` characters into the block text that reads `words` (a
     * note's paragraph), with `end` a range from there to it, as a tab's
     * presence holds them (boardPresence.ts). */
    caret: (words: string, index: number, end?: number) => {
      for (const block of document.getMap<unknown>('blocks').values()) {
        const text = block instanceof Y.Map ? block.get('prop:text') : null;
        if (!(text instanceof Y.Text && text.toString() === words)) continue;
        return {
          f: end === undefined ? undefined : encodeCaret({ index: end, text }),
          s: encodeCaret({ index, text }),
        };
      }
      throw new Error(`The board room holds no text "${words}"`);
    },
    /** Changes fields of the element `id` (moves it, by its `xywh`). */
    change: (id: string, fields: Record<string, unknown>) => {
      const element = canvas().get(id);
      if (!element) throw new Error(`The board room holds no element ${id}`);
      document.transact(() => {
        for (const [key, value] of Object.entries(fields))
          element.set(key, value);
      });
    },
    /** The peer's own document. */
    document,
    /** The canvas's elements as the peer holds them, by id. */
    elements: () =>
      canvas().toJSON() as Record<string, Record<string, unknown>>,
    /** Pastes an image block `id` whose file is stored as `sourceId`, as a
     * peer's tab adds one. */
    image: (id: string, sourceId: string) => {
      const blocks = document.getMap<Y.Map<unknown>>('blocks');
      const surface = [...blocks.values()].find(
        (block) => block.get('sys:flavour') === 'affine:surface'
      );
      const children = surface?.get('sys:children');
      if (!(children instanceof Y.Array))
        throw new Error('The board room holds no canvas');
      const block = new Y.Map<unknown>();
      for (const [key, value] of Object.entries({
        'prop:height': 540,
        'prop:index': 'a0',
        'prop:rotate': 0,
        'prop:size': 1240,
        'prop:sourceId': sourceId,
        'prop:width': 960,
        'prop:xywh': '[0,0,320,180]',
        'sys:children': new Y.Array<string>(),
        'sys:flavour': 'affine:image',
        'sys:id': id,
        'sys:version': 1,
      }))
        block.set(key, value);
      document.transact(() => {
        blocks.set(id, block);
        children.push([id]);
      });
    },
    leave,
    remove: (id: string) => canvas().delete(id),
  };
}

/** The canvas's maker took it back from the workspace while the mock user was
 * in (e2e): the service closes the channels of the people it took something
 * from (4403), and their next token is refused. */
export function mockRevokeBoard(materialId: string) {
  unshareMockCanvas(materialId);
  for (const provider of [...boardProviders])
    if (provider.materialId === materialId && !mockCanvasAccess(materialId))
      provider.close(4403, 'collaboration access changed');
}

/** Fills a canvas's open room to the edge of its cap (e2e), as a peer's
 * drawing would: one element no editor reads, which a board keeps and draws
 * as a placeholder. The next stroke anyone draws is refused for size. */
export function mockFillBoard(materialId: string) {
  const room = openBoard(materialId);
  const peer = mockBoardPeer(materialId);
  const held = Y.encodeStateAsUpdate(room.document).byteLength;
  peer.add('filler', {
    index: 'a0',
    pad: 'x'.repeat(BOARD_MAX - held - 300),
    type: 'capy:filler',
    xywh: '[0,-400,40,40]',
  });
  peer.leave();
  if (Y.encodeStateAsUpdate(room.document).byteLength < BOARD_MAX - 1000)
    throw new Error('The mock room refused its filler');
}

/** The mock user's socket to a canvas's room drops, or returns (e2e): while it
 * is down their tab draws on its own, and what it and the others drew meets
 * when it joins again. */
export function mockBoardSocket(materialId: string, up: boolean) {
  for (const provider of [...boardProviders])
    if (provider.materialId === materialId) provider.socket(up);
}

/** The mock user's tab on a canvas (e2e). */
function boardTab(materialId: string) {
  for (const provider of boardProviders)
    if (provider.materialId === materialId) return provider;
  throw new Error(`Mock board room for ${materialId} has no tab`);
}

/** What the mock user's tab says of itself on a canvas (e2e): its own presence
 * state, null while it has set none. The room relays nothing a read channel
 * says, so only this shows what its tab said. */
export const mockBoardOwnPresence = (materialId: string) =>
  boardTab(materialId).presence;

/** The channel the mock user's tab holds in a canvas's room (e2e): `read`,
 * `write`, or null while it is out of the room. */
export const mockBoardChannel = (materialId: string) =>
  boardTab(materialId).channel;

/** The mock user's account is frozen while they are on a canvas they may edit
 * (e2e): the service closes their channel (4403) and their next token reads. */
export function mockNarrowBoard(materialId: string) {
  narrowMockCanvas(materialId);
  for (const provider of [...boardProviders])
    if (provider.materialId === materialId)
      provider.close(4403, 'collaboration access changed');
}

/** Whether the canvas's open mock room has stored every update it took (e2e:
 * a reload opens what was stored). */
export function mockBoardStored(materialId: string) {
  const room = openBoard(materialId);
  return !room.dirty && room.pending.length === 0;
}

export function registerMockCollaborationProvider() {
  registerProviderType('mock', MockCollaborationProvider);
  registerMockSourceProvider((config) => new MockSourceProvider(config));
  registerMockItemProvider((config) =>
    isMockCanvas(config.name.split(':')[1] ?? '')
      ? new MockBoardProvider(config)
      : new MockItemProvider(config)
  );
}
