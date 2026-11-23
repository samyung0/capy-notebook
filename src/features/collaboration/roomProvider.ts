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
  pieceMessage,
  Reader,
  readClosed,
  readSync,
  readText,
  SyncKind,
  syncMessage,
  text,
  tokenClientIds,
  Writer,
} from './protocol';
import { adoptClientId } from './renameClient';
import { type ChannelHandler, CollabSocket } from './socket';

export interface RoomProviderConfig {
  /** Shared with the editor (Plate passes its own). */
  awareness?: Awareness | null;
  /** What a JOIN waits for first, when anything (Q327): the draft send of
   * stored steps the room never accepted, which must reach it before the
   * document syncs. Meanwhile no socket opens for the room (Q360). Undefined
   * joins at once. */
  beforeJoin?: () => Promise<void> | undefined;
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
  /** A room update as it arrived, before the document applies it. Yjs's own
   * update event reports it after collecting what landed in deleted content,
   * which an Office editor's Undo may bring back (Q549). */
  onFrame?: (update: Uint8Array) => void;
  /** The room dropped a group of this channel's as late (an uplink too slow
   * for a piece within the server's slack): its edits are held, unsynced,
   * until `retry` joins again now (the save strip's Retry, Epo 2026-11-23),
   * or a reconnect or reload does; null once a join carries them. Nothing
   * retries on a timer. */
  onHeld?: (held: HeldEdits | null) => void;
  /** The room's other editors (`presence.ts`); none once the channel ends. */
  onPresence?: (connections: PresenceConnection[]) => void;
  /** The room's answer waits on the user's open budget (many large opens
   * lately): joined and still loading, not offline (true); or that wait
   * ended with its channel, closed or parked unsynced (false). */
  onSlowed?: (slowed: boolean) => void;
  onStateless?: (event: { payload: string }) => void;
  /** A join's step 1 (the server's state vector), before this client
   * replies and before the room's step 2: what the client holds past it, the
   * room has never seen (hidden typing, Q237). Not a step 1 once synced. */
  onStep1?: (stateVector: Uint8Array) => void;
  onSynced?: (event: { state: boolean }) => void;
  onUnsyncedChanges?: (event: { number: number }) => void;
  /** An embedded quiz's or set's room: it joins inside its note's channel
   * (Epo 2026-10-20), only while the note is joined. */
  parent?: NoteSeat;
  /** Its tab may sleep once hidden 5 minutes while nothing is unsent (notes
   * and items, Epo 2026-11-04; not an Office or text room). */
  sleepsHidden?: boolean;
  /** The socket to join on; the tab's shared one for the URL by default. */
  socket?: CollabSocket;
  /** A device copy seeded the document, at this stored version: the JOIN
   * names it and the room answers what lies past its state. Unlike
   * `unsentFrom` it marks nothing as unsent. */
  storedFrom?: number;
  /** A room token. `previous`, the last one this provider used (even
   * expired), asks for its client ids again (Q236): a reconnect keeps them. */
  token: (previous?: string) => Promise<string>;
  /** Whether the tab holds unsent edits for the document beyond the
   * unacknowledged updates (stored drafts not yet covered by a receipt): a
   * Leave says so, and only a clean one expires the session's ids (Q236). */
  unsent?: () => boolean;
  /** The stored version the stored drafts the document took before its
   * first JOIN were made at (their oldest's): the version it holds, and an
   * unsent edit until the room acknowledges the step 2 carrying them. */
  unsentFrom?: number;
  url: string;
}

/** The server's notice that the user is in a timeout (`TIMEOUT_TYPE`,
 * collaboration-rs/crates/server/src/socket.rs). */
const TIMEOUT_TYPE = 'update-timeout';
/** The server's notice that the room's answer waits on the user's open
 * budget (`OPEN_SLOWED_TYPE`, collaboration-rs/crates/server/src/room.rs). */
const OPEN_SLOWED_TYPE = 'open-slowed';
/** The server's notice that it dropped this channel's unfinished group of
 * pieces as late (`GROUP_DROPPED_TYPE`, same file), before acknowledging
 * its pieces. */
