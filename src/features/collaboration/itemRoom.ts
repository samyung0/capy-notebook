import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { USE_MSW } from '@/api/auth';
import { isApiError, qk } from '@/api/client';
import { getMaterialCollaborationToken } from '@/api/hooks';
import { queryClient } from '@/api/queryClient';
import type { Material } from '@/api/types';
import {
  isOutdatedBanner,
  type SaveBannerState,
} from '@/components/banners/SaveBanner';
import { userToast } from '@/components/ui/userToast';
import {
  type ReadOnlyCode,
  readOnlyCode,
} from '@/features/notes/collaborationEvents';
import {
  type RoomReconnector,
  refusalKeepsDrafts,
  roomReconnector,
  roomRefusal,
} from '@/features/notes/roomConnection';
import { NOTE_SAVE_DELAY_MS, SaveDelayClock } from '@/features/notes/saveDelay';
import { toastDraftsLost, toastSaveUndone } from '@/features/notes/saveFailure';
import type { LearnerQuestion } from '@/features/questions/types';
import {
  applyReaderMessage,
  type ReaderLists,
  readLearnerQuestions,
} from '@/features/quizzes/liveQuiz';
import { m } from '@/i18n';
import { markUpdateAvailable } from '@/lib/appRelease';
import { BOARD_OFFLINE_MARGIN, MATERIAL_DOCUMENT_LIMITS } from '@/lib/const';
import { type DraftRef, mergedRows } from '@/lib/draftStore';
import {
  applyDrafts,
  claimLateRows,
  DRAFT_SEND_WAIT_MS,
  type DraftRecorder,
  type DraftSender,
  deleteDrafts,
  deletedDocument,
  draftGroups,
  draftKey,
  draftSender,
  dropExpiredGroup,
  type EditDraft,
  heldDraftSessions,
  holdDraftDocument,
  markDraftsRefused,
  readDrafts,
  recordDrafts,
  recoveryDocument,
  splitOpenDrafts,
} from '@/lib/editDrafts';
import { editIncidentReporter } from '@/lib/editIncidents';
import { dropDeviceCopies } from '@/lib/sourceCache';
import { copyOf, hiddenEdits } from './boardHidden';
import {
  type CopyLabel,
  dropDeletedCopies,
  keepDeviceCopy,
  type RoomSeed,
} from './deviceCopy';
import { type ItemKind, offerExpiredDrafts } from './expiredDrafts';
import { deletedTarget, discardDeleted, showDeletedDrafts } from './lostEdits';
import { type NoteSeat, roomKey } from './noteSeat';
import { NO_PRESENCE, type PresenceConnection } from './presence';
import { tokenClientIds } from './protocol';
import {
  adoptClientId,
  type EarlySession,
  earlyChain,
  mergeInputs,
  type RenameBase,
  renameClients,
  renameRefusal,
} from './renameClient';
import {
  type HeldStrip,
  RoomProvider,
  type RoomProviderConfig,
} from './roomProvider';
import { markItemWorking } from './roomRefusals';
import { itemUndo, limitUndo, type UndoTarget, undoTarget } from './undo';

/* A live item's room (a flashcard set, a quiz's content or keys document;
 * live-items DESIGN.md): its own Y.Doc joined on the tab's shared
 * collaboration socket, with a token per room. Writers edit the document
 * directly (fields bind to its texts); readers hold a read channel and render
 * what it holds (Epo, 2026-10-10).
 *
 * An editor's room keeps its unsent edits on this device (`drafts`, the
 * notes' editDrafts, Epo 2026-10-04): restored and synced on the next open
 * of the same room, shown read-only for copying when they were refused or
 * the room moved on (`recovery`), never merged into another lineage. A room
 * the server refused an update in, or that moved to a new lineage, is
 * replaced by a fresh one (`onReplace`): it never rejoins with what was
 * refused (REVIEW1 M1, M5). */

/** `syncing` lasts until the store holding this device's edits answered
 * (its receipt), not only until the room acknowledged them: Saved means
 * stored in the database (Epo 2026-10-19), and a room that joined with
 * nothing of this device's to store is saved too (Epo 2026-10-20). */
export type ItemRoomStatus =
  | 'opening'
  | 'syncing'
  | 'saved'
  | 'offline'
  | 'unavailable';

export interface ItemRecovery {
  /** The item was deleted (Q39): its stored edits drawn from the rows alone
   * (`deletedDocument`); its strip's Discard deletes the rows it shows and
   * reloads the page. */
  deleted?: boolean;
  doc: Y.Doc;
  /** An early board's edits the room's state hides (made to something
   * another person deleted meanwhile, Q33): the room runs on its document
   * beside them, and Discard drops them and shows it. */
  merged?: boolean;
  /** Refused for good (otherwise: the room moved on meanwhile). */
  refused: boolean;
  /** The stored rows Discard deletes. */
  rows: DraftRef[];
}

export interface ItemRoomSnapshot {
  access: 'read' | 'write' | null;
  /** An edit's receipt has waited 25 s of connected time, as a note's (Epo
   * 2026-10-04), or the room said a store failed while this device had edits
   * unsaved: "Saving is delayed" until a receipt answers. */
  delayed: boolean;
  /** The item was deleted (`item_deleted`, Q39): its edits, when this
   * document has any, are the recovery; a quiz's keys room stays beside its
   * content's for its own (`liveQuizRooms`). */
  deleted: boolean;
  /** A board painted from its device copy takes edits before its join (Epo
   * 2026-11-19, Q27 b1, Q31): under its document's own client id, kept as
   * drafts, renamed to the room's in place at the join (`rename`, Q38). */
  early: boolean;
  /** The room dropped a group of this tab's pieces as late: its edits wait
   * unsynced until its Retry (the `unsynced` strip's, Epo 2026-11-23), a
   * reconnect or a reload joins again. */
  held: HeldStrip | null;
  /** Bumped when the readers' lists change (`lists`). */
  listsVersion: number;
  /** An editor's save strip while the room cannot be used: unreachable
   * (`offline…`), or refusing this build (`outdated…`, until the page
   * reloads). */
  offline: Extract<
    SaveBannerState,
    | 'offline'
    | 'offline-unstored'
    | 'offline-limit'
    | 'outdated'
    | 'outdated-unstored'
  > | null;
  /** The room's other editors (`presence.ts`), for the header. */
  presence: PresenceConnection[];
  /** Why the room is read-only for this writer, when it said (a block
   * this version cannot edit). */
  readOnlyCode: ReadOnlyCode | null;
  /** Edits that cannot join this room, shown for copying until Discard. */
  recovery: ItemRecovery | null;
  /** Stored steps of never-accepted sessions are in the draft send (Q319),
   * or an early board's edits wait to be renamed (`unloaded`): view-only
   * until it settles. */
  sending: boolean;
  /** Joined, its answer waiting on the user's open budget (Epo 2026-10-20):
   * loading until it syncs, never offline meanwhile. */
  slowed: boolean;
  status: ItemRoomStatus;
  /** The room takes nothing more from this tab for now: it closed for this
   * person's access change and the next token says what they may do. What
   * is drawn or typed meanwhile would be stored nowhere. */
  stopped: boolean;
  /** The document holds the room's state (painted from it, editable). */
  synced: boolean;
  /** An early board's rows could not be flagged before the rename, or the
   * merge it paints them with did not load (Q295, Q398): its edits stay,
   * read-only, until Retry or the browser's reconnect tries again, as a
   * note's (`late-unloaded`). */
  unloaded: boolean;
  /** The join has not answered 30 s after it began, the browser online
   * (Epo 2026-11-04, D5, C9): the page offers Retry (`ItemRoom.retry`). */
  unreachable: boolean;
}

/** Whether an item editor stops taking edits: offline past the bound this
 * device may hold, refused as outdated, or while its stored steps are in
 * the draft send (Q319). */
export function itemEditingStopped({
  offline,
  sending,
}: Pick<ItemRoomSnapshot, 'offline' | 'sending'>) {
  return sending || offline === 'offline-limit' || isOutdatedBanner(offline);
}

/** What a room needs of its provider (the MSW stand-in implements it too). */
export type ItemProvider = Pick<
  RoomProvider,
  'connect' | 'destroy' | 'disconnect' | 'sendStateless' | 'wake'
>;

let mockFactory: ((config: RoomProviderConfig) => ItemProvider) | null = null;

export function registerMockItemProvider(
  factory: (config: RoomProviderConfig) => ItemProvider
) {
  mockFactory = factory;
}

/** Under MSW the in-page room stands in for the collaboration server. */
function createItemProvider(config: RoomProviderConfig): ItemProvider {
  if (USE_MSW) {
    if (!mockFactory) throw new Error('Mock item provider is not registered');
    return mockFactory(config);
  }
  return new RoomProvider(config);
}

const RESTORE_ORIGIN = Symbol('restore');
/** Closes a client rejoins after with a fresh token; any other close
 * refused this channel's update (an eviction goes by its mode). */
const TRANSIENT_CLOSES = new Set([
  'socket closed',
  'collaboration token expired',
  'collaboration room is being reset',
]);
const EVICTED = 'collaboration room evicted';

/** Stored rows another open tab records now (its session's lock held) that
 * only it may apply: edits under an id no room assigned (`late`), which that
 * tab renames at its own join. */
async function leaveLiveRows(rows: EditDraft[]) {
  if (!rows.some((row) => row.late)) return rows;
  const live = await heldDraftSessions();
  return rows.filter((row) => !(row.late && live.has(row.session)));
}

/** The early sessions whose late rows `rows` are (Q38): each one's
 * temporary id and what it painted, which a row naming none leaves empty (it
 * shows the session followed nothing). */
function earlySessions(rows: EditDraft[]) {
  const sessions = new Map<string, EarlySession>();
  for (const { client, painted, session } of rows)
    if (client !== undefined && !sessions.has(session))
      sessions.set(session, {
        client,
        earlier: painted?.earlier ?? [],
        state: painted ? Y.decodeStateVector(painted.state) : new Map(),
      });
  return [...sessions.values()];
}

/** An early board's edits renamed in place, until the room's state is in
 * (`settleRename`). */
interface Renamed {
  /** The document as it was: its whole state, then this tab's edits until
   * the room's first frame. */
  before: Uint8Array[];
  /** The room's state deleted something under the new id: only an edit of
   * something another person deleted, or a field both changed, can be. */
  deleted: boolean;
  /** The renamed state's write. */
  landing: Promise<boolean>;
  stop: () => void;
  to: number;
}

