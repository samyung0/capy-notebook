import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import { setHeld } from './held';
import type { NoteSeat, SeatedRoom } from './noteSeat';
import { MAX_UPDATE_BYTES, splitUpdate } from './pieces';
import { type PresenceConnection, readPresence } from './presence';
import {
  joinPayload,
  type Message,
  MessageKind,
  message,
  Reader,
  readClosed,
  readSync,
  readText,
  SyncKind,
  syncMessage,
  text,
  tokenClientIds,
} from './protocol';
import { type ChannelHandler, CollabSocket } from './socket';

export interface RoomProviderConfig {
  /** Shared with the editor (Plate passes its own). */
  awareness?: Awareness | null;
  document: Y.Doc;
  name: string;
  onAuthenticated?: () => void;
  /** The server refused the room; `reason` says why (`collaboration-*`). */
  onAuthenticationFailed?: (event: { reason: string }) => void;
  /** The room closed: the server closed this channel, or the socket dropped. */
  onClose?: (event: { code: number; reason: string }) => void;
  onConnect?: () => void;
  onDestroy?: () => void;
  /** The socket dropped or the room was left. */
  onDisconnect?: () => void;
  /** The room's other editors (`presence.ts`); none once the channel ends. */
  onPresence?: (connections: PresenceConnection[]) => void;
  /** The room's answer waits on the user's open budget (many large opens
   * lately): joined and still loading, not offline (true); or that wait
   * ended with its channel, closed or parked unsynced (false). */
  onSlowed?: (slowed: boolean) => void;
  onStateless?: (event: { payload: string }) => void;
  onSynced?: (event: { state: boolean }) => void;
  onUnsyncedChanges?: (event: { number: number }) => void;
  /** An embedded quiz's or set's room: it joins inside its note's channel
   * (Epo 2026-10-20), only while the note is joined. */
  parent?: NoteSeat;
  /** The socket to join on; the tab's shared one for the URL by default. */
  socket?: CollabSocket;
  token: () => Promise<string>;
  url: string;
}

/** The server's notice that the user is in a timeout (`TIMEOUT_TYPE`,
 * collaboration-rs/crates/server/src/socket.rs). */
const TIMEOUT_TYPE = 'update-timeout';
/** The server's notice that the room's answer waits on the user's open
 * budget (`OPEN_SLOWED_TYPE`, collaboration-rs/crates/server/src/room.rs). */
const OPEN_SLOWED_TYPE = 'open-slowed';
/** Why the server closed a channel as its user's oldest when they joined
 * one past their cap (`OLDEST_CLOSED_REASON`, same file). */
export const OLDEST_CLOSED_REASON = 'collaboration-oldest-closed';
/** Why the server closed an embed's channel: its note joined one past its
 * cap of embed channels (`EMBED_CLOSED_REASON`, same file). */
export const EMBED_CLOSED_REASON = 'collaboration-embed-closed';
/** Why the server closed or refused an embed's channel: its note's channel
 * is not joined (`NOTE_CLOSED_REASON`, same file). */
const NOTE_CLOSED_REASON = 'collaboration-note-closed';
/** Why a room stopped: an update holds a piece over the server's cap, which
 * no resend can fix. */
export const UPDATE_TOO_LARGE_REASON = 'collaboration-update-too-large';

/**
 * One room over the tab's shared collaboration socket (capy-sync 1): join
 * with a token, y-sync, awareness, stateless messages, ACK-counted unsynced
 * changes, in-band token refresh. The server never echoes this client's own
 * updates or awareness.
 *
 * In a timeout (Epo 2026-10-18) the room sends nothing and counts as not
 * synced; edits made meanwhile stay in the document. When it ends the
 * channel joins again on the same socket: the room's step 1 is answered with
 * everything this client holds, and the room is synced again once its own
 * step 2 arrives.
 *
 * Closed as the user's oldest joined channel (a user holds at most 22, Epo
 * 2026-10-19) the room waits, not synced, and joins again once the user comes
 * back to it: the tab shows again, or an edit here. Joining at once would
 * close their next oldest.
 *
 * An update holding a piece over the server's cap (a struct that cannot be
 * cut) is never sent: the room stops and closes, and joins again only when
 * remounted, so it neither loops on timeouts nor drops the edit.
 *
 * An embedded quiz's or set's room (`parent`) joins inside its note's
 * channel (Epo 2026-10-20): only while the note is joined, naming it, ended
 * with it and joined again when it joins. Closed as its note's oldest embed
 * it waits like a room closed as the user's oldest, and joins again once it
 * is near the screen again (`wake`).
 *
 * The document writes under the client id the server assigned (Q213): until
 * its first writable JOINED it takes the id each JOIN's token offers (a read
 * channel, which never writes, keeps taking them), then it keeps that id for
 * life and names it in every JOIN, so a reconnect binds the same id and its
 * Undo stack survives. The server admits its changes only under ids it
 * assigned to this user.
 */
