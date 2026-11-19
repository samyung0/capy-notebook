import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { USE_MSW } from '@/api/auth';
import { qk } from '@/api/client';
import { getMaterialCollaborationToken } from '@/api/hooks';
import { queryClient } from '@/api/queryClient';
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
  roomReconnector,
  roomRefusal,
} from '@/features/notes/roomConnection';
import { NOTE_SAVE_DELAY_MS, SaveDelayClock } from '@/features/notes/saveDelay';
import { toastDraftsLost, toastSaveUndone } from '@/features/notes/saveFailure';
import {
  applyReaderMessage,
  type ReaderLists,
} from '@/features/quizzes/liveQuiz';
import { m } from '@/i18n';
import { markUpdateAvailable } from '@/lib/appRelease';
import { BOARD_OFFLINE_MARGIN, MATERIAL_DOCUMENT_LIMITS } from '@/lib/const';
import type { DraftRef } from '@/lib/draftStore';
import {
  applyDrafts,
  DRAFT_SEND_WAIT_MS,
  type DraftRecorder,
  type DraftSender,
  deleteDrafts,
  draftGroups,
  draftKey,
  draftSender,
  dropExpiredGroup,
  type EditDraft,
  heldDraftSessions,
  readDrafts,
  recordDrafts,
  recoveryDocument,
  splitOpenDrafts,
} from '@/lib/editDrafts';
import { editIncidentReporter } from '@/lib/editIncidents';
import { dropDeviceCopies } from '@/lib/sourceCache';
import { hiddenEdits } from './boardHidden';
import {
  type CopyLabel,
  keepDeviceCopy,
  type RoomSeed,
  readRoomSeed,
} from './deviceCopy';
import { offerExpiredDrafts } from './expiredDrafts';
import type { NoteSeat } from './noteSeat';
import { NO_PRESENCE, type PresenceConnection } from './presence';
import { tokenClientIds } from './protocol';
import { RoomProvider, type RoomProviderConfig } from './roomProvider';
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
  doc: Y.Doc;
  /** An early board's edits the re-apply could not show (made to something
   * another person deleted meanwhile, Q33): the room runs on its document
   * beside them, and Reload drops them and shows it. */
  merged?: boolean;
  /** Refused for good (otherwise: the room moved on meanwhile). */
  refused: boolean;
  /** The stored rows Reload deletes. */
  rows: DraftRef[];
}