export interface ItemRoomOptions {
  /** The room keeps an awareness of its own on its document, sent through
   * its channel: a canvas's pointers and selections. It says nothing until a
   * state is set on it. */
  awareness?: boolean;
  /** A canvas's board, its state capped at `max` bytes (CANVAS_BOARD_MAX,
   * Epo 2026-11-18). The room keeps the board's size from its receipts
   * (`size`), and offline work stops at the space left as at the 4 MiB this
   * device may hold. A turn to read-only that discards unsaved edits opens a
   * fresh room on what was saved: the board shows the document, which still
   * holds them. */
  board?: { max: number };
  /** A quiz's keys document instead of the material's own. */
  document?: 'keys';
  /** An editor's room: unsent edits are kept on this device under this
   * account (readers keep none); `kind` names the file they download as. */
  drafts?: { actorId: string; kind: ItemKind };
  /** Where this room's first token comes from, when not its own request. */
  firstToken?: () => ReturnType<typeof getMaterialCollaborationToken>;
  /** An embedded quiz's or set's room: it joins inside its note's channel
   * (Epo 2026-10-20). */
  inside?: NoteSeat | null;
  /** Keeps a device copy of this room under this label (a member's page). */
  keep?: CopyLabel;
  /** The room is going, left or replaced by a fresh one, and its document
   * with it: called while the document still stands, for what the page has
   * yet to write into it or take down from it. The room goes whatever this
   * throws. */
  onLeave?: () => void;
  /** The room ended for good here (refused, moved): mount a fresh one. */
  onReplace?: () => void;
  /** A reader (a View, a study page): asks for a read channel even when the
   * user may write (REVIEW5 N2), so the server refuses anything it sends. */
  read?: boolean;
  /** A note's own room (its View): the seat its embeds join inside. */
  seat?: NoteSeat;
  /** The device copy this room starts from: its document, and the version
   * its JOIN names, so the room answers only the difference. */
  seed?: RoomSeed | null;
}

/** A 409 from a token request: the item was restored between the server's
 * checks (`deletedError`), so asking again joins it. */
const restoredMeanwhile = (error: unknown) =>
  isApiError(error) && error.status === 409;

/** About how long a first token's 409 waits before asking again. */
const START_AGAIN_MS = 1000;

export class ItemRoom {
  /** The document the page shows and edits, for the room's whole life. */
  readonly doc: Y.Doc;
  /** `ItemRoomOptions.awareness`: what the room's editors tell each other. */
  readonly awareness: Awareness | null;
  /** None for a board, whose editor keeps its own (`ItemRoomOptions.board`). */
  private readonly undoManager: Y.UndoManager | null;
  private readonly undoTarget: UndoTarget | null;
  /** A quiz content room: the readers' matching and ordering lists. */
  lists: ReaderLists = new Map();
  private provider: ItemProvider | null = null;
  private snapshot: ItemRoomSnapshot = {
    access: null,
    delayed: false,
    deleted: false,
    early: false,
    held: null,
    listsVersion: 0,
    offline: null,
    presence: NO_PRESENCE,
    readOnlyCode: null,
    recovery: null,
    sending: false,
    slowed: false,
    status: 'opening',
    stopped: false,
    synced: false,
    unloaded: false,
    unreachable: false,
  };
  private unsynced = 0;
  private destroyed = false;
  private ended = false;
  /** Rejoins with a fresh token, backing off while it keeps failing (as a
   * note's room does). */
  private readonly reconnector: RoomReconnector;
  /** The token request that failed, if one did: the provider reports only
   * its own "Failed to get token" text. */
  private tokenError: unknown = null;
  /** The last room token handed to the provider: stored drafts keep it
   * (Q288). */
  private lastToken: string | undefined;
  /** An editor's board painted from its device copy, which may take edits
   * before its join (Epo 2026-11-19, Q27 b1). */
  private readonly canOpenEarly: boolean;
  /** Reading the stored drafts before an early board's edits: whether it
   * takes them (`openEarly`). */
  private earlyOpen: Promise<boolean> | null = null;
  /** The current recorder's mark: while `late`, its document writes under
   * its own client id, which no room assigned, so its rows are `late` and the
   * join renames them. Each recorder keeps its own. */
  private rowsLate: { late: boolean } | null = null;
  /** The early merge waits for its code (`mergeLater`): tries again, or
   * not as the room goes. */
  private mergeWait: ((again: boolean) => void) | null = null;
  /** The token's answer for a merge still running (`answerMerge`). */
  private mergeAnswer: boolean | null = null;
  /** Releases the locks of the late rows a refused early board shows for
   * copying (`keepStored`). */
  private keptLate: (() => void) | null = null;
  /** Releases a deleted item's stored edits this room shows (`deleted`). */
  private keptDeleted: (() => void) | null = null;
  /** What its deleted recovery shows, for the page's Discard. */
  private shownDeleted: (() => void) | null = null;
  /** What an early board painted (Q38): the temporary ids of the earlier
   * sessions' late rows it took, oldest first (`chain`), its own (`own`, the
   * document's id then), and what the rename is checked against (`base`:
   * the copy's clients, and the document's state vector before its first
   * edit). */
  private earlyPaint: {
    base: RenameBase;
    chain: number[];
    own: number;
  } | null = null;
  /** Stops the late merge's worker when the room goes (`mergeEarly`). */
  private readonly stopMerge = new AbortController();
  /** Rows an early board painted that sessions with a room's id wrote (one
   * that joined, or one whose token answered, Q326): at the join, accepted
   * ones apply (`apply`) and never-accepted ones go through the draft send
   * (`send`), as at any open. */
  private earlyRows: { apply: EditDraft[]; send: EditDraft[] } | null = null;
  /** The early board's document holds `earlyRows.send` steps under an id
   * its channel does not hold: its JOIN waits for the draft send to take
   * them. */
  private sendFirst = false;
  /** An early board's edits to rename before it connects (`rename`): the
   * accepted rows it painted, which the renamed session adopts, its drafts'
   * key, and the token whose id it takes. */
  private renaming: { apply: EditDraft[]; key: string; token: string } | null =
    null;
  /** Opens once the early edits are renamed: no JOIN goes before, whatever
   * asks the provider to connect (`beforeJoin`, review M3). */
  private renamedGate: { open: () => void; opened: Promise<void> } | null =
    null;
  /** The early rows are being flagged before the rename. */
  private flagging = false;
  /** Ends the reconnect watch of a rename whose rows could not be flagged. */
  private stopUnloaded: (() => void) | null = null;
  /** Renamed, the room's state not in yet. */
  private renamed: Renamed | null = null;
  /** The early recorder whose rows the renamed edit stands for: its rows go
   * once that edit is stored on this device or by the room. */
  private replaced: DraftRecorder | null = null;
  /** The replaced rows may still be the only stored copy of edits the
   * room's state hides: they stay until the room's state is in and that
   * copy is stored, a receipt before then included (review m4: the room may
   * take the renamed edits and answer its receipt while it holds its own
   * state back for the open budget). */
  private replacedHolds = false;
  /** A receipt covered the renamed edit: the replaced rows go as soon as
   * they no longer hold (`dropReplacedOn`). */
  private replacedStored = false;
  /** The renamed edit's local count, for the receipt that covers it. */
  private renamedAt = 0;
  private readonly listeners = new Set<() => void>();
  private readonly materialId: string;
  private options: ItemRoomOptions;
  private room = '';
  private recorder: DraftRecorder | null = null;
  private storageOk = true;
  /** Armed while this device's draft storage fails: the tab's close or
   * reload asks only if the room has not acknowledged an edit then (Q561,
   * as Office and text files, Q465). In-app navigation never asks; the
   * drafts and the room keep every edit. */
  private readonly leaving = (event: BeforeUnloadEvent) => {
    if (!(this.unsynced > 0 || this.recorder?.unsaved)) return;
    event.preventDefault();
    event.returnValue = '';
  };
  private overLimit = false;
  /** Offline, a board's work reached the space its cap leaves. */
  private boardFull = false;
  /** A board's size: the room's measure at its last receipt (or this tab's
   * own encode before one) and the bytes of every update applied since. */
  private measured: { base: number; since: number } | null = null;
  private readonly sizeListeners = new Set<() => void>();
  /** Says saving is delayed once a receipt waits too long (`delayed`). */
  private readonly delay = new SaveDelayClock(NOTE_SAVE_DELAY_MS, () =>
    this.set({ delayed: true })
  );
  /** The room refuses this build (the version gate). */
  private stale = false;
  /** Checkpoint requests waiting for a receipt: id -> local edit count. */
  private readonly pending = new Map<string, number>();
  /** The mode of the eviction notice that came before a close. */
  private eviction: string | null = null;
  /** Stops waiting to start again after a first open that failed. */
  private waiting: (() => void) | null = null;
  /** The draft send of never-accepted stored steps (Q319, Q327, Q328). */
  private sender: DraftSender | null = null;
  /** Its steps applied here after DRAFT_SEND_WAIT_MS: every edit stored,
   * nothing live, and every JOIN waiting for the send (Q327). */
  private heldSteps = false;
  /** The next sync ends the stored-only episode the held steps began. */
  private heldEpisode = false;
  /** Takes the pending steps once DRAFT_SEND_WAIT_MS passed and the room
   * synced, whichever comes last. */
  private hold: (() => void) | null = null;
  /** Clears its timer and its offline watch, at the send's end or teardown. */
  private stopHold: (() => void) | null = null;
  /** Writes the device copy on hide and at the end (`ItemRoomOptions.keep`). */
  private keeper: ReturnType<typeof keepDeviceCopy> | null = null;