export class RoomProvider implements ChannelHandler, SeatedRoom {
  readonly awareness: Awareness;
  readonly document: Y.Doc;
  isAuthenticated = false;
  isConnected = false;
  isSynced = false;
  /** Updates and step 2 replies sent that the server has not acknowledged. */
  unsyncedChanges = 0;
  /** Updates and step 2 replies sent on this channel, and acknowledged. */
  private sent = 0;
  private acknowledged = 0;
  /** The `sent` count of a split update's last piece, until it is
   * acknowledged; the tab holds back meanwhile (`setHeld`). */
  private lastPiece: number | null = null;
  /** The user is in a timeout: nothing is sent until it ends. */
  private paused = false;
  /** Closed as the user's oldest: joins again on the user's return. */
  private parked = false;
  /** The channel's open is slowed and has not synced. */
  private slowedOpen = false;
  /** An update over the server's cap: no more joins. */
  private stopped = false;
  /** The room's presence reported others since the channel joined. */
  private presence = false;
  private readonly config: RoomProviderConfig;
  private readonly socket: CollabSocket;
  private channel: number | null = null;
  private wanted = false;
  private destroyed = false;
  /** A note's room: the seat its embeds join inside. */
  private noteSeat: NoteSeat | null = null;
  /** The client id is kept for the document's life: a writable JOINED bound
   * it, or the document wrote under a token's id (a read channel whose token
   * turned writable, Q226 M1). */
  private bound = false;
  /** The document took a token's client id. */
  private adopted = false;
  /** A DOCX session's second id, for its editor's resident layout worker
   * (Q219): taken with the document's and kept with it. */
  workerClientId: number | undefined;

  constructor(config: RoomProviderConfig) {
    this.config = config;
    this.document = config.document;
    this.awareness = config.awareness ?? new Awareness(config.document);
    this.socket = config.socket ?? CollabSocket.for(config.url);
    this.document.on('update', this.documentUpdate);
    this.awareness.on('update', this.awarenessUpdate);
  }

  get hasUnsyncedChanges() {
    return this.unsyncedChanges > 0;
  }

  /** The shared socket's state: open while the server closed only this room. */
  get socketStatus() {
    return this.socket.status;
  }

  /** A note's channel while joined and not paused: its embeds join in it. */
  get seatChannel() {
    return this.isAuthenticated && !this.paused ? this.channel : null;
  }

  /** This note's room is (or no longer is) the seat of its embeds. */
  seat(seat: NoteSeat | null) {
    this.noteSeat = seat;
  }

  connect() {
    if (this.destroyed || this.wanted || this.stopped) return;
    this.wanted = true;
    this.config.parent?.add(this);
    this.socket.attach(this);
    if (this.socket.status === 'connected') void this.join();
  }

  disconnect() {
    if (!this.wanted) return;
    this.wanted = false;
    this.config.parent?.delete(this);
    this.unpark();
    const joined = this.channel !== null;
    if (joined) this.send(MessageKind.Leave);
    this.endChannel();
    this.socket.detach(this);
    if (joined) this.config.onDisconnect?.();
  }

  destroy() {
    this.disconnect();
    this.destroyed = true;
    this.config.onDestroy?.();
    this.document.off('update', this.documentUpdate);
    this.awareness.off('update', this.awarenessUpdate);
  }

  sendStateless(payload: string) {
    if (this.isAuthenticated && !this.paused)
      this.send(MessageKind.Stateless, text(payload));
  }

  onSocketOpen() {
    if (this.wanted && !this.parked) void this.join();
  }

  /** An embed's note joined: the embed joins inside it. */
  noteJoined() {
    if (this.wanted && !this.parked && this.socket.status === 'connected')
      void this.join();
  }