export interface ItemRoomSnapshot {
  access: 'read' | 'write' | null;
  /** An edit's receipt has waited 25 s of connected time, as a note's (Epo
   * 2026-10-04), or the room said a store failed while this device had edits
   * unsaved: "Saving is delayed" until a receipt answers. */
  delayed: boolean;
  /** A board painted from its device copy takes edits before its join (Epo
   * 2026-11-19, Q27 b1, Q31): under its document's own client id, kept as
   * drafts, re-authored under the room's at the join (`reauthor`). */
  early: boolean;
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
  /** Edits that cannot join this room, shown for copying until Reload. */
  recovery: ItemRecovery | null;
  /** Stored steps of never-accepted sessions are in the draft send (Q319),
   * or an early board's edits are being re-authored (`reauthor`): view-only
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
  /** An early board's re-apply could not load its merge code (Q295, Q398):
   * its edits stay, read-only, until Retry or the browser's reconnect loads
   * it, as a note's (`late-unloaded`). */
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
/** An early board's edits as the room's document takes them anew. */
const REAUTHOR_ORIGIN = Symbol('reauthor');
/** Closes a client rejoins after with a fresh token; any other close
 * refused this channel's update (an eviction goes by its mode). */
const TRANSIENT_CLOSES = new Set([
  'socket closed',
  'collaboration token expired',
  'collaboration room is being reset',
]);
const EVICTED = 'collaboration room evicted';

/** A document holding what `doc` holds. */
function copyOf(doc: Y.Doc) {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

/** Stored rows another open tab records now (its session's lock held) that
 * only it may apply: edits under an id no room assigned (`late`), which that
 * tab re-authors at its own join. */
async function leaveLiveRows(rows: EditDraft[]) {
  if (!rows.some((row) => row.late)) return rows;
  const live = await heldDraftSessions();
  return rows.filter((row) => !(row.late && live.has(row.session)));
}

/** The document an early board's edits are re-authored onto, joining. */
interface Joining {
  /** The accepted rows applied to it, which its recorder adopts. */
  adopted: EditDraft[];
  doc: Y.Doc;
  key: string;
  /** It holds the room's state. */
  synced: boolean;
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
   * account (readers keep none). */
  drafts?: { actorId: string };
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

export class ItemRoom {
  /** The document the page shows and edits: an early board's swaps for the
   * one that joined once its edits are re-authored onto it (`reauthor`). */
  private document: Y.Doc;
  get doc() {
    return this.document;
  }
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
    early: false,
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
   * join re-authors them. Each recorder keeps its own. */
  private rowsLate: { late: boolean } | null = null;
  /** Rows an early board painted that sessions with a room's id wrote (one
   * that joined, or one whose token answered, Q326): at the join, accepted
   * ones apply (`apply`) and never-accepted ones go through the draft send
   * (`send`), as at any open. */
  private earlyRows: { apply: EditDraft[]; send: EditDraft[] } | null = null;
  /** The early board's document joins as it is and holds `earlyRows.send`
   * steps under an id its channel does not hold: its JOIN waits for the
   * draft send to take them. */
  private sendFirst = false;
  /** The document that joins while an early board's edits wait on the one
   * it shows, to be re-authored onto it once it synced (`reauthor`). */
  private joining: Joining | null = null;
  /** A re-author's merge is running. */
  private merging = false;
  /** Ends the reconnect watch of a merge whose code did not load. */
  private stopUnloaded: (() => void) | null = null;
  /** The early board's document, kept for its page's board to leave. */
  private retired: Y.Doc | null = null;
  /** The early recorder whose rows the re-authored edit stands for: its rows
   * go once that edit is stored on this device or by the room. */
  private replaced: DraftRecorder | null = null;
  /** The replaced rows are still the only stored copy of edits the re-apply
   * could not show: they stay until that copy is stored. */
  private replacedHolds = false;
  /** The re-authored edit's local count, for the receipt that covers it. */
  private reauthoredAt = 0;
  /** Stops a re-author's merge when the room goes. */
  private readonly merge = new AbortController();
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
  /** Closed for this person's access change (4403), until it syncs again. */
  private accessChanged = false;
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
    this.document = options.seed?.doc ?? new Y.Doc();
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
   * until then (a copy's, or the board's before a swap), so the removals-only
   * gate holds meanwhile. */
  private measure(provisional?: number) {
    if (!this.options.board) return;
    if (provisional !== undefined) {
      this.measured = { base: provisional, since: 0 };
      this.sized();
    } else if (this.measured) return;
    const measuring = this.measured;
    const doc = this.doc;
    const run = () => {
      // A receipt's measure, or another document's, came first.
      if (this.destroyed || this.measured !== measuring || this.doc !== doc)
        return;
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
      // Gone or no longer this user's (404, 403): unavailable for good.
      // Offline or a server error: paused until it can join (REVIEW5 B1).
      const refusal = roomRefusal('', error);
      if (refusal === 'notFound' || refusal === 'forbidden') {
        // An early board's edits, waiting ones too, stay to copy.
        await this.earlyOpen;
        this.refusedAccess();
      } else this.startLater();
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
    // The document the room joins with. An early board's edits are under its
    // copy's own client id, which no room assigned (Q31, as a note's late
    // rows are re-authored, Q406): a document of the room's joins
    // instead and takes them anew once synced (`reauthor`). With none yet,
    // the copy's document takes the token's id now, so what is drawn from
    // here on goes as it is, and it joins as any. Rows of sessions that held
    // a room's id go as at any open (Q326): accepted ones with the document,
    // never-accepted ones through the draft send.
    let joined = this.doc;
    let storedFrom = this.options.seed?.version;
    if (early && access === 'write' && key) {
      const waiting = this.earlyRows ?? { apply: [], send: [] };
      this.earlyRows = null;
      if (this.recorder?.unsaved) {
        const next = await this.roomCopy(first.room);
        if (this.destroyed || this.ended) {
          next?.doc.destroy();
          return;
        }
        joined = next?.doc ?? new Y.Doc({ gc: true });
        applyDrafts(joined, waiting.apply, RESTORE_ORIGIN);
        storedFrom = next?.version;
        this.joining = {
          adopted: waiting.apply,
          doc: joined,
          key,
          synced: false,
        };
      } else {
        this.adopt(first.token);
        this.recorder?.adopt(waiting.apply);
        this.sendFirst = waiting.send.length > 0;
      }
      if (waiting.send.length) this.sendDrafts(key, waiting.send);
    }
    let cached: string | null = first.token;
    this.provider = createItemProvider({
      awareness: this.awareness,
      // While its never-accepted steps are held, a JOIN waits for the draft
      // send to take them (Q327).
      beforeJoin: () => {
        if (!(this.heldSteps || this.sendFirst)) return;
        // The hold's connect asks for a send at once (Q328, Q360).
        this.sender?.now();
        return this.sender?.settled;
      },
      document: joined,
      name: first.room,
      onAuthenticationFailed: ({ reason }) => {
        // Gone or no longer this user's (the server's reason, or the API's
        // 404/403 for the token): no retry (REVIEW3 N2).
        const refusal = roomRefusal(reason, this.tokenError);
        this.tokenError = null;
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
        // Read-only now (a frozen account, a full owner, a demotion) or a
        // refusal the client retries: join again with a fresh token.
        this.rejoin();
      },
      onClose: ({ code, reason }) => {
        this.delay.disconnected();
        this.set({ slowed: false });
        // This person's access changed, with no notice: a fresh token says
        // what they have now. A demotion reads on; a removal is refused and
        // stops at the token, keeping the page (Epo 2026-11-05).
        if (code === 4403) {
          this.accessChanged = true;
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
            this.moved();
          }
          return;
        }
        if (TRANSIENT_CLOSES.has(reason)) {
          this.rejoin();
          return;
        }
        this.refused();
      },
      onPresence: (presence) => this.set({ presence }),
      onSlowed: (slowed) =>
        slowed ? this.slowed() : this.set({ slowed: false }),
      onStateless: ({ payload }) => this.stateless(payload),
      onSynced: ({ state }) => {
        if (state && this.joining) {
          this.joining.synced = true;
          this.reauthor();
          return;
        }
        if (state) {
          this.accessChanged = false;
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
      storedFrom,
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
    this.keepCopy(joined, storedFrom !== undefined);
    globalThis.document?.addEventListener('visibilitychange', this.shown);
    this.provider.connect();
  }

  /** The device copy of the room again, for the document an early board's
   * edits are re-authored onto: what the room confirmed, so the JOIN names
   * its version and only the difference downloads (another tab may have
   * kept a newer one meanwhile). None when it went or names another room. */
  private async roomCopy(room: string) {
    const owner = this.options.drafts?.actorId;
    const read = owner
      ? await readRoomSeed(owner, this.materialId, this.copyDocument()).catch(
          () => null
        )
      : null;
    if (read && read.room !== room) {
      read.doc.destroy();
      return null;
    }
    return read;
  }

  /** An early board with no edits yet, its token answered (a slow join, or
   * the 30 s unreachable state with the API up): from now on it writes under
   * the id the token offers, which the provider declares at its JOIN as it
   * would for any document that never wrote. That id is recorded to no one,
   * in no history and bound by no live channel, so the JOIN binds it and its
   * edits go as any session's (`ClientIds::holds`, Q236): nothing is
   * re-applied, and the board stays. Its drafts keep that token (Q288). */
  private adopt(token: string) {
    try {
      this.doc.clientID = tokenClientIds(token).clientId;
    } catch {
      // No id offered: the provider's JOIN refuses it as it is.
      return;
    }
    if (this.rowsLate) this.rowsLate.late = false;
    this.lastToken = token;
  }

  /** The joined document synced: an early board's edits, made under its
   * copy's own client id, are merged onto it as new edits under the id the
   * room assigned (`mergeLate` re-authoring, the late merge's WASM placing
   * list items and map values alike, as a note's re-author does), and the
   * page's board moves onto it. The board takes no edits meanwhile, nor
   * while a draft send of earlier sessions' steps runs (it goes first). A
   * merge whose code did not load keeps everything and tries again on Retry
   * and on the browser's reconnect (Q295, Q398); one that ran and failed
   * goes to the copy-only recovery with everything kept (Q281). */
  private reauthor() {
    const joining = this.joining;
    if (!joining?.synced || this.merging || this.sender) return;
    this.merging = true;
    this.stopUnloaded?.();
    this.accessChanged = false;
    if (this.snapshot.offline) this.recorder?.connected();
    this.boardFull = false;
    this.reconnector.connected();
    this.delay.connected();
    this.set({
      offline: null,
      sending: true,
      slowed: false,
      status: 'syncing',
      stopped: false,
      unloaded: false,
      unreachable: false,
    });
    // What the page has yet to write into the board's document (an open
    // plane or chart closing) goes in first.
    try {
      this.options.onLeave?.();
    } catch (error) {
      console.warn('Leaving the board failed:', error);
    }
    const old = Y.encodeStateAsUpdate(this.doc);
    const { signal } = this.merge;
    const current = () =>
      !(this.destroyed || this.ended || this.joining !== joining);
    void (async () => {
      let merging: typeof import('./lateMerge/lateMerge');
      try {
        merging = await import('./lateMerge/lateMerge');
      } catch (error) {
        this.merging = false;
        if (current()) this.unloaded(error);
        return;
      }
      try {
        const { hidden, merged } = await merging.mergeLate(
          old,
          () => Y.encodeStateAsUpdate(joining.doc),
          joining.doc.clientID,
          signal
        );
        this.merging = false;
        if (!current()) return;
        this.swap(
          joining,
          (doc) => merging.applyMerged(doc, merged, REAUTHOR_ORIGIN, true),
          hidden.length > 0
        );
      } catch (error) {
        this.merging = false;
        if (signal.aborted || !current()) return;
        if (error instanceof merging.LateMergeUnloaded) {
          this.unloaded(error);
          return;
        }
        console.warn('Re-authoring the early edits failed:', error);
        // Kept to copy; the strip says so, nothing the room refused.
        this.refused(false);
      }
    })();
  }

  /** The merge's code did not load: the early board's edits stay as they
   * are, read-only, under the note's strip (`late-unloaded`) until Retry or
   * the browser's reconnect loads it (Q295, Q398). */
  private unloaded(error: unknown) {
    console.warn('The late merge did not load:', error);
    this.set({ unloaded: true });
    const again = () => this.reauthor();
    globalThis.addEventListener?.('online', again);
    this.stopUnloaded = () => {
      globalThis.removeEventListener?.('online', again);
      this.stopUnloaded = null;
    };
  }

  /** The joined document holds the room's state and now takes the early
   * board's edits (`apply`) as this session's first: it records from here,
   * the page's board moves onto it, and the early rows go once that edit is
   * stored. What the re-apply could not show (made to an element or block
   * another person deleted meanwhile) is kept apart for copying (Q33). */
  private swap(
    joining: Joining,
    apply: (doc: Y.Doc) => void,
    reported: boolean
  ) {
    const { adopted, doc: joined, key } = joining;
    const replaced = this.recorder;
    const early = this.doc;
    const held = Y.decodeStateVector(Y.encodeStateVector(joined));
    const recorder = this.record(key, adopted, joined);
    apply(joined);
    this.reauthoredAt = recorder.sequence;
    // What the merge hides that no element or block accounts for (a piece
    // it dropped) keeps the whole early board to copy: nothing goes unsaid.
    const hidden =
      hiddenEdits(early, joined, held) ?? (reported ? copyOf(early) : null);
    this.replaced = replaced;
    this.replacedHolds = !!hidden;
    // The size the board had, until the joined document's own measure.
    const size = this.size()?.bytes;
    this.document.off('update', this.grew);
    this.retired = early;
    this.document = joined;
    this.joining = null;
    joined.on('update', this.grew);
    this.measured = null;
    this.measure(size);
    this.set({
      early: false,
      recovery: hidden
        ? { doc: hidden, merged: true, refused: false, rows: [] }
        : null,
      sending: false,
      status: this.live(),
      synced: true,
    });
    void (async () => {
      if (hidden) {
        const kept = await recorder.keepHidden(Y.encodeStateAsUpdate(hidden));
        if (!kept) return;
        const { recovery } = this.snapshot;
        // Reloaded meanwhile: the copy went with the recovery.
        if (recovery?.doc === hidden)
          this.set({ recovery: { ...recovery, rows: [kept] } });
        else {
          void deleteDrafts([kept]).catch(() => undefined);
        }
        this.replacedHolds = false;
        // Refused or moved meanwhile: its own rows and this one stand for
        // the early ones.
        if (this.recorder !== recorder) {
          if (this.replaced === replaced) this.dropReplaced();
          return;
        }
      }
      const landed = await recorder.stored();
      if (landed && this.replaced === replaced) this.dropReplaced();
    })();
    this.requestReceipt();
  }

  /** The early rows the re-authored edit stands for go, unless they still
   * hold the only stored copy of what the re-apply could not show. */
  private dropReplaced() {
    if (this.replacedHolds) return;
    void this.replaced?.discard();
    this.replaced = null;
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

  /** The room's confirmed state in `doc` goes on the device: on hide and at
   * the end, when nothing of this device's is unsent. `seeded`: it starts
   * from a copy. */
  private keepCopy(
    doc = this.joining?.doc ?? this.doc,
    seeded = !!this.options.seed
  ) {
    const { keep } = this.options;
    if (!keep) return;
    this.keeper = keepDeviceCopy(doc, {
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
      seeded,
    });
  }

  /** A refusal: this copy goes, and nothing writes it back. */
  private dropCopy() {
    this.keeper?.stop();
    this.keeper = null;
    void dropDeviceCopies(this.materialId, this.options.document);
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
      this.set({ sending: false });
      // A group the room did not take, its steps not applied here: a fresh
      // room opens it copy-only (Q360). Held ones the JOIN's refusal takes.
      if (sender.kept && !held) {
        this.moved();
        return;
      }
      // An early board's edits are re-authored once the room holds the
      // steps it painted, which its joined document then holds too, so the
      // merge leaves them as they are.
      if (this.joining) {
        applyDrafts(this.joining.doc, pending, RESTORE_ORIGIN);
        this.reauthor();
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
    let rows = await readDrafts(key).then(
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
    for (;;) {
      if (this.destroyed) return false;
      const { current, expired, recovery, refused } = await draftGroups(
        rows,
        this.room
      );
      // Destroyed while the drafts worker answered: nothing starts (r6 S1).
      if (this.destroyed) return false;
      if (recovery.length) {
        const doc = recoveryDocument(recovery);
        // Past the 7-day expiry: the room opens, and a toast offers them (D14).
        if (doc && expired) {
          offerExpiredDrafts({
            doc,
            document: this.options.document,
            materialId: this.materialId,
            onGone: () =>
              dropExpiredGroup(
                recovery,
                editIncidentReporter('material', this.materialId)
              ),
            // Read at the download: the page may name it after this opens.
            title: () => this.options.keep?.title ?? this.materialId,
          });
          rows = rows.filter((row) => !recovery.includes(row));
          continue;
        }
        if (doc) {
          this.set({
            recovery: { doc, refused, rows: recovery },
            status: 'saved',
            synced: true,
          });
          return false;
        }
        toastDraftsLost();
        await deleteDrafts(recovery).catch(() => undefined);
        rows = rows.filter((row) => !recovery.includes(row));
        continue;
      }
      // Accepted sessions' rows apply here; never-accepted ones with stored
      // tokens go through the draft send (Q326).
      const { apply, send } = splitOpenDrafts(current);
      applyDrafts(this.doc, apply, RESTORE_ORIGIN);
      this.record(key, apply);
      if (send.length) this.sendDrafts(key, send);
      return true;
    }
  }

  /** Records this session's edits in `doc` as drafts on this device;
   * `late`: under a client id no room assigned (`rowsLate`). */
  private record(
    key: string,
    adopted: EditDraft[],
    doc = this.doc,
    late = false
  ) {
    const mark = { late };
    this.rowsLate = mark;
    this.recorder = recordDrafts({
      adopted,
      doc,
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
      report: editIncidentReporter('material', this.materialId),
      token: () => this.lastToken,
      unassigned: () => mark.late,
    });
    return this.recorder;
  }

  /** An early board (`canOpenEarly`) starts recording before its join,
   * under its copy's own client id. The rows earlier sessions here left
   * paint with the copy: ones made the same way (a reload before the join)
   * are its person's own edits, re-authored with this session's at the join
   * as a note's copy draft is (Q229); ones of a session that held a room's id
   * (it joined, or its token answered) go at the join as at any open, applied
   * or sent (`earlyRows`, Q326); another open tab's stay its own. Rows to
   * copy keep the board waiting for the join. Its size is the copy's. */
  private async openEarly() {
    const key = this.draftKey();
    const { seed } = this.options;
    if (!(key && seed)) return false;
    const rows = await readDrafts(key)
      .then(leaveLiveRows)
      .catch(() => null);
    if (!rows || this.destroyed || this.ended || this.provider) return false;
    const { current, recovery } = rows.length
      ? await draftGroups(rows, seed.room)
      : { current: [], recovery: [] };
    if (this.destroyed || this.ended || this.provider) return false;
    if (recovery.length) return false;
    this.room = seed.room;
    // Its size is the copy's at once, so the removals-only gate holds from
    // the first edit (review b1 finding 10); the waiting rows add theirs.
    this.measure(seed.row.size);
    applyDrafts(this.doc, current, RESTORE_ORIGIN);
    this.earlyRows = splitOpenDrafts(current.filter((row) => !row.late));
    this.record(
      key,
      current.filter((row) => row.late),
      this.doc,
      true
    );
    this.set({ early: true });
    if (this.snapshot.status === 'offline') this.goOffline();
    return true;
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
        // The room stored the re-authored edit: the early rows go.
        if (this.replaced && covered >= this.reauthoredAt) this.dropReplaced();
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
    // A document joining for an early board holds none of its edits yet.
    if (this.joining) return;
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
   * `toast`: say the room refused them (not for a re-apply that failed here,
   * whose recovery strip says it). */
  private refused(toast = true) {
    if (this.ended || this.destroyed) return;
    this.ended = true;
    this.dropCopy();
    const kept = this.recorder?.unsaved ?? false;
    if (kept && this.recorder) {
      this.recorder.refuse();
      if (toast) this.toastRefused();
    } else if (this.unsynced > 0) toastSaveUndone();
    this.recorder = null;
    // The refused row holds what the re-authored edit stood for; while a
    // part it cannot show is still being stored, the swap drops them after.
    this.dropReplaced();
    this.end();
  }

  /** The room's lineage moved: unsent edits stay stored under the old one
   * (they open for copying), and a fresh room joins the new one. */
  private moved() {
    if (this.ended || this.destroyed) return;
    this.ended = true;
    this.dropCopy();
    // Its rows hold the re-authored edit, which stands for the early ones.
    if (this.recorder && this.replaced && !this.replacedHolds)
      void this.recorder.dispose().then(() => this.dropReplaced());
    else void this.recorder?.dispose();
    this.recorder = null;
    this.end();
  }

  /** `after`: what the fresh room waits for before it starts. */
  private end(after?: Promise<unknown>) {
    this.merge.abort();
    this.stopUnloaded?.();
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
    // The early rows a re-authored edit stood for go with it.
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

  /** A refusal not told as an access change may mean the item is gone: the
   * page's read says, and a refused one ends what shows (Epo 2026-11-05, Q644). */
  private refusedAccess() {
    if (!this.accessChanged)
      void queryClient.invalidateQueries({
        queryKey: qk.material(this.materialId),
      });
    this.unavailable();
  }

  /** The item is gone or no longer this user's: the room stops for good. An
   * early board's own edits, which no room holds, stay to copy ("reject
   * nothing", Epo 2026-11-18). */
  private unavailable() {
    if (this.destroyed) return;
    this.dropCopy();
    this.reconnector.dispose();
    this.provider?.disconnect();
    if (this.snapshot.early && this.recorder?.unsaved) this.keepEarly();
    this.set({ status: 'unavailable' });
  }

  /** The early board's edits as one refused row, shown for copying until
   * Reload, which asks first. */
  private keepEarly() {
    if (!this.recorder) return;
    const doc = copyOf(this.doc);
    const kept = this.recorder.refuse();
    this.recorder = null;
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
    if (this.snapshot.unloaded) {
      this.reauthor();
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

  /** Leaves recovery: the stored edits go and a fresh room opens. */
  async reload() {
    const { recovery } = this.snapshot;
    await deleteDrafts(recovery?.rows ?? []).catch(() => undefined);
    // Beside a live room (a re-apply's hidden edits): the room shows.
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
    this.delay.dispose();
    this.doc.off('update', this.grew);
    this.sizeListeners.clear();
    this.sender?.stop();
    this.stopHold?.();
    this.waiting?.();
    this.reconnector.dispose();
    this.armLeave(false);
    this.merge.abort();
    this.stopUnloaded?.();
    const disposed = this.recorder?.dispose();
    // The early rows a re-authored edit stands for go once its own rows are
    // written, unless they hold the only copy of what it could not show;
    // until then they stay late (`rowsLate`), never shown twice.
    const replaced = this.replaced;
    if (replaced && disposed && !this.replacedHolds)
      void disposed.then(() => replaced.discard());
    else void replaced?.dispose();
    this.options.seat?.attach(null);
    this.provider?.destroy();
    this.awareness?.destroy();
    this.undoManager?.destroy();
    this.doc.destroy();
    this.joining?.doc.destroy();
    this.retired?.destroy();
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
  options: ItemRoomOptions & { onReplace: () => void }
): { close: () => void; room: ItemRoom } {
  const { inside, onReplace } = options;
  const writer = options.read ? inside?.writer : undefined;
  const opening: ItemRoomOptions = writer
    ? { ...options, drafts: { actorId: writer }, read: false }
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
  const key = [materialId, opening.document ?? 'content', !!opening.read].join(
    ' '
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
      drafts: actorId ? { actorId } : undefined,
      inside,
      keep: start.current.keep,
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
  }, [materialId, enabled, document, actorId, awareness, inside, generation]);
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

const noSubscribe = () => () => undefined;
const INITIAL: ItemRoomSnapshot = {
  access: null,
  delayed: false,
  early: false,
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