const GROUP_DROPPED_TYPE = 'group-dropped';
/** The server's notice that this channel's group of pieces found another
 * group of the user's unfinished (`GROUP_BUSY_TYPE`, same file): one at a
 * time, Epo 2026-11-23. */
const GROUP_BUSY_TYPE = 'group-busy';
/** How long a busy group waits before the channel joins again to resend it
 * (Epo 2026-11-23). */
export const GROUP_BUSY_RETRY_MS = 10_000;
/** Why the server closed a channel as its user's oldest when they joined
 * one past their cap (`OLDEST_CLOSED_REASON`, same file). */
export const OLDEST_CLOSED_REASON = 'collaboration-oldest-closed';
/** Why the server closed an embed's channel: its note joined one past its
 * cap of embed channels (`EMBED_CLOSED_REASON`, same file). */
export const EMBED_CLOSED_REASON = 'collaboration-embed-closed';
/** Why the server refused a JOIN's client id: a live channel of another
 * session holds it (`REFUSED_REASON`,
 * collaboration-rs/crates/server/src/client_ids.rs); a reconnect of this
 * session takes over its own channel (Q472). */
const CLIENT_ID_REFUSED_REASON = 'collaboration-client-id';
/** Why the server closed or refused an embed's channel: its note's channel
 * is not joined (`NOTE_CLOSED_REASON`, same file). */
const NOTE_CLOSED_REASON = 'collaboration-note-closed';
/** Why a room stopped: an update holds a piece over the server's cap, which
 * no resend can fix. */
export const UPDATE_TOO_LARGE_REASON = 'collaboration-update-too-large';
/** A note room's word that this synced document holds a stored version
 * (`STORED_TYPE`, collaboration-rs/crates/server/src/room.rs), answered
 * with `ACK_TYPE` and the version this tab reports. */
const STORED_TYPE = 'stored';
const ACK_TYPE = 'ack';
/** A step 2 with no structs and no deletions: it carries no edit. */
const EMPTY_UPDATE = Y.encodeStateAsUpdate(new Y.Doc());

function isEmptyUpdate(update: Uint8Array) {
  return (
    update.byteLength === EMPTY_UPDATE.byteLength &&
    update.every((byte, at) => byte === EMPTY_UPDATE[at])
  );
}

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
/** A late drop's held edits (`onHeld`): `retry` joins again now, and does
 * nothing more while that join is pending (`retrying`, round 4, finding 4). */
export interface HeldEdits {
  retry: () => void;
  retrying: boolean;
}

/** The `unsynced` strip's actions: the provider's Retry, and its owner's
 * Discard, which drops the held edits from the device and continues from the
 * last saved version (Epo 2026-11-23). */