  /** An embed's note ended or joins again: the server closed this channel
   * with it, so it ends here too and joins again with the note. */
  noteEnded() {
    if (this.channel !== null) this.endChannel();
  }

  /** An embed closed as its note's oldest is near the screen again. */
  wake() {
    if (!this.parked) return;
    this.unpark();
    if (this.wanted && this.socket.status === 'connected') void this.join();
  }

  /** The user's timeout ended: the same channel joins again (the room
   * sends its step 1 and this client answers with all it holds). A note's
   * embeds end and join again once it has; an embed whose note did not join
   * again joins again itself, after every room on the socket resumed. */
  onResume() {
    if (!this.paused) return;
    this.paused = false;
    const channel = this.channel;
    if (channel === null) return;
    if (this.config.parent) {
      queueMicrotask(() => {
        if (this.channel !== channel || this.paused) return;
        this.isAuthenticated = false;
        void this.sendJoin(channel);
      });
      return;
    }
    this.isAuthenticated = false;
    this.noteSeat?.ended();
    void this.sendJoin(channel);
  }

  /** The page went idle (`idle.ts`, Epo 2026-10-20): the channel ends with
   * no close or drop reported, and the room joins again when the socket
   * opens on the next input or focus. */
  onSleep() {
    if (this.channel !== null) this.endChannel();
  }

  onSocketClose() {
    if (this.channel === null) return;
    this.endChannel();
    this.config.onClose?.({ code: 0, reason: 'socket closed' });
    this.config.onDisconnect?.();
  }

  onMessage({ channel, kind, payload }: Message) {
    if (channel !== this.channel) return;
    switch (kind) {
      case MessageKind.Joined:
        this.joined(payload[0] === 1);
        return;
      case MessageKind.Refused: {
        const reason = readText(payload);
        this.endChannel();
        // An embed whose note left meanwhile joins again with the note.
        if (reason !== NOTE_CLOSED_REASON)
          this.config.onAuthenticationFailed?.({ reason });
        return;
      }
      case MessageKind.Closed: {
        const event = readClosed(payload);
        this.endChannel();
        if (
          event.reason === OLDEST_CLOSED_REASON ||
          event.reason === EMBED_CLOSED_REASON
        )
          this.park();
        else if (event.reason !== NOTE_CLOSED_REASON)
          this.config.onClose?.(event);
        return;
      }
      case MessageKind.Sync:
        this.sync(payload);
        return;
      case MessageKind.Ack: {
        const count = new Reader(payload).varUint();
        this.acknowledged += count;
        this.setUnsynced(Math.max(0, this.unsyncedChanges - count));
        if (this.lastPiece !== null && this.acknowledged >= this.lastPiece)
          this.setLastPiece(null);
        return;
      }
      case MessageKind.Awareness:
        applyAwarenessUpdate(this.awareness, payload, this);
        return;
      case MessageKind.Stateless: {
        const event = readText(payload);
        if (event.includes(OPEN_SLOWED_TYPE)) {
          const notice = JSON.parse(event) as { type?: string };
          if (notice.type === OPEN_SLOWED_TYPE) {
            if (!this.isSynced) {
              this.slowedOpen = true;
              this.config.onSlowed?.(true);
            }
            return;
          }
        }
        const presence = readPresence(event);
        if (presence) {
          this.presence = presence.length > 0;
          this.config.onPresence?.(presence);
          return;
        }
        if (event.includes(TIMEOUT_TYPE)) {
          const notice = JSON.parse(event) as {
            remainingMs?: number;
            type?: string;
          };
          if (notice.type === TIMEOUT_TYPE) {
            this.pause(notice.remainingMs ?? 0);
            return;
          }
        }
        this.config.onStateless?.({ payload: event });
        return;
      }
      case MessageKind.TokenRequest:
        void this.config
          .token()
          .then((token) => {
            if (this.isAuthenticated) this.send(MessageKind.Token, text(token));
          })
          // Unanswered, the server closes the room at expiry and the client
          // reconnects with a fresh token.
          .catch(() => undefined);
        return;
    }
  }

  private send(kind: MessageKind, payload?: Uint8Array) {
    if (this.channel !== null)
      this.socket.send(
        message(this.channel, kind, payload),
        kind === MessageKind.Sync ||
          kind === MessageKind.Awareness ||
          kind === MessageKind.QueryAwareness
          ? 'charged'
          : 'free'
      );
  }

