import { useEffect, useState, useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import { USE_MSW } from '@/api/auth';
import { getMaterialCollaborationToken } from '@/api/hooks';
import type { SaveBannerState } from '@/components/banners/SaveBanner';
import { userToast } from '@/components/ui/userToast';
import { toastDraftsLost, toastSaveUndone } from '@/features/notes/saveFailure';
import {
  applyReaderMessage,
  type ReaderLists,
} from '@/features/quizzes/liveQuiz';
import { m } from '@/i18n';
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

export type ItemRoomStatus =
  | 'connecting'
  | 'synced'
  | 'syncing'
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
  /** The offline banner while the room cannot be reached (an editor's). */
  offline: Extract<
    SaveBannerState,
    'offline' | 'offline-unstored' | 'offline-limit'
  > | null;
  /** Edits that cannot join this room, shown for copying until Reload. */
  recovery: ItemRecovery | null;
  status: ItemRoomStatus;
  /** The document holds the room's state (painted from it, editable). */
  synced: boolean;
}

/** What a room needs of its provider (the MSW stand-in implements it too). */
export type ItemProvider = Pick<
  RoomProvider,
  'connect' | 'destroy' | 'disconnect' | 'sendStateless'
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

const RETRY_MS = 1500;
const RESTORE_ORIGIN = Symbol('restore');
/** Closes a client rejoins after with a fresh token; any other close
 * refused this channel's update. */
const TRANSIENT_CLOSES = new Set([
  'socket closed',
  'collaboration token expired',
  'collaboration room is being reset',
]);

export interface ItemRoomOptions {
  /** A quiz's keys document instead of the material's own. */
  document?: 'keys';
  /** An editor's room: unsent edits are kept on this device under this
   * account (readers keep none). */
  drafts?: { actorId: string };
  /** The room ended for good here (refused, moved): mount a fresh one. */
  onReplace?: () => void;
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
    recovery: null,
    status: 'connecting',
    synced: false,
  };
  private unsynced = 0;
  private destroyed = false;
  private ended = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly materialId: string;
  private readonly options: ItemRoomOptions;
  private room = '';
  private recorder: DraftRecorder | null = null;
  private storageOk = true;
  private overLimit = false;
  /** Checkpoint requests waiting for a receipt: id -> local edit count. */
  private readonly pending = new Map<string, number>();

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

  private live() {
    return this.unsynced > 0 ? 'syncing' : 'synced';
  }

  private draftKey() {
    const { drafts, document } = this.options;
    if (!drafts) return null;
    const key = draftKey(drafts.actorId, 'material', this.materialId);
    return document ? `${key}:keys` : key;
  }

  async start() {
    let first: Awaited<ReturnType<typeof getMaterialCollaborationToken>>;
    try {
      first = await getMaterialCollaborationToken(
        this.materialId,
        this.options.document
      );
    } catch {
      if (!this.destroyed) this.set({ status: 'unavailable' });
      return;
    }
    if (this.destroyed) return;
    this.room = first.room;
    const access = first.access === 'write' ? 'write' : 'read';
    this.set({ access });
    const key = this.draftKey();
    if (key && access === 'write' && !(await this.restore(key))) return;
    if (this.destroyed) return;
    let cached: string | null = first.token;
    this.provider = createItemProvider({
      document: this.doc,
      name: first.room,
      onAuthenticationFailed: ({ reason }) => {
        if (
          reason === 'collaboration-not-found' ||
          reason === 'collaboration-forbidden'
        ) {
          this.set({ status: 'unavailable' });
          this.provider?.disconnect();
          return;
        }
        if (reason.includes('collaboration room moved')) return;
        // Read-only now (a frozen account, a full owner, a demotion) or a
        // refusal the client retries: join again with a fresh token.
        this.rejoin();
      },
      onClose: ({ code, reason }) => {
        if (code === 4403) {
          this.set({ status: 'unavailable' });
          return;
        }
        if (reason === 'socket closed') {
          this.goOffline();
          return;
        }
        if (reason === 'read-only connection sent a document update') {
          this.readOnly();
          return;
        }
        if (TRANSIENT_CLOSES.has(reason)) {
          this.rejoin();
          return;
        }
        this.refused();
      },
      onStateless: ({ payload }) => this.stateless(payload),
      onSynced: ({ state }) => {
        if (state) {
          if (this.snapshot.offline) this.recorder?.connected();
          this.set({ offline: null, status: this.live(), synced: true });
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
      token: async () => {
        if (cached) {
          const token = cached;
          cached = null;
          return token;
        }
        const fresh = await getMaterialCollaborationToken(
          this.materialId,
          this.options.document
        );
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
      url: first.url,
    });
    this.provider.connect();
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
            status: 'synced',
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
    if (!this.snapshot.offline) return;
    this.set({
      offline: this.overLimit
        ? 'offline-limit'
        : this.storageOk
          ? 'offline'
          : 'offline-unstored',
    });
  }

  private goOffline() {
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
        return;
      }
      case 'document-rejected':
      case 'authorization-revoked':
        // A store refused for good: this room's unsaved state is gone on
        // the server, so this tab's edits open for copying.
        this.refused();
        return;
      case 'room-read-only':
        this.readOnly();
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
    this.provider?.destroy();
    this.provider = null;
    queueMicrotask(() => this.options.onReplace?.());
  }

  /** The room turned read-only (a frozen account, an owner at its limit, a
   * demotion): unsaved edits are discarded, as a note's are. */
  private readOnly() {
    this.set({ access: 'read' });
    void this.recorder?.discard();
    this.recorder = null;
    this.markUnsent(false);
  }

  private rejoin() {
    if (this.destroyed || this.ended || this.retry) return;
    this.provider?.disconnect();
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (!(this.destroyed || this.ended)) this.provider?.connect();
    }, RETRY_MS);
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
    clearTimeout(this.retry);
    markUnsent(this, false);
    void this.recorder?.dispose();
    this.provider?.destroy();
    this.undo.destroy();
    this.doc.destroy();
    this.snapshot.recovery?.doc.destroy();
    this.listeners.clear();
  }
}

/**
 * The item's room while `enabled`: created on mount, joined once the token
 * arrives, left on unmount, and replaced by a fresh one when it ends here
 * (refused, moved to a new lineage, recovery left).
 */
export function useItemRoom(
  materialId: string | null,
  enabled = true,
  { actorId, document }: { actorId?: string | null; document?: 'keys' } = {}
) {
  const [room, setRoom] = useState<ItemRoom | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!(materialId && enabled)) return;
    const created = new ItemRoom(materialId, {
      document,
      drafts: actorId ? { actorId } : undefined,
      onReplace: () => setGeneration((value) => value + 1),
    });
    setRoom(created);
    void created.start();
    return () => {
      created.destroy();
      setRoom((current) => (current === created ? null : current));
    };
  }, [materialId, enabled, document, actorId, generation]);
  const snapshot = useSyncExternalStore(
    room?.subscribe ?? noSubscribe,
    room?.getSnapshot ?? initialSnapshot
  );
  return { room, snapshot };
}

const noSubscribe = () => () => undefined;
const INITIAL: ItemRoomSnapshot = {
  access: null,
  listsVersion: 0,
  offline: null,
  recovery: null,
  status: 'connecting',
  synced: false,
};
const initialSnapshot = () => INITIAL;