  constructor(materialId: string, options: ItemRoomOptions = {}) {
    this.materialId = materialId;
    this.options = options;
    this.doc = options.seed?.doc ?? new Y.Doc();
    this.canOpenEarly = !!(
      options.board &&
      options.drafts &&
      options.seed?.row.canEditContent
    );
    this.awareness = options.awareness ? new Awareness(this.doc) : null;
    this.awareness?.setLocalState(null);
    // The document holds only this item. Undo reaches back 24 h (Epo
    // 2026-10-23).
    this.undoManager = options.board ? null : itemUndo(this.doc);
    if (this.undoManager) limitUndo(this.undoManager);
    this.undoTarget = this.undoManager && undoTarget(this.undoManager);
    if (options.board) this.doc.on('update', this.grew);
    this.reconnector = roomReconnector({
      // Still not back after the grace period: the room is offline, and a
      // join that never answered says so with Retry. A join waiting on the
      // draft send is not stuck.
      onStuck: () => {
        if (this.heldSteps) return;
        if (!this.snapshot.synced) this.set({ unreachable: true });
        this.goOffline();
      },
      provider: () => (this.destroyed || this.ended ? null : this.provider),
    });
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = () => this.snapshot;

  /** A quiz content room's questions as a learner sees them, once synced. */
  learnerQuestions(): LearnerQuestion[] | undefined {
    if (this.snapshot.synced) return readLearnerQuestions(this.doc, this.lists);
  }

  private set(patch: Partial<ItemRoomSnapshot>) {
    const next = { ...this.snapshot, ...patch };
    if (
      (Object.keys(next) as (keyof ItemRoomSnapshot)[]).every(
        (key) => next[key] === this.snapshot[key]
      )
    )
      return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  private live(): ItemRoomStatus {
    return this.unsynced > 0 ||
      this.recorder?.unsaved ||
      this.snapshot.sending ||
      this.heldSteps
      ? 'syncing'
      : 'saved';
  }

  private tokenRequest() {
    return {
      access: this.options.read ? ('read' as const) : undefined,
      document: this.options.document,
    };
  }

  /** `ItemRoomOptions.board`: the board's size against its cap, null until
   * the room measured it. Outside the snapshot, as it moves with each update. */
  get undo(): Y.UndoManager {
    if (!this.undoManager) throw new Error('a board room keeps no undo');
    return this.undoManager;
  }

  /** What the item's Undo and Redo buttons act on. */
  get history(): UndoTarget {
    if (!this.undoTarget) throw new Error('a board room keeps no undo');
    return this.undoTarget;
  }

  readonly size = () => {
    const { board } = this.options;
    if (!(board && this.measured)) return null;
    return {
      bytes: this.measured.base + this.measured.since,
      max: board.max,
    };
  };

  readonly subscribeSize = (listener: () => void) => {
    this.sizeListeners.add(listener);
    return () => {
      this.sizeListeners.delete(listener);
    };
  };

  private readonly grew = (update: Uint8Array) => {
    if (!this.measured) return;
    this.measured.since += update.byteLength;
    this.sized();
  };

  private sized() {
    for (const listener of this.sizeListeners) listener();
    // Offline, a board's work stops at the space its cap leaves (Epo
    // 2026-11-18, client-limits A): a lone person's backlog always fits.
    const size = this.size();
    if (
      size &&
      this.snapshot.offline &&
      !this.boardFull &&
      size.bytes + BOARD_OFFLINE_MARGIN > size.max
    ) {
      this.boardFull = true;
      this.showOffline();
    }
  }

  /** A board's first measure, before any receipt: one encode once the tab is
   * idle (about 40 ms at 4 MiB on an M1). `provisional`: the size it holds
   * until then (a copy's), so the removals-only gate holds meanwhile. */
  private measure(provisional?: number) {
    if (!this.options.board) return;
    if (provisional !== undefined) {
      this.measured = { base: provisional, since: 0 };
      this.sized();
    } else if (this.measured) return;
    const measuring = this.measured;
    const run = () => {
      // A receipt's measure came first.
      if (this.destroyed || this.measured !== measuring) return;
      this.measured = {
        base: Y.encodeStateAsUpdate(this.doc).byteLength,
        since: 0,
      };
      this.sized();
    };
    if (typeof requestIdleCallback === 'function')
      requestIdleCallback(run, { timeout: 2000 });
    else setTimeout(run, 0);
  }

  private draftKey() {
    const { drafts, document } = this.options;
    if (!drafts) return null;
    const key = draftKey(drafts.actorId, 'material', this.materialId);
    return document ? `${key}:keys` : key;
  }

  async start() {
    // The join has 30 s from its token request until the first sync (Epo
    // 2026-10-23); past them it shows this room's connection error, offline.
    this.reconnector.started();
    if (this.canOpenEarly) this.earlyOpen ??= this.openEarly();
    let first: Awaited<ReturnType<typeof getMaterialCollaborationToken>>;
    try {
      first = await (this.options.firstToken?.() ??
        getMaterialCollaborationToken(this.materialId, this.tokenRequest()));
    } catch (error) {
      // Deleted (410): its edits to copy. Read-only now (403
      // `collaboration-read-only`: a quiz's keys, asked as their editor is
      // demoted): read-only, joining nothing, as at a read token. Gone or no
      // longer this user's (404, 403): unavailable for good. Offline or a
      // server error: paused until it can join (REVIEW5 B1).
      const refusal = roomRefusal(
        error instanceof Error ? error.message : '',
        error
      );
      if (refusal === 'deleted') {
        this.answerMerge(false);
        await this.deleted();
      } else if (refusal === 'readOnly') {
        this.answerMerge(false);
        this.reconnector.dispose();
        this.readOnly();
      } else if (refusal === 'notFound' || refusal === 'forbidden') {
        // An early board's edits, waiting ones too, stay to copy: painted
        // ones with the board (`keepEarly`), the rest as stored.
        this.answerMerge(false);
        if (this.earlyOpen && !(await this.earlyOpen)) await this.keepStored();
        this.refusedAccess();
      } else if (restoredMeanwhile(error)) this.startAgain();
      else this.startLater();
      return;
    }
    if (this.destroyed) return;
    // The room threw away the state the copy holds: a fresh room joins.
    if (this.options.seed && this.options.seed.room !== first.room) {
      this.moved();
      return;
    }
    this.room = first.room;
    const access = first.access === 'write' ? 'write' : 'read';
    // An early merge whose code did not load tries again before the join
    // (review re-check R2), unless its person may no longer edit.
    this.answerMerge(access === 'write');
    // An early board's edits are its drafts already; a person who may no
    // longer edit loses them as any read-only turn does.
    const early = !!(await this.earlyOpen);
    if (this.destroyed || this.ended) return;
    if (early && access === 'read') {
      this.readOnly();
      if (this.ended) return;
    }
    this.set({ access });
    const key = this.draftKey();
    if (key && access === 'write' && !early && !(await this.restore(key))) {
      // Recovery is this open's answer: no room joins.
      this.reconnector.dispose();
      return;
    }
    if (this.destroyed) return;
    // The room joins with the document the board shows. An early board's
    // edits under ids no room assigned (its own and earlier tabs' late rows,
    // Q31) are renamed in place to the token's id before it connects
    // (`rename`, Q38); with none, the document takes the token's id now, so
    // what is drawn from here on goes as it is (`adopt`). Either way it then
    // joins as any. Rows of sessions that held a room's id go as at any open
    // (Q326): accepted ones with the document, never-accepted ones through
    // the draft send, which its JOIN waits for, as the document holds them.
    if (early && access === 'write' && key) {
      const waiting = this.earlyRows ?? { apply: [], send: [] };
      this.earlyRows = null;
      if (this.recorder?.unsaved) {
        this.renaming = { apply: waiting.apply, key, token: first.token };
        let open!: () => void;
        const opened = new Promise<void>((resolve) => {
          open = resolve;
        });
        this.renamedGate = { open, opened };
      } else {
        this.adopt(first.token);
        this.recorder?.adopt(waiting.apply);
      }
      this.sendFirst = waiting.send.length > 0;
      if (waiting.send.length) this.sendDrafts(key, waiting.send);
    }
    let cached: string | null = first.token;
    this.provider = createItemProvider({
      awareness: this.awareness,
      // While its never-accepted steps are held, a JOIN waits for the draft
      // send to take them (Q327).
      beforeJoin: () => {
        // An early board's edits are renamed before any JOIN (Q38, review
        // M3): one sent first would carry them under ids no room assigned.
        if (this.renaming) return this.renamedGate?.opened;
        if (!(this.heldSteps || this.sendFirst)) return;
        // The hold's connect asks for a send at once (Q328, Q360).
        this.sender?.now();
        return this.sender?.settled;
      },
      document: this.doc,
      name: first.room,
      onAuthenticationFailed: ({ reason }) => {
        // Gone or no longer this user's (the server's reason, or the API's
        // 404/403 for the token): no retry (REVIEW3 N2).
        const failedToken = this.tokenError;
        const refusal = roomRefusal(reason, failedToken);
        this.tokenError = null;
        // Deleted meanwhile: the unsent edits stay stored, and the fresh
        // room's token shows them (`deleted`).
        if (refusal === 'deleted') {
          this.moved(true);
          return;
        }
        // Not found by the collaboration service alone, which a deleted
        // item says too: a fresh token decides, the edits kept meanwhile.
        if (refusalKeepsDrafts(refusal, failedToken)) {
          void this.notFoundByRoom();
          return;
        }
        if (refusal === 'notFound' || refusal === 'forbidden') {
          this.refusedAccess();
          return;
        }
        if (refusal === 'outdated') {
          this.outdated();
          return;
        }
        // The room holds this document's client id for no one: not retried.
        if (refusal === 'unassigned') {
          this.refused();
          return;
        }
        // Behind a collection (in-place GC; only note rooms collect, which a
        // note's View reads here): a read channel holds nothing of its own,
        // so a fresh document joins naming no version, as a first open does
        // (Q425), rather than the same old version answered late again.
        if (refusal === 'late') {
          this.moved();
          return;
        }
        if (reason.includes('collaboration room moved')) return;
        // Read-only now (a frozen account, a full owner, a demotion), as at a
        // first token (`start`): a quiz's keys, which go to writers alone
        // (their token refused 403), join nothing more; any other room reads
        // on, joining again on a read token.
        if (refusal === 'readOnly') {
          this.readOnly();
          if (this.ended) return;
          if (this.options.document === 'keys') this.reconnector.dispose();
          else this.rejoin();
          return;
        }
        // A refusal the client retries: join again with a fresh token.
        this.rejoin();
      },
      onClose: ({ code, reason }) => {
        this.delay.disconnected();
        this.set({ slowed: false });
        // This person's access changed, with no notice: a fresh token says
        // what they have now. A demotion reads on; a removal is refused at
        // the token, and the page's read decides (Epo 2026-11-20).
        if (code === 4403) {
          this.set({ stopped: true });
          this.rejoin();
          return;
        }
        // A rejoin changes nothing until its 30 s passed (D2).
        if (reason === 'socket closed') {
          if (navigator.onLine) this.reconnector.disconnected();
          else this.goOffline();
          return;
        }
        if (reason === 'read-only connection sent a document update') {
          // Its document held changes the room no longer does (the room lost
          // its last unstored window, in a crash): a fresh document joins,
          // since a read channel has nothing of its own to keep (REVIEW5 S1).
          this.readOnly();
          this.moved();
          return;
        }
        if (reason === EVICTED) {
          // A drain (a Move, a hide) stored the room first: rejoin, and
          // anything in flight goes again. A discard threw the room's
          // unsaved state away and moves its lineage, so a fresh room
          // opens, with this tab's unsent edits to copy.
          const drain = this.eviction === 'drain';
          this.eviction = null;
          if (drain) this.rejoin();
          else {
            // It may be gone: the page's read says, and a refusal ends what
            // shows (Epo 2026-11-05).
            void queryClient.invalidateQueries({
              queryKey: qk.material(this.materialId),
            });
            this.moved(true);
          }
          return;
        }
        if (TRANSIENT_CLOSES.has(reason)) {
          this.rejoin();
          return;
        }
        this.refused();
      },
      onHeld: (held) =>
        this.set({ held: held && { ...held, discard: this.discardHeld } }),
      onPresence: (presence) => this.set({ presence }),
      onSlowed: (slowed) =>
        slowed ? this.slowed() : this.set({ slowed: false }),
      onStateless: ({ payload }) => this.stateless(payload),
      onSynced: ({ state }) => {
        if (state) {
          // A page showing the item says so if it later loses it.
          markItemWorking(false, this.materialId);
          if (this.snapshot.offline || this.heldEpisode)
            this.recorder?.connected();
          this.heldEpisode = false;
          this.boardFull = false;
          this.reconnector.connected();
          this.delay.connected();
          this.set({
            early: false,
            offline: null,
            slowed: false,
            status: this.live(),
            stopped: false,
            synced: true,
            unreachable: false,
          });
          this.settleRename();
          this.measure();
          this.requestReceipt();
          // A first sync after DRAFT_SEND_WAIT_MS still takes the held
          // steps (Q360).
          queueMicrotask(() => this.hold?.());
          return;
        }
        // A rejoin changes nothing until its 30 s passed (D2).
        if (!this.snapshot.synced && this.snapshot.status !== 'offline')
          this.set({ status: 'opening' });
      },
      onUnsyncedChanges: ({ number }) => {
        this.unsynced = number;
        if (this.snapshot.synced && this.snapshot.status !== 'offline')
          this.set({ status: this.live() });
        if (number === 0) this.requestReceipt();
      },
      parent: this.options.inside ?? undefined,
      sleepsHidden: true,
      storedFrom: this.options.seed?.version,
      token: async (previousToken) => {
        if (cached) {
          this.lastToken = cached;
          cached = null;
          return this.lastToken;
        }
        let fresh: Awaited<ReturnType<typeof getMaterialCollaborationToken>>;
        try {
          fresh = await getMaterialCollaborationToken(this.materialId, {
            ...this.tokenRequest(),
            previousToken,
          });
        } catch (error) {
          this.tokenError = error;
          throw error;
        }
        // Discarded while this tab was away: the room's lineage moved,
        // and a fresh room joins it (REVIEW1 M5).
        if (fresh.room !== this.room) {
          this.moved();
          throw new Error('collaboration room moved');
        }
        const now = fresh.access === 'write' ? 'write' : 'read';
        if (now !== this.snapshot.access && now === 'read') this.readOnly();
        // A board that discarded edits opens a fresh room instead.
        if (this.ended) throw new Error('collaboration room moved');
        this.set({ access: now });
        this.lastToken = fresh.token;
        return fresh.token;
      },
      // Stored drafts not yet covered by a receipt (Q236).
      unsent: () => !!this.recorder?.unsaved,
      url: first.url,
    });
    if (this.provider instanceof RoomProvider)
      this.options.seat?.attach(this.provider);
    this.keepCopy();
    globalThis.document?.addEventListener('visibilitychange', this.shown);
    if (this.renaming) void this.rename();
    else this.provider.connect();
  }

  /** An early board with no edits yet, its token answered (a slow join, or
   * the 30 s unreachable state with the API up): from now on it writes under
   * the id the token offers, which the provider declares at its JOIN as it
   * would for any document that never wrote. That id is recorded to no one,
   * in no history and bound by no live channel, so the JOIN binds it and its
   * edits go as any session's (`ClientIds::holds`, Q236): nothing is
   * renamed, and the board stays. Its drafts keep that token (Q288). */
  private adopt(token: string) {
    try {
      adoptClientId(this.doc, tokenClientIds(token).clientId);
    } catch {
      // No id offered: the provider's JOIN refuses it as it is.
      return;
    }
    if (this.rowsLate) this.rowsLate.late = false;
    this.lastToken = token;
  }

  /** An early board's edits, made under ids no room assigned, become the
   * room's in place before it connects (Epo 2026-11-19, Q38, "Yes, rename in
   * place"; "make sure this step is invisible, nothing ever reloads,
   * never"): the rows are flagged copy-only first, since the same edits
   * under two ids would go in twice (review b2 re-check N2); then every
   * struct under those ids takes the id the token offers, in the document
   * the board shows, its undo history with it (renameClient.ts), and a
   * session under that id records from there, its first row the document
   * whole. The board takes edits throughout. Flags that cannot be stored
   * keep the edits as they are, read-only under the note's strip, and try
   * again on Retry and on the browser's reconnect (Q295, Q398); a rename
   * that would not be sound (the id in the document already, a temporary
   * one in the room's history, updates pending) keeps them all for copying,
   * the strip saying so, nothing the room refused. A draft send of earlier
   * sessions' steps goes first (the board takes no edits meanwhile), since
   * it takes every never-accepted row of the lineage, the renamed session's
   * among them: asked now, it tries again at once after a failed try, as a
   * JOIN waiting for it asks (Q328), and calls this again as it settles. */
  private async rename() {
    const renaming = this.renaming;
    const early = this.recorder;
    if (!(renaming && early) || this.flagging) return;
    if (this.sender) {
      this.sender.now();
      return;
    }
    this.flagging = true;
    this.stopUnloaded?.();
    const flagged = await early.flagCopyOnly();
    this.flagging = false;
    if (
      this.destroyed ||
      this.ended ||
      this.renaming !== renaming ||
      this.recorder !== early
    )
      return;
    if (!flagged) {
      this.unloaded('The early edits could not be flagged:', null);
      return;
    }
    let to: number | null = null;
    try {
      to = tokenClientIds(renaming.token).clientId;
    } catch {
      // No id offered: refused below.
    }
    // The ids in causal order, this tab's own (as it painted, whatever the
    // document's id is now) last.
    const painted = this.earlyPaint;
    const temporary = painted ? [...painted.chain, painted.own] : [];
    const refusal =
      to === null
        ? 'the token offers no client id'
        : painted
          ? renameRefusal(this.doc, temporary, to, painted.base)
          : 'the board painted nothing early';
    if (to === null || !painted || refusal) {
      console.warn('The early edits cannot be renamed:', refusal);
      this.refused(false);
      return;
    }
    // The rename and the renamed state's encode run on the main thread
    // (`canvas:rename`, measured near the cap by canvas-room-states.spec.ts).
    const started = performance.now();
    renameClients(this.doc, temporary, to, painted.base);
    this.renaming = null;
    this.renamedGate?.open();
    early.handOver();
    this.replaced = early;
    this.replacedHolds = true;
    const recorder = this.record(renaming.key, renaming.apply);
    this.adopt(renaming.token);
    const state = Y.encodeStateAsUpdate(this.doc);
    performance.measure('canvas:rename', { start: started });
    const landing = recorder.renamed(state);
    this.renamedAt = recorder.sequence;
    this.watchRenamed(state, to, landing);
    if (this.snapshot.unloaded) {
      this.reconnector.started();
      this.set({ sending: !!this.sender, unloaded: false });
    }
    this.provider?.connect();
  }

  /** Until the room's state is in: the document as it was before it (the
   * renamed state, then this tab's edits until the room's first frame), and
   * whether it deleted anything under the new id (`Renamed`). */
  private watchRenamed(
    state: Uint8Array,
    to: number,
    landing: Promise<boolean>
  ) {
    let roomSeen = false;
    const seen = (
      update: Uint8Array,
      _origin: unknown,
      _doc: Y.Doc,
      transaction: Y.Transaction
    ) => {
      if (transaction.local) {
        if (!roomSeen) renamed.before.push(update);
        return;
      }
      roomSeen = true;
      if (transaction.deleteSet.clients.has(to)) renamed.deleted = true;
    };
    const renamed: Renamed = {
      before: [state],
      deleted: false,
      landing,
      stop: () => this.doc.off('update', seen),
      to,
    };
    this.doc.on('update', seen);
    this.renamed = renamed;
  }

  /** The room's state is in after a rename: what it hides of the early
   * edits (made to an element or block another person deleted meanwhile,
   * Q33) is found per element and block by the board before it against the
   * board now (`boardHidden.ts`) and kept apart for copying, while a field
   * both changed takes Yjs's pick. The early rows go once the renamed state
   * landed (or a receipt covered it) and what is hidden is stored. */
  private settleRename() {
    const renamed = this.renamed;
    const recorder = this.recorder;
    if (!renamed) return;
    this.renamed = null;
    renamed.stop();
    let hidden: Y.Doc | null = null;
    if (renamed.deleted && recorder) {
      const before = new Y.Doc();
      for (const update of renamed.before) Y.applyUpdate(before, update);
      const held = Y.decodeStateVector(Y.encodeStateVector(before));
      held.delete(renamed.to);
      hidden = hiddenEdits(before, this.doc, held);
      before.destroy();
    }
    const done = () => {
      this.replacedHolds = false;
      this.dropReplacedOn(renamed.landing);
    };
    if (hidden && recorder) this.keepHiddenBeside(hidden, recorder, done);
    else done();
  }

  /** Early edits the board no longer shows (Q33), kept beside the live
   * board for copying; `stored` runs once that copy is stored on this
   * device. Until then the rows they came from stay, as their copy. */
  private keepHiddenBeside(
    hidden: Y.Doc,
    recorder: DraftRecorder,
    stored: () => void
  ) {
    this.set({
      recovery: { doc: hidden, merged: true, refused: false, rows: [] },
    });
    void (async () => {
      const kept = await recorder.keepHidden(Y.encodeStateAsUpdate(hidden));
      if (!kept) return;
      const { recovery } = this.snapshot;
      // Reloaded meanwhile: the copy went with the recovery.
      if (recovery?.doc === hidden)
        this.set({ recovery: { ...recovery, rows: [kept] } });
      else void deleteDrafts([kept]).catch(() => undefined);
      stored();
    })();
  }

  /** The room goes before its state came in after a rename: the write it
   * ends with holds the renamed edits whole, so the early rows go once that
   * landed. */
  private leaveRenamed() {
    if (!this.renamed) return;
    this.renamed.stop();
    this.renamed = null;
    this.replacedHolds = false;
  }

  /** The rows could not be flagged: the early board's edits stay as they
   * are, read-only, under the note's strip (`late-unloaded`) until Retry or
   * the browser's reconnect tries again (Q295, Q398). */
  private unloaded(warning: string, error: unknown) {
    console.warn(warning, error);
    // It waits on this device, not on the room (its token answered): no
    // join is stuck, and its strip shows over the offline one.
    this.reconnector.connected();
    if (this.snapshot.offline) this.recorder?.connected();
    this.set({
      offline: null,
      sending: true,
      status: 'syncing',
      unloaded: true,
    });
    const again = () => void this.rename();
    globalThis.addEventListener?.('online', again);
    this.stopUnloaded = () => {
      globalThis.removeEventListener?.('online', again);
      this.stopUnloaded = null;
    };
  }

  /** The early rows the renamed edit stands for go, unless they may still
   * hold the only stored copy of what the room's state hides. */
  private dropReplaced() {
    if (this.replacedHolds) return;
    void this.replaced?.discard();
    this.replaced = null;
  }

  /** The early rows go once `landed`, a write holding the renamed edit, did;
   * never on one that failed, so storage failing never deletes their only
   * copy (review b2 re-check N1). A receipt that covers the edit drops them
   * too. */
  private dropReplacedOn(landed: Promise<boolean>) {
    const replaced = this.replaced;
    if (!replaced) return;
    if (this.replacedStored) {
      this.dropReplaced();
      return;
    }
    void landed.then((ok) => {
      if (ok && this.replaced === replaced) this.dropReplaced();
    });
  }

  /** Back from a sleep its rejoin reports nothing until it syncs: its 30 s
   * start as the tab shows. */
  private readonly shown = () => {
    if (
      globalThis.document?.visibilityState === 'visible' &&
      this.provider instanceof RoomProvider &&
      !this.provider.isSynced &&
      this.snapshot.synced
    )
      this.reconnector.disconnected();
  };

  private copyDocument() {
    return this.options.document ?? 'content';
  }

  /** The device copy's label: a room opened without one starts keeping a
   * copy, and one whose label changed (a rename, a demotion) writes it with
   * the next copy, so the next open paints with it. */
  keepAs(keep: CopyLabel) {
    const was = this.options.keep;
    this.options = { ...this.options, keep };
    if (!was) {
      if (this.provider) this.keepCopy();
    } else if (
      was.canEditContent !== keep.canEditContent ||
      was.kind !== keep.kind ||
      was.standalone !== keep.standalone ||
      was.title !== keep.title
    )
      this.keeper?.relabel();
  }

  /** The room's confirmed state goes on the device: on hide and at the end,
   * when nothing of this device's is unsent. */
  private keepCopy() {
    const { keep } = this.options;
    if (!keep) return;
    this.keeper = keepDeviceCopy(this.doc, {
      clean: () =>
        this.snapshot.synced &&
        !this.ended &&
        !this.snapshot.recovery &&
        this.unsynced === 0 &&
        !this.recorder?.unsaved,
      owner: keep.owner,
      row: () => ({
        ...(this.options.keep ?? keep),
        document: this.copyDocument(),
        materialId: this.materialId,
        room: this.room,
        version:
          this.provider instanceof RoomProvider
            ? this.provider.reportedVersion
            : 0,
      }),
      seeded: !!this.options.seed,
    });
  }

  /** A refusal: this copy goes, and nothing writes it back. `deleted`: the
   * item was, or may have been, deleted (`item_deleted`, a discard), and the
   * recorder's last rows being written: the copy stays while this device
   * holds stored edits to it (`dropDeletedCopies`). */
  private dropCopy(deleted?: Promise<unknown>) {
    this.keeper?.stop();
    this.keeper = null;
    const { document, drafts } = this.options;
    if (deleted)
      void dropDeletedCopies(drafts?.actorId, this.materialId, {
        after: deleted,
        document,
      });
    else void dropDeviceCopies(this.materialId, document);
  }

  /** Sends the never-accepted stored steps while the room joins (Q319,
   * Q328); past DRAFT_SEND_WAIT_MS, synced, the room takes them itself
   * and edits on with nothing live until the send settles (Q327). */
  private sendDrafts(key: string, pending: EditDraft[]) {
    const sender = draftSender(key, () =>
      getMaterialCollaborationToken(this.materialId, this.tokenRequest())
    );
    this.sender = sender;
    this.set({ sending: true });
    let waitOver = false;
    this.hold = () => {
      if (!(waitOver && this.snapshot.synced) || this.sender !== sender) return;
      if (sender.done || this.heldSteps) return;
      if (this.ended || this.destroyed || this.stale) return;
      this.heldSteps = true;
      this.heldEpisode = true;
      this.provider?.disconnect();
      this.recorder?.disconnected(true);
      applyDrafts(this.doc, pending, RESTORE_ORIGIN);
      this.recorder?.adopt(pending);
      this.set({ sending: false, status: 'syncing' });
      this.provider?.connect();
    };
    const timer = setTimeout(() => {
      waitOver = true;
      this.hold?.();
    }, DRAFT_SEND_WAIT_MS);
    // No channel is open while the steps are held: a browser that goes
    // offline meanwhile shows offline, and syncing again once back (Q360).
    const offline = () => {
      if (this.heldSteps) this.goOffline();
    };
    const online = () => {
      if (this.heldSteps && this.snapshot.status === 'offline')
        this.set({ offline: null, status: 'syncing' });
    };
    globalThis.addEventListener?.('offline', offline);
    globalThis.addEventListener?.('online', online);
    this.stopHold = () => {
      clearTimeout(timer);
      globalThis.removeEventListener?.('offline', offline);
      globalThis.removeEventListener?.('online', online);
    };
    void sender.settled.then(() => {
      if (this.sender !== sender) return;
      this.stopHold?.();
      const held = this.heldSteps;
      this.sender = null;
      this.hold = null;
      this.heldSteps = false;
      this.sendFirst = false;
      // An early board waiting on its rows' flags stays read-only.
      this.set({ sending: this.snapshot.unloaded });
      // A group the room did not take, its steps not applied here: a fresh
      // room opens it copy-only (Q360). Held ones the JOIN's refusal takes.
      if (sender.kept && !held) {
        this.moved();
        return;
      }
      // An early board's edits are renamed once the room holds the steps
      // it painted (`rename`).
      if (this.renaming) {
        void this.rename();
        return;
      }
      if (this.snapshot.synced && this.snapshot.status !== 'offline')
        this.set({ status: this.live() });
    });
  }

  /** An embed closed as its note's oldest is near the screen again. */
  wake() {
    this.provider?.wake();
  }

  /** A first token that answered 409 (restored since its check): asked
   * again shortly, still connecting; the reconnector's watch from `start`
   * says when it never joins. */
  private startAgain() {
    if (this.destroyed || this.waiting) return;
    const timer = setTimeout(
      () => {
        this.waiting = null;
        void this.start();
      },
      START_AGAIN_MS * (0.5 + Math.random())
    );
    this.waiting = () => {
      this.waiting = null;
      clearTimeout(timer);
    };
  }

  /** A first open that failed for want of the network or the server: the
   * room shows offline and starts again once the browser is back online or
   * the tab shows again, as a note's token does, with no retry loop. Stored
   * edits restore at that join, which names the lineage they belong to. */
  private startLater() {
    if (this.destroyed || this.waiting) return;
    this.set({ status: 'offline' });
    // An early board's edits are held for the join, under the offline bound.
    if (this.recorder) this.goOffline();
    const page = globalThis.document;
    const again = () => {
      if (page?.visibilityState === 'hidden') return;
      this.waiting?.();
      void this.start();
    };
    globalThis.addEventListener?.('online', again);
    page?.addEventListener('visibilitychange', again);
    this.waiting = () => {
      this.waiting = null;
      globalThis.removeEventListener?.('online', again);
      page?.removeEventListener('visibilitychange', again);
    };
  }

  /** Reads this room's stored edits: the ones of its lineage go into the
   * document (synced on connect), a refused or other-lineage group opens in
   * recovery instead of the room. False when the room stays in recovery. */
  private async restore(key: string) {
    const rows = await readDrafts(key).then(
      // Item rooms merge late rows only as an early board's (`openEarly`):
      // here they open read-only for copying, never applied raw, unless
      // another tab records them.
      async (stored) =>
        (await leaveLiveRows(stored)).map((row) =>
          row.late ? { ...row, refused: true } : row
        ),
      (error) => {
        console.warn('Draft storage failed:', error);
        return [] as EditDraft[];
      }
    );
    const current = await this.offerGroups(rows, this.room);
    if (!current) return false;
    // Accepted sessions' rows apply here; never-accepted ones with stored
    // tokens go through the draft send (Q326).
    const { apply, send } = splitOpenDrafts(current);
    applyDrafts(this.doc, apply, RESTORE_ORIGIN);
    this.record(key, apply);
    if (send.length) this.sendDrafts(key, send);
    return true;
  }

  /** Shows the first group of `stored` the room (`lineage`) cannot take for
   * copying, read-only, as recovery; one past the 7-day expiry a toast
   * offers instead (D14), and one that cannot be read is told lost and
   * deleted. Answers the rest (the current rows), or null once one shows or
   * the room went. */
  private async offerGroups(stored: EditDraft[], lineage: string) {
    let rows = stored;
    for (;;) {
      if (this.destroyed) return null;
      const { current, expired, recovery, refused } = await draftGroups(
        rows,
        lineage
      );
      // Destroyed while the drafts worker answered: nothing starts (r6 S1).
      if (this.destroyed) return null;
      if (!recovery.length) return current;
      const doc = recoveryDocument(recovery);
      if (doc && !expired) {
        this.set({
          recovery: { doc, refused, rows: recovery },
          status: 'saved',
          synced: true,
        });
        return null;
      }
      // Past the 7-day expiry: the room opens, and a toast offers them (D14).
      // Only an editor's room (`drafts`) reads stored rows.
      const { drafts } = this.options;
      if (doc && drafts)
        offerExpiredDrafts({
          doc,
          document: this.options.document,
          kind: drafts.kind,
          materialId: this.materialId,
          onGone: () =>
            dropExpiredGroup(
              recovery,
              editIncidentReporter('material', this.materialId)
            ),
          // Read at the download: the page may name it after this opens.
          title: () => this.options.keep?.title ?? this.materialId,
        });
      else {
        toastDraftsLost();
        await deleteDrafts(recovery).catch(() => undefined);
      }
      rows = rows.filter((row) => !recovery.includes(row));
    }
  }

  /** Records this session's edits as drafts on this device; `early`: under
   * a client id no room assigned (`rowsLate`), with what the board painted
   * and the locks of the late rows it adopted. */
  private record(
    key: string,
    adopted: EditDraft[],
    early?: {
      claimed: () => void;
      painted: NonNullable<EditDraft['painted']>;
    }
  ) {
    const mark = { late: !!early };
    this.rowsLate = mark;
    this.recorder = recordDrafts({
      adopted,
      claimed: early?.claimed,
      doc: this.doc,
      ignore: (origin) =>
        origin === RESTORE_ORIGIN ||
        (origin !== null && origin === this.provider),
      key,
      limitBytes:
        this.options.board?.max ?? MATERIAL_DOCUMENT_LIMITS.maxContentBytes,
      lineage: this.room,
      onLimit: (over) => {
        this.overLimit = over;
        this.showOffline();
      },
      onLost: toastDraftsLost,
      onStorage: (ok) => {
        this.storageOk = ok;
        this.armLeave(!ok);
        this.showOffline();
      },
      painted: early?.painted,
      report: editIncidentReporter('material', this.materialId),
      token: () => this.lastToken,
      unassigned: () => mark.late,
    });
    return this.recorder;
  }

  /** An early board (`canOpenEarly`) starts recording before its join,
   * under its copy's own client id. The rows earlier sessions here left
   * paint with the copy: ones made the same way (a reload before the join)
   * are its person's own edits, renamed with this session's at the join, as
   * a note's copy draft goes with its edits (Q229); ones of a session that
   * held a room's id (it joined, or its token answered) go at the join as at
   * any open, applied or sent (`earlyRows`, Q326); another open tab's stay
   * its own, and so do the late rows it took (their sessions' locks held
   * from here, `claimLateRows`, review m1). Rows to copy keep the board
   * waiting for the join. Its size is the copy's. */
  private async openEarly() {
    const key = this.draftKey();
    const { seed } = this.options;
    if (!(key && seed)) return false;
    const claim = await readDrafts(key)
      .then(claimLateRows)
      .catch(() => null);
    if (!claim) return false;
    let waited = false;
    let opened = await this.paintEarly(key, seed, claim);
    while (opened === 'unloaded') {
      waited = true;
      opened =
        (await this.mergeLater()) && (await this.paintEarly(key, seed, claim));
    }
    if (!opened) claim.release();
    // Painted, or given up (read, refused or gone, review re-check 2 m5).
    if (waited) {
      this.set({ unloaded: false });
      // The join's 30 s run from here.
      this.reconnector.started();
    }
    return opened;
  }

  /** The early merge's code did not load (offline with nothing cached; Q295,
   * Q398, review re-check R2): the board shows the copy, read-only, under the
   * note's strip ("Couldn't sync your edits. Retry or reload the page."),
   * and Retry, the browser's reconnect and the join try again
   * (`mergeWait`), which paints in place, on the document as it is then.
   * False once the room goes, or the token says read or is refused. A token
   * that answered while the merge ran is its answer at once (`answerMerge`). */
  private mergeLater() {
    const answered = this.mergeAnswer;
    this.mergeAnswer = null;
    if (answered !== null) return Promise.resolve(answered);
    // It waits on this device, not on the room: no join is stuck.
    this.reconnector.connected();
    this.set({ unloaded: true });
    return new Promise<boolean>((resolve) => {
      const again = () => this.mergeWait?.(true);
      globalThis.addEventListener?.('online', again);
      this.mergeWait = (go) => {
        globalThis.removeEventListener?.('online', again);
        this.mergeWait = null;
        resolve(go);
      };
    });
  }

  /** The token's answer for the early merge waiting on its code. One that
   * comes while the merge still runs is kept for it, so a merge that then
   * fails answers it at once (review re-check 2). */
  private answerMerge(again: boolean) {
    if (this.mergeWait) this.mergeWait(again);
    else this.mergeAnswer = again;
  }

  /** A refused early board's stored rows (404, 403), when it painted none:
   * its merge's code did not load, the merge failed, or a group waits for
   * copying (`paintEarly`). No join offers them, so they show here, none left
   * unsaid (review re-check 3 m6): the first group the room cannot take as
   * `restore` shows it, else the rows over the copy, as Yjs merges them,
   * under the refused toast, until Discard, which asks first. Their late
   * sessions' locks hold until the room goes. */
  private async keepStored() {
    const key = this.draftKey();
    const { seed } = this.options;
    if (!(key && seed)) return;
    const claim = await readDrafts(key)
      .then(claimLateRows)
      .catch(() => null);
    if (!claim) return;
    if (this.destroyed || this.ended) {
      claim.release();
      return;
    }
    this.keptLate = claim.release;
    const current = await this.offerGroups(claim.rows, seed.room);
    if (!current?.length || this.destroyed) return;
    const doc = copyOf(this.doc);
    applyDrafts(doc, current, null);
    this.toastRefused();
    this.set({ recovery: { doc, refused: true, rows: current } });
  }

  /** `openEarly`'s paint. The late rows' sessions go in causal order
   * (`earlyChain`, review M1); one that edited beside something it never saw
   * (two tabs early at once, both closed before their joins; one that painted
   * an older copy than the rest) is merged anew first (`mergeEarly`, review
   * M2), off the common path: one session's rows, or a chain, load no
   * worker. */
  private async paintEarly(
    key: string,
    seed: RoomSeed,
    { release, rows }: Awaited<ReturnType<typeof claimLateRows>>
  ): Promise<boolean | 'unloaded'> {
    const gone = () => this.destroyed || this.ended || !!this.provider;
    if (gone()) return false;
    const { current, recovery } = rows.length
      ? await draftGroups(rows, seed.room)
      : { current: [], recovery: [] };
    const late = current.filter((row) => row.late);
    // Each late row names the id it was written under (Q38).
    if (
      gone() ||
      recovery.length ||
      late.some((row) => row.client === undefined)
    )
      return false;
    this.room = seed.room;
    // Its size is the copy's at once, so the removals-only gate holds from
    // the first edit (review b1 finding 10); the waiting rows add theirs.
    this.measure(seed.row.size);
    const history = new Set(this.doc.store.clients.keys());
    const update = current.length ? mergedRows(current) : null;
    // What the copy and every row hold, read off the rows without applying
    // them.
    const all = Y.decodeStateVector(Y.encodeStateVector(this.doc));
    for (const [client, clock] of update ? Y.parseUpdateMeta(update).to : [])
      all.set(client, Math.max(clock, all.get(client) ?? 0));
    const { chain, offending } = earlyChain(all, earlySessions(late));
    const merged =
      offending.length && update
        ? await this.mergeEarly(key, update, offending, late)
        : null;
    if (merged === 'unloaded') return merged;
    if (offending.length && !merged) return false;
    if (!merged && update) Y.applyUpdate(this.doc, update, RESTORE_ORIGIN);
    this.earlyRows = splitOpenDrafts(current.filter((row) => !row.late));
    const state = Y.encodeStateVector(this.doc);
    this.earlyPaint = {
      base: { history, painted: Y.decodeStateVector(state) },
      chain,
      own: this.doc.clientID,
    };
    const recorder = this.record(key, late, {
      claimed: release,
      painted: { earlier: chain, state },
    });
    if (merged) {
      // This session's rows hold the merged edits once its whole document
      // landed: the rows they replace go then, and what the merge hides is
      // kept apart first (Q33).
      const landed = recorder.stored();
      const drop = async () => {
        if (await landed)
          await deleteDrafts(merged.rows).catch(() => undefined);
      };
      if (merged.hidden)
        this.keepHiddenBeside(merged.hidden, recorder, () => void drop());
      else void drop();
    }
    this.set({ early: true });
    if (this.snapshot.status === 'offline') this.goOffline();
    return true;
  }

  /** The edits of `offending` temporary ids, against which some conflict
   * may have been settled, written anew under this tab's own id on top of
   * everything else painted (`update`), by the late merge in its worker,
   * placed where the document shows them: then every early edit comes after
   * everything else, as the rename needs (review M2). Assigned ids' structs
   * are never written anew (the room may hold them). Their rows are flagged
   * refused first, since the same edits under two ids would go in twice.
   * Answers what the merge would hide and the rows it replaced; `unloaded`
   * when its code did not load, nothing painted (`mergeLater`); or null when
   * it failed: the board then waits for its join, which offers the rows for
   * copying. */
  private async mergeEarly(
    key: string,
    update: Uint8Array,
    offending: number[],
    late: EditDraft[]
  ) {
    const all = copyOf(this.doc);
    Y.applyUpdate(all, update);
    const inputs =
      all.store.pendingStructs || all.store.pendingDs
        ? null
        : mergeInputs(all, offending);
    const rows = late.filter(
      (row) => row.client !== undefined && offending.includes(row.client)
    );
    const gone = () => this.destroyed || this.ended || !!this.provider;
    let merging: typeof import('./lateMerge/lateMerge') | null = null;
    try {
      if (!inputs) throw new Error('the rows wait on structs no row holds');
      const { rest } = inputs;
      merging = await import('./lateMerge/lateMerge');
      const { hidden, merged } = await merging.mergeLate(
        inputs.old,
        () => Y.encodeStateAsUpdate(rest),
        this.doc.clientID,
        this.stopMerge.signal
      );
      if (gone()) return null;
      await markDraftsRefused(
        key,
        rows.map((row) => row.id)
      );
      if (gone()) return null;
      Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(rest), RESTORE_ORIGIN);
      merging.applyMerged(this.doc, merged, RESTORE_ORIGIN, true);
      const held = Y.decodeStateVector(Y.encodeStateVector(rest));
      return {
        // What the merge says it hides that this check does not find keeps
        // the whole board as it would have painted, so nothing goes unsaid.
        hidden:
          hiddenEdits(all, this.doc, held) ??
          (hidden.length ? copyOf(all) : null),
        rows,
      };
    } catch (error) {
      if (
        inputs &&
        !gone() &&
        (!merging || error instanceof merging.LateMergeUnloaded)
      )
        return 'unloaded';
      if (!this.stopMerge.signal.aborted)
        console.warn('The early edits could not be merged:', error);
      return null;
    } finally {
      all.destroy();
      inputs?.rest.destroy();
    }
  }

  private showOffline() {
    if (!this.snapshot.offline || this.stale) return;
    this.set({
      offline:
        this.overLimit || this.boardFull
          ? 'offline-limit'
          : this.storageOk
            ? 'offline'
            : 'offline-unstored',
    });
  }

  /** Joined, and the answer waits on the user's open budget: the room is
   * reachable, so it loads instead of showing offline (an offline episode
   * before it ends here). */
  private slowed() {
    if (this.stale || this.destroyed) return;
    this.reconnector.slowed();
    if (this.snapshot.offline) this.recorder?.connected();
    this.set({
      offline: null,
      slowed: true,
      status:
        this.snapshot.status === 'offline'
          ? this.snapshot.synced
            ? this.live()
            : 'opening'
          : this.snapshot.status,
      unreachable: false,
    });
  }

  private goOffline() {
    if (this.stale) return;
    this.delay.disconnected();
    this.set({ status: 'offline' });
    if (!this.recorder || this.snapshot.offline) return;
    this.recorder.disconnected();
    this.set({ offline: 'offline' });
    this.showOffline();
  }

  private stateless(payload: string) {
    let event: { type?: string; [key: string]: unknown };
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    // An eviction notice precedes its close; the close acts on its mode.
    if (typeof event.evictionId === 'string')
      this.eviction = typeof event.mode === 'string' ? event.mode : 'discard';
    switch (event.type) {
      case 'quiz-items':
        this.lists = applyReaderMessage(
          this.lists,
          event as Parameters<typeof applyReaderMessage>[1]
        );
        this.set({ listsVersion: this.snapshot.listsVersion + 1 });
        return;
      case 'checkpoint-persisted': {
        // A board's size, as the room measured it at this store.
        const bytes = (event.metrics as { contentBytes?: unknown } | undefined)
          ?.contentBytes;
        if (this.options.board && typeof bytes === 'number') {
          this.measured = { base: bytes, since: 0 };
          this.sized();
        }
        const ids = Array.isArray(event.checkpointIds)
          ? (event.checkpointIds as string[])
          : [];
        let covered = -1;
        for (const id of ids)
          covered = Math.max(covered, this.pending.get(id) ?? -1);
        if (covered < 0) return;
        for (const [id, sequence] of this.pending)
          if (sequence <= covered) this.pending.delete(id);
        // Saving works again: the delayed strip comes back only if the
        // oldest request still unanswered crosses the threshold.
        this.delay.retain(this.pending.keys());
        this.set({ delayed: false });
        void this.recorder?.covered(covered);
        // The room stored the renamed edit: the early rows go, once they no
        // longer hold what its state may hide (`replacedHolds`).
        if (this.replaced && covered >= this.renamedAt) {
          this.replacedStored = true;
          this.dropReplaced();
        }
        if (this.snapshot.synced && this.snapshot.status !== 'offline')
          this.set({ status: this.live() });
        return;
      }
      // A failed store the server retries: the receipts stay pending, and
      // the strip is only for unsaved work.
      case 'checkpoint-failed':
        if (this.recorder?.unsaved) this.set({ delayed: true });
        return;
      case 'document-rejected':
      case 'authorization-revoked':
        // A store refused for good, a canvas's too large for its cap
        // included: this room's unsaved state is gone on the server, so this
        // tab's edits open for copying (Developer, 2026-09-30).
        this.refused();
        return;
      case 'room-read-only':
        this.readOnly(readOnlyCode(event));
        return;
    }
  }

  /** Asks for a receipt once the server acknowledged every update: it
   * answers when the room stored them, and the stored drafts they cover go. */
  private requestReceipt() {
    if (!(this.recorder?.unsaved && this.unsynced === 0 && this.provider))
      return;
    const id = crypto.randomUUID();
    this.pending.set(id, this.recorder.sequence);
    this.delay.requested(id);
    this.provider.sendStateless(
      JSON.stringify({ id, type: 'checkpoint-request' })
    );
  }

  /** A room that ended or unmounted asks nothing more, as a source does. */
  private armLeave(armed: boolean) {
    if (armed && !(this.ended || this.destroyed))
      globalThis.addEventListener?.('beforeunload', this.leaving);
    else globalThis.removeEventListener?.('beforeunload', this.leaving);
  }

  /** The server refused this channel's update (or discarded the room's
   * unsaved state): the edits are kept as a refused draft to copy, and a
   * fresh room replaces this one. It never rejoins with what was refused.
   * `toast`: say the room refused them (not for a rename that could not go
   * here, whose recovery strip says it). */
  private refused(toast = true) {
    if (this.ended || this.destroyed) return;
    this.ended = true;
    this.dropCopy();
    this.leaveRenamed();
    const recorder = this.recorder;
    const kept = recorder?.unsaved ?? false;
    if (kept && recorder) {
      recorder.refuse();
      if (toast) this.toastRefused();
    } else if (this.unsynced > 0) toastSaveUndone();
    this.recorder = null;
    // The early rows go once the refused row, which holds the renamed edit,
    // landed; with nothing unsaved the room stored it already.
    if (this.replaced && kept && recorder)
      this.dropReplacedOn(recorder.stored());
    else this.dropReplaced();
    this.end();
  }

  /** The room's lineage moved: unsent edits stay stored under the old one
   * (they open for copying), and a fresh room joins the new one. `deleted`:
   * moved by a deletion, or a discard a trash sends too (`dropCopy`). */
  private moved(deleted = false) {
    if (this.ended || this.destroyed) return;
    this.ended = true;
    this.leaveRenamed();
    // Its rows hold the renamed edit once its whole document landed.
    if (this.recorder && this.replaced)
      this.dropReplacedOn(this.recorder.stored());
    const stored = this.recorder?.dispose() ?? Promise.resolve();
    this.recorder = null;
    this.dropCopy(deleted ? stored : undefined);
    this.end();
  }

  /** `after`: what the fresh room waits for before it starts. */
  private end(after?: Promise<unknown>) {
    this.stopUnloaded?.();
    this.mergeWait?.(false);
    this.delay.dispose();
    this.sender?.stop();
    this.stopHold?.();
    this.armLeave(false);
    this.options.seat?.attach(null);
    this.provider?.destroy();
    this.provider = null;
    const replace = () => this.options.onReplace?.();
    if (after) void after.then(replace, replace);
    else queueMicrotask(replace);
  }

  /** The room turned read-only (a frozen account, an owner at its limit, a
   * demotion, a block this version cannot edit): unsaved edits are
   * discarded, as a note's are (Epo 2026-09-29). A board's document still
   * holds them, so a fresh room shows what was saved before. */
  private readOnly(code?: ReadOnlyCode) {
    const unsaved = !!this.recorder?.unsaved;
    // The document may hold what this discards.
    if (unsaved) {
      this.keeper?.stop();
      this.keeper = null;
    }
    this.set({ access: 'read', readOnlyCode: code ?? null });
    const discarded = this.recorder?.discard();
    this.recorder = null;
    // The early rows a renamed edit stood for go with it.
    this.leaveRenamed();
    this.replacedHolds = false;
    this.dropReplaced();
    this.armLeave(false);
    if (
      this.options.board &&
      (unsaved || this.unsynced > 0) &&
      !(this.ended || this.destroyed)
    ) {
      this.ended = true;
      this.end(discarded);
    }
  }

  /** Joins again with a fresh token, after a growing delay while joins
   * keep failing. */
  private rejoin() {
    this.reconnector.refused();
  }

  /** Capy was updated and the room refuses this build: it stops for the
   * page load. An editor turns read-only under the outdated strip, its unsent
   * edits kept for the reloaded page to send (closing the tab still asks when
   * this device could not store them); a reader keeps what it painted. */
  private outdated() {
    if (this.destroyed || this.stale) return;
    this.stale = true;
    this.reconnector.dispose();
    this.provider?.disconnect();
    markUpdateAvailable();
    const unstored = !this.storageOk && !!this.recorder?.unsaved;
    if (this.recorder)
      this.set({ offline: unstored ? 'outdated-unstored' : 'outdated' });
  }

  /** Refused, an access change (4403) included: the item may be gone or no
   * longer this person's, so the page's reads say (a quiz's own read too),
   * and a refused one ends what shows, saying they lost access when the item
   * had worked on the page (Epo 2026-11-20, narrowing Q644). */
  private refusedAccess() {
    for (const queryKey of [
      qk.material(this.materialId),
      qk.quiz(this.materialId),
    ])
      void queryClient.invalidateQueries({ queryKey });
    this.unavailable();
  }

  /** The item was deleted (`item_deleted`, Q39): its stored edits stay,
   * drawn from the rows alone and shown read-only to copy until Discard,
   * which deletes the rows shown; with none drawn, or a store that cannot be
   * read, it is unavailable and the rows stay for the next page load's
   * toast. The page's read answers the same, and the page holds the edits
   * meanwhile (`useDeletedEdits`). */
  private async deleted() {
    if (this.destroyed) return;
    // The recorder's last rows, an early board's edits too, which are stored
    // rows like any: the rows shown and the copy's fate wait for them.
    const stored = (async () => {
      await this.earlyOpen;
      const recorder = this.recorder;
      this.recorder = null;
      await recorder?.dispose();
    })();
    this.dropCopy(stored);
    this.reconnector.dispose();
    void queryClient.invalidateQueries({
      queryKey: qk.material(this.materialId),
    });
    this.set({ deleted: true });
    // This room is their owner while it shows them: no sweep offers them.
    const key = this.draftKey();
    if (key) this.keptDeleted = holdDraftDocument(key);
    await stored;
    const rows = key
      ? await readDrafts(key).catch((error) => {
          console.warn('Draft storage failed:', error);
          return null;
        })
      : [];
    if (this.destroyed) return;
    const drawn = rows && deletedDocument(rows);
    if (!(key && rows && drawn)) {
      this.set({ status: 'unavailable' });
      return;
    }
    this.shownDeleted = showDeletedDrafts(key, {
      doc: drawn.doc,
      rows: drawn.rows,
    });
    this.set({
      recovery: {
        deleted: true,
        doc: drawn.doc,
        refused: true,
        rows: drawn.rows,
      },
      status: 'saved',
      synced: true,
    });
  }

  /** The collaboration service said the item is not found, with no token
   * answer behind it: a fresh token says whether it was deleted (its edits
   * to copy, through a fresh room), live (a token, or 409 for one restored
   * since: it rejoins), or is gone (404, 403), which shows it unavailable,
   * its edits kept for the page's read or the next page load to settle. No
   * answer joins again too, its copy kept. */
  private async notFoundByRoom() {
    const error = await getMaterialCollaborationToken(
      this.materialId,
      this.tokenRequest()
    ).then(
      () => null,
      (error: unknown) => error
    );
    if (this.destroyed) return;
    // Live (a token, a 409 for one restored since), or no answer (offline, a
    // server error): it joins again, its copy kept. Only a refusal ends it.
    const refusal = roomRefusal('', error);
    if (refusal === 'retry') {
      this.reconnector.refused();
      return;
    }
    this.reconnector.dispose();
    if (refusal === 'deleted') this.moved(true);
    else this.refusedAccess();
  }

  /** The item is gone or no longer this user's: the room stops for good.
   * Edits no room holds stay to copy ("reject nothing", Epo 2026-11-18)
   * while nothing has synced: an early board's, and the rows `restore`
   * applied, which no later open could show, the device copy dropped here
   * (review re-check 4 m7). A synced board stays on screen. */
  private unavailable() {
    if (this.destroyed) return;
    this.dropCopy();
    this.reconnector.dispose();
    this.provider?.disconnect();
    // Rows it painted hold edits too, though none was made here.
    const painted = this.earlyRows;
    if (
      !this.snapshot.synced &&
      (this.recorder?.unsaved || painted?.apply.length || painted?.send.length)
    )
      this.keepEarly();
    this.set({ status: 'unavailable' });
  }

  /** The edits no room holds (an early board's, or the rows `restore`
   * applied before any sync) as one refused row, shown for copying until
   * Reload, which asks first. */
  private keepEarly() {
    const { recorder } = this;
    if (!recorder) return;
    const doc = copyOf(this.doc);
    const kept = recorder.refuse();
    this.recorder = null;
    // Renamed already: the early rows go once the refused row landed.
    this.leaveRenamed();
    if (this.replaced) this.dropReplacedOn(recorder.stored());
    // The rows it painted are in the refused one now.
    const painted = this.earlyRows;
    this.earlyRows = null;
    if (painted)
      void deleteDrafts([...painted.apply, ...painted.send]).catch(
        () => undefined
      );
    this.toastRefused();
    this.set({ recovery: { doc, refused: true, rows: [kept] } });
  }

  private toastRefused() {
    userToast({
      description: m.item_edits_refused(),
      id: `item-refused-${this.materialId}`,
      title: m.editor_save_failed(),
      variant: 'error',
    });
  }

  /** The page's Retry once the join ran past its 30 s (`unreachable`): a
   * first open that failed asks for its token again, a join that never
   * answered joins again, each with 30 s more. */
  retry() {
    if (this.destroyed || this.ended) return;
    // An early merge whose code did not load tries again (review re-check
    // R2); a token that never answered is asked again below.
    this.mergeWait?.(true);
    // An early board's edits are renamed before anything joins (Q38, review
    // M3): Retry tries that again, flags that could not be stored or the
    // draft send it waits for, which connects once it is done.
    if (this.renaming) {
      if (!this.snapshot.unloaded) {
        this.set({ unreachable: false });
        this.reconnector.started();
      }
      void this.rename();
      return;
    }
    this.set({ unreachable: false });
    if (this.waiting) {
      this.waiting();
      void this.start();
      return;
    }
    if (!this.provider || this.snapshot.synced) return;
    this.reconnector.started();
    this.provider.disconnect();
    this.provider.connect();
  }

  /** The `unsynced` strip's Discard (Epo 2026-11-23): the held edits go
   * from the device, as a read-only turn discards them, and a fresh room
   * opens on the last saved version. */
  private readonly discardHeld = () => {
    if (this.ended || this.destroyed) return;
    this.ended = true;
    this.keeper?.stop();
    this.keeper = null;
    const discarded = this.recorder?.discard();
    this.recorder = null;
    // The early rows a renamed edit stood for go with it.
    this.leaveRenamed();
    this.replacedHolds = false;
    this.dropReplaced();
    this.end(discarded);
  };

  /** Leaves recovery: the stored edits go and a fresh room opens. */
  async reload() {
    const { deleted, recovery } = this.snapshot;
    // A deleted item's shown edits go, a quiz's in both documents, and the
    // page loads again (Q39).
    const { drafts } = this.options;
    if (deleted && drafts) {
      const target = deletedTarget(
        drafts.actorId,
        false,
        this.materialId,
        drafts.kind === 'quiz'
      );
      if (target) discardDeleted(target);
      return;
    }
    await deleteDrafts(recovery?.rows ?? []).catch(() => undefined);
    // Beside a live room (early edits its state hides): the room shows.
    if (recovery?.merged && !(this.ended || this.destroyed)) {
      if (this.snapshot.recovery === recovery) this.set({ recovery: null });
      return;
    }
    this.ended = true;
    this.end();
  }

  destroy() {
    try {
      this.options.onLeave?.();
    } finally {
      this.tearDown();
    }
  }

  private tearDown() {
    globalThis.document?.removeEventListener('visibilitychange', this.shown);
    this.keeper?.close();
    this.destroyed = true;
    this.stopMerge.abort();
    this.delay.dispose();
    this.doc.off('update', this.grew);
    this.sizeListeners.clear();
    this.sender?.stop();
    this.stopHold?.();
    this.waiting?.();
    this.reconnector.dispose();
    this.armLeave(false);
    this.stopUnloaded?.();
    this.mergeWait?.(false);
    this.keptLate?.();
    this.keptDeleted?.();
    this.shownDeleted?.();
    // The early rows a renamed edit stands for go once a whole document
    // holding it landed, unless they hold the only copy of what the room's
    // state hides; until then they stay, flagged copy-only, never applied.
    this.leaveRenamed();
    if (this.recorder && this.replaced)
      this.dropReplacedOn(this.recorder.stored());
    void this.recorder?.dispose();
    void this.replaced?.dispose();
    this.options.seat?.attach(null);
    this.provider?.destroy();
    this.awareness?.destroy();
    this.undoManager?.destroy();
    this.doc.destroy();
    this.snapshot.recovery?.doc.destroy();
    this.listeners.clear();
  }
}

/**
 * An item room for one rendered copy, started: a new one, or for an embed
 * the one its note's seat holds for this material and document, so two
 * copies in a note share one channel (rate-limit review r6 S-2). `close`
 * gives this copy's hold back.
 */
export function openItemRoom(
  materialId: string,
  {
    kind,
    ...options
  }: ItemRoomOptions & { kind: ItemKind; onReplace: () => void }
): { close: () => void; room: ItemRoom } {
  const { inside, onReplace } = options;
  const writer = options.read ? inside?.writer : undefined;
  const opening: ItemRoomOptions = writer
    ? { ...options, drafts: { actorId: writer, kind }, read: false }
    : options;
  const create = (replace: () => void) => {
    const room = new ItemRoom(materialId, { ...opening, onReplace: replace });
    void room.start();
    return room;
  };
  if (!inside) {
    const room = create(onReplace);
    return { close: () => room.destroy(), room };
  }
  const key = roomKey(
    materialId,
    opening.document ?? 'content',
    !!opening.read
  );
  const { release, room } = inside.hold(key, create, onReplace);
  // A reader may have opened it first, and it keeps no device copy.
  if (opening.keep) room.keepAs(opening.keep);
  return { close: release, room };
}

/**
 * The item's room while `enabled`: created on mount, joined once the token
 * arrives, left on unmount, and replaced by a fresh one when it ends here
 * (refused, moved to a new lineage, recovery left).
 */
export function useItemRoom(
  materialId: string | null,
  kind: ItemKind,
  enabled = true,
  {
    actorId,
    awareness,
    board,
    document,
    inside,
    keep,
    onLeave,
    seed,
    wake,
  }: {
    actorId?: string | null;
    /** `ItemRoomOptions.awareness`. */
    awareness?: boolean;
    /** `ItemRoomOptions.board`; read once, as the room starts. */
    board?: { max: number };
    document?: 'keys';
    /** An embed's note seat (`ItemRoomOptions.inside`). */
    inside?: NoteSeat | null;
    /** `ItemRoomOptions.keep`; read once, as the room starts. */
    keep?: CopyLabel;
    /** `ItemRoomOptions.onLeave`; the latest one is called. */
    onLeave?: () => void;
    /** `ItemRoomOptions.seed`, for the first room only. */
    seed?: RoomSeed | null;
    /** Bumped when an embed comes near the screen again (`ItemRoom.wake`). */
    wake?: number;
  } = {}
) {
  const [room, setRoom] = useState<ItemRoom | null>(null);
  const [generation, setGeneration] = useState(0);
  const start = useRef({ board, keep, onLeave, seed });
  start.current = { board, keep, onLeave, seed };
  useEffect(() => {
    if (!(materialId && enabled)) return;
    const { close, room: created } = openItemRoom(materialId, {
      awareness,
      board: start.current.board,
      document,
      drafts: actorId ? { actorId, kind } : undefined,
      inside,
      keep: start.current.keep,
      kind,
      onLeave: () => start.current.onLeave?.(),
      onReplace: () => setGeneration((value) => value + 1),
      // Unusable once a room ended on it (its document went with the room).
      seed: start.current.seed?.doc.isDestroyed ? null : start.current.seed,
    });
    setRoom(created);
    return () => {
      close();
      setRoom((current) => (current === created ? null : current));
    };
  }, [
    materialId,
    kind,
    enabled,
    document,
    actorId,
    awareness,
    inside,
    generation,
  ]);
  useEffect(() => {
    if (wake) room?.wake();
  }, [room, wake]);
  const snapshot = useSyncExternalStore(
    room?.subscribe ?? noSubscribe,
    room?.getSnapshot ?? initialSnapshot,
    // Rendered to a string (tests), no room has joined yet.
    initialSnapshot
  );
  return { room, snapshot };
}

/**
 * Tells the page an item editor's room turned read-only (a demotion, a frozen
 * account, a full owner) once it could write here: a token on this page gave
 * it write access. One that opened read-only (lowered while away, its device
 * copy and the kept workspace read still an editor's) says nothing, as
 * opening shows no view-only cue (D1). A code (a block this version cannot
 * edit) always tells. A first token read while the item's read says this
 * person may edit asks for that read again: lowered in between, the page
 * learns it from the new read. Returns whether it could write here.
 */
export function useReportReadOnly(
  { access, readOnlyCode }: Pick<ItemRoomSnapshot, 'access' | 'readOnlyCode'>,
  materialId: string,
  onReadOnly: ((code?: ReadOnlyCode) => void) | undefined
) {
  const wrote = useRef(false);
  if (access === 'write') wrote.current = true;
  useEffect(() => {
    if (access !== 'read' || !onReadOnly) return;
    if (wrote.current || readOnlyCode) onReadOnly(readOnlyCode ?? undefined);
    else if (
      queryClient.getQueryData<Material>(qk.material(materialId))?.capabilities
        .canEditContent
    )
      void queryClient.invalidateQueries({
        queryKey: qk.material(materialId),
      });
  }, [access, readOnlyCode, materialId, onReadOnly]);
  return wrote.current;
}

const noSubscribe = () => () => undefined;
const INITIAL: ItemRoomSnapshot = {
  access: null,
  delayed: false,
  deleted: false,
  early: false,
  held: null,
  listsVersion: 0,
  offline: null,
  presence: NO_PRESENCE,
  readOnlyCode: null,
  recovery: null,
  sending: false,
  slowed: false,
  status: 'opening',
  stopped: false,
  synced: false,
  unloaded: false,
  unreachable: false,
};
const initialSnapshot = () => INITIAL;
