import { useEffect, useState, useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import { USE_MSW } from '@/api/auth';
import { getMaterialCollaborationToken } from '@/api/hooks';
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
import { toastDraftsLost, toastSaveUndone } from '@/features/notes/saveFailure';
import {
  applyReaderMessage,
  type ReaderLists,
} from '@/features/quizzes/liveQuiz';
import { m } from '@/i18n';
import { markUpdateAvailable } from '@/lib/appRelease';
import { MATERIAL_DOCUMENT_LIMITS } from '@/lib/const';
import {
  applyDrafts,
  type DraftRecorder,
  deleteDrafts,
  draftGroups,
  draftKey,
  type EditDraft,
  readDrafts,
  recordDrafts,
  recoveryDocument,
} from '@/lib/editDrafts';
import type { NoteSeat } from './noteSeat';
import { NO_PRESENCE, type PresenceConnection } from './presence';
import { RoomProvider, type RoomProviderConfig } from './roomProvider';
import { type UndoTarget, undoTarget } from './undo';
import { markUnsent } from './unsentItems';
import { LOCAL_EDIT } from './yText';

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
  | 'connecting'
  | 'syncing'
  | 'saved'
  | 'offline'
  | 'unavailable';

export interface ItemRecovery {
  doc: Y.Doc;
  /** Refused for good (otherwise: the room moved on meanwhile). */
  refused: boolean;
  rows: EditDraft[];
}

export interface ItemRoomSnapshot {
  access: 'read' | 'write' | null;
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
  /** Joined, its answer waiting on the user's open budget (Epo 2026-10-20):
   * loading until it syncs, never offline meanwhile. */
  slowed: boolean;
  status: ItemRoomStatus;
  /** The document holds the room's state (painted from it, editable). */
  synced: boolean;
}

/** Whether an item editor stops taking edits: offline past the bound this
 * device may hold, or refused as outdated. */
export function itemEditingStopped(offline: ItemRoomSnapshot['offline']) {
  return offline === 'offline-limit' || isOutdatedBanner(offline);
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

export interface ItemRoomOptions {
  /** A quiz's keys document instead of the material's own. */
  document?: 'keys';
  /** An editor's room: unsent edits are kept on this device under this
   * account (readers keep none). */
  drafts?: { actorId: string };
  /** An embedded quiz's or set's room: it joins inside its note's channel
   * (Epo 2026-10-20). */
  inside?: NoteSeat | null;
  /** The room ended for good here (refused, moved): mount a fresh one. */
  onReplace?: () => void;
  /** A reader (a View, a study page): asks for a read channel even when the
   * user may write (REVIEW5 N2), so the server refuses anything it sends. */
  read?: boolean;
  /** A note's own room (its View): the seat its embeds join inside. */
  seat?: NoteSeat;
}

export class ItemRoom {
  readonly doc = new Y.Doc();
  readonly undo: Y.UndoManager;
  /** What the item's Undo and Redo buttons act on. */
  readonly history: UndoTarget;
  /** A quiz content room: the readers' matching and ordering lists. */
  lists: ReaderLists = new Map();
  private provider: ItemProvider | null = null;
  private snapshot: ItemRoomSnapshot = {
    access: null,
    listsVersion: 0,
    offline: null,
    presence: NO_PRESENCE,
    readOnlyCode: null,
    recovery: null,
    slowed: false,
    status: 'connecting',
    synced: false,
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
  private readonly listeners = new Set<() => void>();
  private readonly materialId: string;
  private readonly options: ItemRoomOptions;
  private room = '';
  private recorder: DraftRecorder | null = null;
  private storageOk = true;
  private overLimit = false;
  /** The room refuses this build (the version gate). */
  private stale = false;
  /** Checkpoint requests waiting for a receipt: id -> local edit count. */
  private readonly pending = new Map<string, number>();
  /** The mode of the eviction notice that came before a close. */
  private eviction: string | null = null;
  /** Stops waiting to start again after a first open that failed. */
  private waiting: (() => void) | null = null;

  constructor(materialId: string, options: ItemRoomOptions = {}) {
    this.materialId = materialId;
    this.options = options;
    // The document holds only this item: Undo covers this user's own edits
    // to it, never others' or the server's.
    this.undo = new Y.UndoManager(this.doc, {
      captureTimeout: 500,
      trackedOrigins: new Set([LOCAL_EDIT]),
    });
    this.history = undoTarget(this.undo);
    this.reconnector = roomReconnector({
      // Still not back after the grace period: the room is offline.
      onStuck: () => this.goOffline(),
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
    return this.unsynced > 0 || this.recorder?.unsaved ? 'syncing' : 'saved';
  }

  private tokenRequest() {
    return {
      access: this.options.read ? ('read' as const) : undefined,
      document: this.options.document,
    };
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
    let first: Awaited<ReturnType<typeof getMaterialCollaborationToken>>;
    try {
      first = await getMaterialCollaborationToken(
        this.materialId,
        this.tokenRequest()
      );
    } catch (error) {
      // Gone or no longer this user's (404, 403): unavailable for good.
      // Offline or a server error: paused until it can join (REVIEW5 B1).
      const refusal = roomRefusal('', error);
      if (refusal === 'notFound' || refusal === 'forbidden') this.unavailable();
      else this.startLater();
      return;
    }
    if (this.destroyed) return;
    this.room = first.room;
    const access = first.access === 'write' ? 'write' : 'read';
    this.set({ access });
    const key = this.draftKey();
    if (key && access === 'write' && !(await this.restore(key))) {
      // Recovery is this open's answer: no room joins.
      this.reconnector.dispose();
      return;
    }
    if (this.destroyed) return;
    let cached: string | null = first.token;
    this.provider = createItemProvider({
      document: this.doc,
      name: first.room,
      onAuthenticationFailed: ({ reason }) => {
        // Gone or no longer this user's (the server's reason, or the API's
        // 404/403 for the token): no retry (REVIEW3 N2).
        const refusal = roomRefusal(reason, this.tokenError);
        this.tokenError = null;
        if (refusal === 'notFound' || refusal === 'forbidden') {
          this.unavailable();
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
        if (reason.includes('collaboration room moved')) return;
        // Read-only now (a frozen account, a full owner, a demotion) or a
        // refusal the client retries: join again with a fresh token.
        this.rejoin();
      },
      onClose: ({ code, reason }) => {
        this.set({ slowed: false });
        if (code === 4403) {
          this.unavailable();
          return;
        }
        if (reason === 'socket closed') {
          this.goOffline();
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
          // A drain (access widened) stored the room first: rejoin, and
          // anything in flight goes again. A discard (or a compaction)
          // threw the room's unsaved state away and moves its lineage, so a
          // fresh room opens, with this tab's unsent edits to copy.
          const drain = this.eviction === 'drain';
          this.eviction = null;
          if (drain) this.rejoin();
          else this.moved();
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
        if (state) {
          if (this.snapshot.offline) this.recorder?.connected();
          this.reconnector.connected();
          this.set({
            offline: null,
            slowed: false,
            status: this.live(),
            synced: true,
          });
          this.markUnsent();
          this.requestReceipt();
          return;
        }
        if (this.snapshot.status !== 'offline')
          this.set({ status: 'connecting' });
      },
      onUnsyncedChanges: ({ number }) => {
        this.unsynced = number;
        this.markUnsent();
        if (this.snapshot.synced && this.snapshot.status !== 'offline')
          this.set({ status: this.live() });
        if (number === 0) this.requestReceipt();
      },
      parent: this.options.inside ?? undefined,
      token: async (previousToken) => {
        if (cached) {
          const token = cached;
          cached = null;
          return token;
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
        // Compacted or discarded while this tab was away: the room's
        // lineage moved, and a fresh room joins it (REVIEW1 M5).
        if (fresh.room !== this.room) {
          this.moved();
          throw new Error('collaboration room moved');
        }
        const now = fresh.access === 'write' ? 'write' : 'read';
        if (now !== this.snapshot.access && now === 'read') this.readOnly();
        this.set({ access: now });
        return fresh.token;
      },
      // Stored drafts not yet covered by a receipt (Q236).
      unsent: () => !!this.recorder?.unsaved,
      url: first.url,
    });
    if (this.provider instanceof RoomProvider)
      this.options.seat?.attach(this.provider);
    this.provider.connect();
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
    let rows = await readDrafts(key).catch((error) => {
      console.warn('Draft storage failed:', error);
      return [] as EditDraft[];
    });
    for (;;) {
      if (this.destroyed) return false;
      const { current, recovery } = draftGroups(rows, this.room);
      if (recovery.length) {
        const doc = recoveryDocument(recovery);
        if (doc) {
          this.set({
            recovery: { doc, refused: !!recovery[0].refused, rows: recovery },
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
      applyDrafts(this.doc, current, RESTORE_ORIGIN);
      this.recorder = recordDrafts({
        adopted: current,
        doc: this.doc,
        ignore: (origin) =>
          origin === RESTORE_ORIGIN ||
          (origin !== null && origin === this.provider),
        key,
        limitBytes: MATERIAL_DOCUMENT_LIMITS.maxContentBytes,
        lineage: this.room,
        onLimit: (over) => {
          this.overLimit = over;
          this.showOffline();
        },
        onStorage: (ok) => {
          this.storageOk = ok;
          this.showOffline();
        },
      });
      return true;
    }
  }

  private showOffline() {
    if (!this.snapshot.offline || this.stale) return;
    this.set({
      offline: this.overLimit
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
          ? 'connecting'
          : this.snapshot.status,
    });
  }

  private goOffline() {
    if (this.stale) return;
    this.set({ status: 'offline' });
    this.markUnsent();
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
        const ids = Array.isArray(event.checkpointIds)
          ? (event.checkpointIds as string[])
          : [];
        let covered = -1;
        for (const id of ids)
          covered = Math.max(covered, this.pending.get(id) ?? -1);
        if (covered < 0) return;
        for (const [id, sequence] of this.pending)
          if (sequence <= covered) this.pending.delete(id);
        void this.recorder?.covered(covered).then(() => this.markUnsent());
        if (this.snapshot.synced && this.snapshot.status !== 'offline')
          this.set({ status: this.live() });
        return;
      }
      case 'document-rejected':
      case 'authorization-revoked':
        // A store refused for good: this room's unsaved state is gone on
        // the server, so this tab's edits open for copying.
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
    this.provider.sendStateless(
      JSON.stringify({ id, type: 'checkpoint-request' })
    );
  }

  /** Edits the server has not acknowledged, or (offline) not stored. */
  private markUnsent(
    value = this.unsynced > 0 ||
      (this.snapshot.status === 'offline' && !!this.recorder?.unsaved)
  ) {
    markUnsent(this, value && !this.ended);
  }

  /** The server refused this channel's update (or discarded the room's
   * unsaved state): the edits are kept as a refused draft to copy, and a
   * fresh room replaces this one. It never rejoins with what was refused. */
  private refused() {
    if (this.ended || this.destroyed) return;
    this.ended = true;
    const kept = this.recorder?.unsaved ?? false;
    if (kept && this.recorder) {
      this.recorder.refuse();
      userToast({
        description: m.item_edits_refused(),
        id: `item-refused-${this.materialId}`,
        title: m.editor_save_failed(),
        variant: 'error',
      });
    } else if (this.unsynced > 0) toastSaveUndone();
    this.recorder = null;
    this.end();
  }

  /** The room's lineage moved: unsent edits stay stored under the old one
   * (they open for copying), and a fresh room joins the new one. */
  private moved() {
    if (this.ended || this.destroyed) return;
    this.ended = true;
    void this.recorder?.dispose();
    this.recorder = null;
    this.end();
  }

  private end() {
    markUnsent(this, false);
    this.options.seat?.attach(null);
    this.provider?.destroy();
    this.provider = null;
    queueMicrotask(() => this.options.onReplace?.());
  }

  /** The room turned read-only (a frozen account, an owner at its limit, a
   * demotion, a block this version cannot edit): unsaved edits are
   * discarded, as a note's are. */
  private readOnly(code?: ReadOnlyCode) {
    this.set({ access: 'read', readOnlyCode: code ?? null });
    void this.recorder?.discard();
    this.recorder = null;
    this.markUnsent(false);
  }

  /** Joins again with a fresh token, after a growing delay while joins
   * keep failing. */
  private rejoin() {
    this.reconnector.refused();
  }

  /** Capy was updated and the room refuses this build: it stops for the
   * page load. An editor turns read-only under the outdated strip, its unsent
   * edits kept for the reloaded page to send (leaving still asks when this
   * device could not store them); a reader keeps what it painted. */
  private outdated() {
    if (this.destroyed || this.stale) return;
    this.stale = true;
    this.reconnector.dispose();
    this.provider?.disconnect();
    markUpdateAvailable();
    const unstored = !this.storageOk && !!this.recorder?.unsaved;
    this.markUnsent(unstored);
    if (this.recorder)
      this.set({ offline: unstored ? 'outdated-unstored' : 'outdated' });
  }

  /** The item is gone or no longer this user's: the room stops for good. */
  private unavailable() {
    if (this.destroyed) return;
    this.reconnector.dispose();
    this.provider?.disconnect();
    this.set({ status: 'unavailable' });
  }

  /** Leaves recovery: the stored edits go and a fresh room opens. */
  async reload() {
    const rows = this.snapshot.recovery?.rows ?? [];
    await deleteDrafts(rows).catch(() => undefined);
    this.ended = true;
    this.end();
  }

  /** Edits not yet acknowledged by the server. */
  get hasUnsyncedChanges() {
    return this.unsynced > 0;
  }

  destroy() {
    this.destroyed = true;
    this.waiting?.();
    this.reconnector.dispose();
    markUnsent(this, false);
    void this.recorder?.dispose();
    this.options.seat?.attach(null);
    this.provider?.destroy();
    this.undo.destroy();
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
  options: ItemRoomOptions & { onReplace: () => void }
): { close: () => void; room: ItemRoom } {
  const create = (onReplace: () => void) => {
    const room = new ItemRoom(materialId, { ...options, onReplace });
    void room.start();
    return room;
  };
  const { inside, onReplace } = options;
  if (!inside) {
    const room = create(onReplace);
    return { close: () => room.destroy(), room };
  }
  const key = [materialId, options.document ?? 'content', !!options.read].join(
    ' '
  );
  const { release, room } = inside.hold(key, create, onReplace);
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
    document,
    inside,
    wake,
  }: {
    actorId?: string | null;
    document?: 'keys';
    /** An embed's note seat (`ItemRoomOptions.inside`). */
    inside?: NoteSeat | null;
    /** Bumped when an embed comes near the screen again (`ItemRoom.wake`). */
    wake?: number;
  } = {}
) {
  const [room, setRoom] = useState<ItemRoom | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!(materialId && enabled)) return;
    const { close, room: created } = openItemRoom(materialId, {
      document,
      drafts: actorId ? { actorId } : undefined,
      inside,
      onReplace: () => setGeneration((value) => value + 1),
    });
    setRoom(created);
    return () => {
      close();
      setRoom((current) => (current === created ? null : current));
    };
  }, [materialId, enabled, document, actorId, inside, generation]);
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
  listsVersion: 0,
  offline: null,
  presence: NO_PRESENCE,
  readOnlyCode: null,
  recovery: null,
  slowed: false,
  status: 'connecting',
  synced: false,
};
const initialSnapshot = () => INITIAL;