  /** The user is in a timeout for `ms`: this room sends nothing and is not
   * synced until it ends (`onResume`). */
  private pause(ms: number) {
    this.socket.timeOut(ms);
    if (this.paused) return;
    this.paused = true;
    this.setLastPiece(null);
    if (this.isSynced) {
      this.isSynced = false;
      this.config.onSynced?.({ state: false });
    }
  }

  /** Closed as the user's oldest: join again when the tab shows next, or
   * on an edit here (`documentUpdate`). */
  private park() {
    this.parked = true;
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', this.visibilityChange);
  }

  private unpark() {
    if (!this.parked) return;
    this.parked = false;
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', this.visibilityChange);
  }

  private readonly visibilityChange = () => {
    if (document.visibilityState !== 'visible') return;
    this.unpark();
    if (this.wanted && this.socket.status === 'connected') void this.join();
  };

  private setLastPiece(piece: number | null) {
    this.lastPiece = piece;
    setHeld(this, piece !== null);
  }

  private resetCounts() {
    this.setUnsynced(0);
    this.sent = 0;
    this.acknowledged = 0;
    this.setLastPiece(null);
  }

  /** An update or step 2 reply, in pieces of at most 2 MiB in order
   * (Epo 2026-10-18), each acknowledged on its own. */
  private sendUpdate(
    kind: typeof SyncKind.Step2 | typeof SyncKind.Update,
    update: Uint8Array
  ) {
    const pieces = splitUpdate(update);
    if (pieces.some((piece) => piece.byteLength > MAX_UPDATE_BYTES)) {
      this.stop();
      return;
    }
    for (const piece of pieces) {
      this.sent += 1;
      this.setUnsynced(this.unsyncedChanges + 1);
      this.send(MessageKind.Sync, syncMessage(kind, piece));
    }
    if (pieces.length > 1 || this.lastPiece !== null)
      this.setLastPiece(this.sent);
  }

  /** The room stops for an update no resend can fix; the edit stays in the
   * document (and its drafts) for a remount. */
  private stop() {
    this.stopped = true;
    this.disconnect();
    this.config.onClose?.({ code: 0, reason: UPDATE_TOO_LARGE_REASON });
  }

  private async join() {
    if (this.channel !== null || !this.wanted) return;
    if (this.config.parent && this.config.parent.channel() === null) return;
    const channel = this.socket.channel(this);
    this.channel = channel;
    await this.sendJoin(channel);
  }