export interface HeldStrip extends HeldEdits {
  discard: () => void;
}

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
  /** The room dropped a group of this channel's, late or busy: nothing more
   * is sent, and the edits count as unsynced, until the next join's step 2
   * carries them (review of 43fae032a round 2, finding 5: a resend at once
   * would be late again, with no end). */
  private resendHeld = false;
  /** The drop was a late one: the save strip shows (`onHeld`). */
  private heldLate = false;
  /** A retry's join is pending: another retry does nothing until it is
   * answered or the channel ends (round 4, finding 4). */
  private retrying = false;
  /** A group's pieces after its first, which go once the room holds the
   * first (its acknowledgement reaching `held`, a `sent` count), so a busy
   * answer costs one piece, not the burst (round 4, finding 5). */
  private rest: {
    held: number;
    kind: typeof SyncKind.Step2 | typeof SyncKind.Update;
    pieces: Uint8Array[];
  } | null = null;
  /** Stateless messages sent while a group's rest waits (a checkpoint
   * request): they go after it, as they were sent after the group. */
  private afterRest: string[] = [];
  /** A busy group's resend: the channel joins again when it fires. */
  private busyTimer: ReturnType<typeof setTimeout> | undefined;
  /** Updates waiting for the socket's group turn (one group of pieces at a
   * time per socket, round 3, finding 4), with every later one, so none
   * overtakes them: merged and sent when the turn comes. */
  private turnWait: {
    kind: typeof SyncKind.Step2 | typeof SyncKind.Update;
    updates: Uint8Array[];
  } | null = null;
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
  /** The draft send a connect waits on before it attaches (`beforeJoin`). */
  private waiting: Promise<void> | null = null;
  private destroyed = false;
  /** A note's room: the seat its embeds join inside. */
  private noteSeat: NoteSeat | null = null;
  /** The document took a token's client id. */
  private adopted = false;
  /** The last token this provider used: the next token request presents it
   * so the room keeps the session's ids (Q236). */
  private previousToken: string | undefined;
  /** This editing session's random id (Q472), sent with every JOIN so a
   * reconnect takes over the session's own channel that a dropped socket
   * left on the server. Only ever in memory: never in drafts, storage or
   * tokens. */
  private readonly sessionId = crypto.getRandomValues(new Uint8Array(16));
  /** A DOCX session's second id, for its editor's resident layout worker
   * (Q219): taken with the document's and kept with it. */
  workerClientId: number | undefined;
  /** The latest stored version the document holds: a note room's `stored`
   * notices, or the stored drafts it started with. */
  private storedVersion: number;
  /** The version the oldest edit no message carried yet was made at. */
  private unsentAt: number | null;
  /** Updates and step 2 replies sent and not acknowledged: each send's last
   * piece (its `sent` count) and the version its oldest edit was made at. */
  private inFlight: { at: number; upTo: number }[] = [];
  /** Sends the room acknowledged (admitted) and no store holds for sure
   * yet: each stays unsent until the second store's `stored` after its ACK
   * (review r1 H1, Editor 2026-10-26), counted by the versions it heard. */
  private admitted: { at: number; heard: number; stores: number }[] = [];
  /** The version this channel last reported (its JOIN's, then each
   * `ack`): an `ack` goes when the version it may report changes. */
  private lastReported: number | null = null;
  /** This channel heard its answer's `stored`, which is no store's. */
  private answered = false;

  constructor(config: RoomProviderConfig) {
    this.config = config;
    this.storedVersion = config.storedFrom ?? config.unsentFrom ?? 0;
    this.unsentAt = config.unsentFrom ?? null;
    this.document = config.document;
    this.awareness = config.awareness ?? new Awareness(config.document);
    this.socket = config.socket ?? CollabSocket.for(config.url);
    this.document.on('update', this.documentUpdate);
    this.awareness.on('update', this.awarenessUpdate);
  }

  get hasUnsyncedChanges() {
    return this.unsyncedChanges > 0;
  }

  /**
   * The stored version this tab reports (its JOIN, its acknowledgements,
   * its stored drafts): the latest it holds, never above the version its
   * oldest unsent edit was made at, in flight, held for a resend or not
   * sent yet (in-place collection, Epo 2026-10-23). 0: a new document that
   * holds nothing.
   */
  get reportedVersion() {
    let version = this.storedVersion;
    if (this.unsentAt !== null) version = Math.min(version, this.unsentAt);
    for (const { at } of this.inFlight) version = Math.min(version, at);
    for (const { at } of this.admitted) version = Math.min(version, at);
    // A document holding unsent edits holds something: never new (0), even
    // before its first `stored` (review r1 L8).
    const holding =
      this.unsentAt !== null ||
      this.inFlight.length > 0 ||
      this.admitted.length > 0;
    return holding ? Math.max(version, 1) : version;
  }

  /** Stored drafts made at `version` go into the document now (a draft
   * send's held steps, a late merge): an unsent edit made then. Call it
   * before applying them: the next update sent carries the mark, which then
   * clears as that update's own (review r1 M2). */
  unsentFrom(version: number) {
    this.unsentAt = Math.min(this.unsentAt ?? version, version);
    this.report();
  }

  /** Acknowledges the version this synced channel may report whenever it
   * changed (review r1 H2): a store's notice, an edit taken as stored. */
  private report() {
    if (!this.isSynced) return;
    const version = this.reportedVersion;
    if (version === this.lastReported) return;
    this.lastReported = version;
    const ack = { type: ACK_TYPE, version };
    this.send(MessageKind.Stateless, text(JSON.stringify(ack)));
  }

  /** An edit, or applied drafts, no message carries yet. */
  private heldBack() {
    this.unsentAt = Math.min(
      this.unsentAt ?? this.storedVersion,
      this.storedVersion
    );
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
    const before = this.config.beforeJoin?.();
    if (!before) {
      this.attach();
      return;
    }
    // The room's socket waits for the draft send too: one that sent no JOIN
    // would close at the server's join deadline and open again (Q360).
    this.waiting = before;
    void before.then(() => {
      if (this.waiting !== before) return;
      this.waiting = null;
      if (this.wanted && !this.destroyed) this.attach();
    });
  }

  private attach() {
    this.socket.attach(this);
    if (this.socket.status === 'connected') void this.join();
  }

  disconnect() {
    if (!this.wanted) return;
    this.wanted = false;
    this.waiting = null;
    this.config.parent?.delete(this);
    this.unpark();
    const joined = this.channel !== null;
    // 0: the tab holds no unsent edits for the document, so the room may
    // expire the session's ids (Q236) and end its session, which the Leave
    // names. Drafts marked to apply (`unsentFrom`) are unsent edits (review
    // r1 N3: a draft send's hold keeps its session).
    const unsent =
      this.unsyncedChanges > 0 ||
      this.unsentAt !== null ||
      this.config.unsent?.() === true;
    if (joined)
      this.send(
        MessageKind.Leave,
        new Writer()
          .byte(unsent ? 1 : 0)
          .varUint(this.awareness.clientID)
          .done()
      );
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
    if (!this.isAuthenticated || this.paused) return;
    if (this.rest) this.afterRest.push(payload);
    else this.send(MessageKind.Stateless, text(payload));
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

  mayHide() {
    return (
      this.config.sleepsHidden === true &&
      this.unsyncedChanges === 0 &&
      this.unsentAt === null &&
      this.config.unsent?.() !== true
    );
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
        this.joined();
        return;
      case MessageKind.Refused: {
        const reason = readText(payload);
        // Another session holds the ids (Q475): the next JOIN asks for a
        // fresh token, whose id a document that never wrote takes (one that
        // wrote names its own and hears unassigned).
        if (reason === CLIENT_ID_REFUSED_REASON) this.previousToken = undefined;
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
        // Admitted: unsent until a store certainly holds it (H1).
        for (const { at, upTo } of this.inFlight)
          if (upTo <= this.acknowledged)
            this.admitted.push({ at, heard: this.storedVersion, stores: 0 });
        this.inFlight = this.inFlight.filter(
          ({ upTo }) => upTo > this.acknowledged
        );
        this.setUnsynced(
          Math.max(this.resendHeld ? 1 : 0, this.unsyncedChanges - count)
        );
        if (this.rest && this.acknowledged >= this.rest.held) this.sendRest();
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
        if (event.includes(STORED_TYPE)) {
          const notice = JSON.parse(event) as {
            type?: string;
            version?: unknown;
          };
          if (notice.type === STORED_TYPE) {
            if (this.isSynced && typeof notice.version === 'number')
              this.stored(notice.version);
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
        if (event.includes(GROUP_DROPPED_TYPE)) {
          const notice = JSON.parse(event) as { type?: string };
          if (notice.type === GROUP_DROPPED_TYPE) {
            this.groupDropped(true);
            return;
          }
        }
        if (event.includes(GROUP_BUSY_TYPE)) {
          const notice = JSON.parse(event) as { type?: string };
          if (notice.type === GROUP_BUSY_TYPE) {
            this.groupBusy();
            return;
          }
        }
        this.config.onStateless?.({ payload: event });
        return;
      }
      case MessageKind.TokenRequest:
        void this.config
          .token(this.previousToken)
          .then((token) => {
            this.previousToken = token;
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
          : 'free',
        this.channel
      );
  }

  /** The user is in a timeout for `ms`: this room sends nothing and is not
   * synced until it ends (`onResume`). */
  private pause(ms: number) {
    this.socket.timeOut(ms);
    if (this.paused) return;
    this.paused = true;
    // The join after the timeout carries the group, and the held edits: a
    // Retry meanwhile would join nothing (round 5, finding 3).
    this.rest = null;
    this.afterRest = [];
    this.setLastPiece(null);
    if (this.heldLate) {
      this.heldLate = false;
      this.config.onHeld?.(null);
    }
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

  /** The last piece of the group in flight; none ends this room's group turn
   * on the socket. */
  private setLastPiece(piece: number | null) {
    this.lastPiece = piece;
    setHeld(this, piece !== null);
    if (piece === null) this.socket.endGroupTurn(this);
  }

  /** A `stored` notice: the version this document now holds. The first on
   * a channel answers its step 1; each later one is a store's, and an
   * admitted send is stored once a second store's was heard after its ACK:
   * stores run one at a time, so that one began after the send was
   * admitted (review r1 H1). */
  private stored(version: number) {
    this.storedVersion = Math.max(this.storedVersion, version);
    if (this.answered) {
      for (const send of this.admitted) {
        if (version > send.heard) {
          send.heard = version;
          send.stores += 1;
        }
      }
    } else {
      this.answered = true;
    }
    this.admitted = this.admitted.filter(({ stores }) => stores < 2);
    this.report();
  }

  private resetCounts() {
    // Sends no store certainly holds may not reach one: the next step 2
    // carries them.
    for (const { at } of [...this.inFlight, ...this.admitted])
      this.unsentAt = Math.min(this.unsentAt ?? at, at);
    this.inFlight = [];
    this.admitted = [];
    this.answered = false;
    this.resendHeld = false;
    // A join's step 2 carries what waited for the group turn, or behind a
    // group's first piece.
    this.turnWait = null;
    this.rest = null;
    this.afterRest = [];
    this.setUnsynced(0);
    this.sent = 0;
    this.acknowledged = 0;
    this.setLastPiece(null);
    if (this.heldLate) {
      this.heldLate = false;
      this.config.onHeld?.(null);
    }
  }

  /** `GROUP_DROPPED_TYPE` (`late`) or `GROUP_BUSY_TYPE`: what was in flight
   * is unsent again (the acknowledgement that follows admits none of it),
   * and stays so until the next join (`resendHeld`). One unsynced change
   * stands for it, so no receipt is asked for meanwhile and the save status
   * says it is not saved. The group's pieces still waiting to go are
   * dropped (round 3, finding 2), so the tab is held for them no longer. A
   * late drop shows the save strip, whose Retry joins again (`onHeld`),
   * unless the tab is in a timeout, whose rejoin carries them (round 5,
   * finding 3). */
  private groupDropped(late: boolean) {
    this.resendHeld = true;
    for (const { at } of this.inFlight)
      this.unsentAt = Math.min(this.unsentAt ?? at, at);
    this.inFlight = [];
    this.setUnsynced(Math.max(this.unsyncedChanges, 1));
    if (this.channel !== null) this.socket.dropQueued(this.channel);
    this.rest = null;
    for (const payload of this.afterRest.splice(0))
      this.send(MessageKind.Stateless, text(payload));
    this.setLastPiece(null);
    if (late && !this.heldLate && !this.paused) {
      this.heldLate = true;
      this.config.onHeld?.({ retry: this.retryHeld, retrying: false });
    }
  }

  private readonly retryHeld = () => this.retry();

  /** `GROUP_BUSY_TYPE`: held as a group dropped as late, and the same
   * channel joins again `GROUP_BUSY_RETRY_MS` later, silently: the room's
   * step 1 is answered with everything this client holds, the group and the
   * edits made meanwhile (Epo 2026-11-23). */
  private groupBusy() {
    this.groupDropped(false);
    clearTimeout(this.busyTimer);
    this.busyTimer = setTimeout(() => {
      this.busyTimer = undefined;
      this.retry();
    }, GROUP_BUSY_RETRY_MS);
  }

  /** The same channel joins again now while a dropped group is held: its
   * step 2 carries the group and every edit since. The save strip's Retry
   * after a late drop, and a busy group's resend. A join meanwhile (a
   * reconnect, a timeout's end) sent it already. */
  retry() {
    const channel = this.channel;
    if (channel === null || this.paused || !this.resendHeld || this.retrying)
      return;
    this.retrying = true;
    if (this.heldLate)
      this.config.onHeld?.({ retry: this.retryHeld, retrying: true });
    this.isAuthenticated = false;
    this.noteSeat?.ended();
    void this.sendJoin(channel);
  }

  /** The socket's group turn came: what waited for it goes, merged. */
  onGroupTurn() {
    const wait = this.turnWait;
    this.turnWait = null;
    if (!wait) {
      this.socket.endGroupTurn(this);
      return;
    }
    this.setUnsynced(this.unsyncedChanges - 1);
    // In a timeout the rejoin after it carries them.
    if (this.paused) {
      this.heldBack();
      this.socket.endGroupTurn(this);
      return;
    }
    this.sendUpdate(wait.kind, Y.mergeUpdates(wait.updates));
  }

  /** An update or step 2 reply, in pieces of at most 2 MiB in order
   * (Epo 2026-10-18). The room admits a group's pieces as one update after
   * the last, or none of them (`pieceMessage`): it acknowledges the first
   * once it holds it, when the rest goes (`sendRest`, round 4, finding 5),
   * and the rest with the last; each counts as unsynced until then. A group
   * waits for the socket's group turn (`groupTurn`), one unsynced change
   * meanwhile, and every update after it, until its rest went, waits with
   * it. */
  private sendUpdate(
    kind: typeof SyncKind.Step2 | typeof SyncKind.Update,
    update: Uint8Array
  ) {
    if (this.turnWait) {
      this.turnWait.updates.push(update);
      if (kind === SyncKind.Step2) this.turnWait.kind = kind;
      return;
    }
    // Behind a group whose first piece the room has not held yet: none goes
    // between its pieces.
    if (this.rest) {
      this.turnWait = { kind, updates: [update] };
      this.heldBack();
      this.setUnsynced(this.unsyncedChanges + 1);
      return;
    }
    const pieces = splitUpdate(update);
    if (pieces.some((piece) => piece.byteLength > MAX_UPDATE_BYTES)) {
      this.stop();
      return;
    }
    if (pieces.length > 1 && !this.socket.groupTurn(this)) {
      this.turnWait = { kind, updates: [update] };
      this.heldBack();
      this.setUnsynced(this.unsyncedChanges + 1);
      return;
    }
    // An update is an edit made now, and takes any mark `unsentFrom` left
    // (M2); a step 2 carries everything the room lacks, every unsent edit
    // included. An empty step 2 (a new document's) carries no edit (H2),
    // but takes a mark: the room holds what it marks, stored once a second
    // store's notice came after this step 2's ACK (H1, review r2 N1).
    const empty = kind === SyncKind.Step2 && isEmptyUpdate(update);
    const carries = !empty || this.unsentAt !== null;
    let at =
      kind === SyncKind.Step2 ? this.reportedVersion : this.storedVersion;
    at = Math.min(at, this.unsentAt ?? at);
    this.unsentAt = null;
    // A group's first piece goes alone; the rest once the room holds it.
    this.send(
      MessageKind.Sync,
      pieces.length > 1
        ? pieceMessage(kind, 0, pieces.length, pieces[0])
        : syncMessage(kind, pieces[0])
    );
    this.sent += pieces.length;
    this.setUnsynced(this.unsyncedChanges + pieces.length);
    if (pieces.length > 1)
      this.rest = {
        held: this.sent - pieces.length + 1,
        kind,
        pieces: pieces.slice(1),
      };
    if (carries) this.inFlight.push({ at, upTo: this.sent });
    if (pieces.length > 1 || this.lastPiece !== null)
      this.setLastPiece(this.sent);
    // A turn that came for what merged into one message is not needed.
    else this.socket.endGroupTurn(this);
  }

  /** The room holds the group's first piece: the rest goes, then the updates
   * and stateless messages that waited behind the group. */
  private sendRest() {
    const rest = this.rest;
    if (!rest) return;
    this.rest = null;
    const count = rest.pieces.length + 1;
    for (const [index, piece] of rest.pieces.entries())
      this.send(
        MessageKind.Sync,
        pieceMessage(rest.kind, index + 1, count, piece)
      );
    const wait = this.turnWait;
    if (wait) {
      this.turnWait = null;
      this.setUnsynced(this.unsyncedChanges - 1);
      this.sendUpdate(wait.kind, Y.mergeUpdates(wait.updates));
    }
    // What waited goes too, unless it was a group whose rest waits again.
    if (!this.rest)
      for (const payload of this.afterRest.splice(0))
        this.send(MessageKind.Stateless, text(payload));
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
    const before = this.config.beforeJoin?.();
    if (before) {
      await before;
      if (this.channel !== channel) return;
    }
    let token: string;
    try {
      token = await this.config.token(this.previousToken);
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
    this.previousToken = token;
    // The document keeps its ids once it wrote under them (Q236); before,
    // it takes the token's, which a reconnect's token offers again.
    if (!this.wrote()) {
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
        joinPayload(
          this.config.name,
          token,
          this.awareness.clientID,
          this.joinVersion(),
          this.sessionId,
          note
        )
      )
    );
  }

  /** The version a JOIN names, which its session counts at until an ack. */
  private joinVersion() {
    this.lastReported = this.reportedVersion;
    return this.lastReported;
  }

  /** Takes the client id a token offers, before the document is bound
   * (Q213): the document and its presence go under it. Edits made before
   * stay under the id Yjs drew; the room refuses them as they are
   * (`unassigned`, Epo 2026-10-24) and never binds that id. */
  private adopt(clientId: number) {
    const { awareness, document } = this;
    this.adopted = true;
    // An open label editor's own Undo follows (renameClient.ts).
    adoptClientId(document, clientId);
    if (awareness.clientID !== clientId) {
      const state = awareness.getLocalState();
      removeAwarenessStates(awareness, [awareness.clientID], this);
      awareness.clientID = clientId;
      if (state !== null) awareness.setLocalState(state);
    }
  }

  private joined() {
    this.assertBound();
    this.retrying = false;
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
      // A join's step 1 only (Q409): the room's step 1 to an update it could
      // not place, mid-session, would arm the hidden-typing watch with no
      // sync to end it.
      if (!this.isSynced) this.config.onStep1?.(body);
      // A group dropped as late goes again only after the next join.
      if (this.resendHeld) {
        this.heldBack();
        return;
      }
      // The server asks for everything it lacks: this reply carries this
      // client's offline or restored edits, and an unplaced update's resend.
      this.sendUpdate(
        SyncKind.Step2,
        Y.encodeStateAsUpdate(this.document, body)
      );
      return;
    }
    this.config.onFrame?.(body);
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
    this.retrying = false;
    clearTimeout(this.busyTimer);
    this.busyTimer = undefined;
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
      this.heldBack();
      // An edit here: the user came back to this room. An update applied to
      // the document (a draft restored, another room's) is no edit.
      if (!transaction.local) return;
      this.unpark();
      if (this.wanted && this.socket.status === 'connected') void this.join();
      return;
    }
    if (!this.isAuthenticated || this.paused || this.resendHeld) {
      this.heldBack();
      return;
    }
    this.assertBound();
    this.sendUpdate(SyncKind.Update, update);
  };

  /** Whether the document (or its DOCX layout worker) wrote under the ids
   * it took from a token. */
  private wrote() {
    const { store } = this.document;
    return (
      this.adopted &&
      (Y.getState(store, this.awareness.clientID) > 0 ||
        (this.workerClientId !== undefined &&
          Y.getState(store, this.workerClientId) > 0))
    );
  }

  /** The document writes under the id it took (Q226 L3). One Yjs moved to
   * another id would have every change refused, so it stops here,
   * explicitly. */
  private assertBound() {
    if (this.adopted && this.document.clientID !== this.awareness.clientID) {
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