  /** The channel's JOIN, with a fresh token. */
  private async sendJoin(channel: number) {
    let token: string;
    try {
      token = await this.config.token();
    } catch (error) {
      if (this.channel !== channel) return;
      this.endChannel();
      // As the Hocuspocus provider words it, so callers matching on the
      // thrown reason (a read token) keep working.
      this.config.onAuthenticationFailed?.({
        reason: `Failed to get token: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    if (this.channel !== channel) return;
    const { parent } = this.config;
    const note = parent ? parent.channel() : undefined;
    // The note ended while the token came: join again with it.
    if (note === null) {
      this.endChannel();
      return;
    }
    if (
      !this.bound &&
      this.adopted &&
      Y.getState(this.document.store, this.document.clientID) > 0
    )
      this.bound = true;
    if (!this.bound) {
      try {
        const ids = tokenClientIds(token);
        this.adopt(ids.clientId);
        this.workerClientId = ids.workerClientId;
      } catch (error) {
        this.endChannel();
        throw error;
      }
    }
    this.socket.join(
      channel,
      message(
        channel,
        MessageKind.Join,
        joinPayload(this.config.name, token, this.awareness.clientID, note)
      )
    );
  }

  /** Takes the client id a token offers, before the document is bound
   * (Q213): the document and its presence go under it. Edits made before
   * stay under the id Yjs drew; the room refuses them as they are
   * (`unassigned`, Epo 2026-10-24) and never binds that id. */
  private adopt(clientId: number) {
    const { awareness, document } = this;
    this.adopted = true;
    document.clientID = clientId;
    if (awareness.clientID !== clientId) {
      const state = awareness.getLocalState();
      removeAwarenessStates(awareness, [awareness.clientID], this);
      awareness.clientID = clientId;
      if (state !== null) awareness.setLocalState(state);
    }
  }

  private joined(writable: boolean) {
    if (writable) this.bound = true;
    this.assertBound();
    // A join after a timeout counts afresh from here, so waiters on the
    // unsynced count see it go to zero only after the resync.
    this.resetCounts();
    this.isAuthenticated = true;
    this.isConnected = true;
    this.config.onAuthenticated?.();
    this.config.onConnect?.();
    this.noteSeat?.joined();
    this.send(
      MessageKind.Sync,
      syncMessage(SyncKind.Step1, Y.encodeStateVector(this.document))
    );
    if (this.awareness.getLocalState() !== null)
      this.send(
        MessageKind.Awareness,
        encodeAwarenessUpdate(this.awareness, [this.awareness.clientID])
      );
  }

  private sync(payload: Uint8Array) {
    const { body, kind } = readSync(payload);
    if (kind === SyncKind.Step1) {
      // The server asks for everything it lacks: this reply carries this
      // client's offline or restored edits, and an unplaced update's resend.
      this.sendUpdate(
        SyncKind.Step2,
        Y.encodeStateAsUpdate(this.document, body)
      );
      return;
    }
    Y.applyUpdate(this.document, body, this);
    if (kind === SyncKind.Step2 && !this.isSynced) {
      this.isSynced = true;
      this.slowedOpen = false;
      this.config.onSynced?.({ state: true });
    }
  }

  private setUnsynced(count: number) {
    if (count === this.unsyncedChanges) return;
    this.unsyncedChanges = count;
    this.config.onUnsyncedChanges?.({ number: count });
  }

  /** The channel ended (left, refused, closed, socket gone); a note's
   * embeds end with it. */
  private endChannel() {
    if (this.channel !== null) this.socket.release(this.channel);
    const wasJoined = this.isAuthenticated;
    this.channel = null;
    const wasSynced = this.isSynced;
    this.isAuthenticated = false;
    this.isConnected = false;
    this.isSynced = false;
    this.paused = false;
    this.resetCounts();
    // Remote cursors go with the room.
    const remote = [...this.awareness.getStates().keys()].filter(
      (client) => client !== this.awareness.clientID
    );
    if (remote.length) removeAwarenessStates(this.awareness, remote, this);
    if (this.presence) {
      this.presence = false;
      this.config.onPresence?.([]);
    }
    if (wasJoined) this.noteSeat?.ended();
    if (wasSynced) this.config.onSynced?.({ state: false });
    // A parked room's slowed line goes with its channel (r6 N-4).
    if (this.slowedOpen) {
      this.slowedOpen = false;
      this.config.onSlowed?.(false);
    }
  }

  private readonly documentUpdate = (
    update: Uint8Array,
    origin: unknown,
    _doc: Y.Doc,
    transaction: Y.Transaction
  ) => {
    if (origin === this) return;
    if (this.parked) {
      // An edit here: the user came back to this room. An update applied to
      // the document (a draft restored, another room's) is no edit.
      if (!transaction.local) return;
      this.unpark();
      if (this.wanted && this.socket.status === 'connected') void this.join();
      return;
    }
    if (!this.isAuthenticated || this.paused) return;
    this.assertBound();
    this.sendUpdate(SyncKind.Update, update);
  };

  /** Once bound, the document writes under the id the room bound (Q226 L3).
   * One Yjs moved to another id would have every change refused, so it stops
   * here, explicitly. */
  private assertBound() {
    if (this.bound && this.document.clientID !== this.awareness.clientID) {
      this.endChannel();
      throw new Error('The collaboration document left its assigned client id');
    }
  }

  private readonly awarenessUpdate = (
    {
      added,
      removed,
      updated,
    }: { added: number[]; removed: number[]; updated: number[] },
    origin: unknown
  ) => {
    if (!this.isAuthenticated || this.paused) return;
    // A change applied from the server is not sent back, except this
    // client's own state, which y-protocols re-asserts with a newer clock when
    // the server outdates it.
    let clients = [...added, ...updated, ...removed];
    if (origin === this) {
      const own = this.awareness.clientID;
      clients = updated.includes(own) || removed.includes(own) ? [own] : [];
    }
    if (clients.length)
      this.send(
        MessageKind.Awareness,
        encodeAwarenessUpdate(this.awareness, clients)
      );
  };
}
