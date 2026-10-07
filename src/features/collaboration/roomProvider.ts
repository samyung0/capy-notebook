import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
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
  onStateless?: (event: { payload: string }) => void;
  onSynced?: (event: { state: boolean }) => void;
  onUnsyncedChanges?: (event: { number: number }) => void;
  /** The socket to join on; the tab's shared one for the URL by default. */
  socket?: CollabSocket;
  token: () => Promise<string>;
  url: string;
}

/**
 * One room over the tab's shared collaboration socket (capy-sync 1): join
 * with a token, y-sync, awareness, stateless messages, ACK-counted unsynced
 * changes, in-band token refresh. The server never echoes this client's own
 * updates or awareness.
 */
export class RoomProvider implements ChannelHandler {
  readonly awareness: Awareness;
  readonly document: Y.Doc;
  isAuthenticated = false;
  isConnected = false;
  isSynced = false;
  /** Updates and step 2 replies sent that the server has not acknowledged. */
  unsyncedChanges = 0;
  private readonly config: RoomProviderConfig;
  private readonly socket: CollabSocket;
  private channel: number | null = null;
  private wanted = false;
  private destroyed = false;

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

  connect() {
    if (this.destroyed || this.wanted) return;
    this.wanted = true;
    this.socket.attach(this);
    if (this.socket.status === 'connected') void this.join();
  }

  disconnect() {
    if (!this.wanted) return;
    this.wanted = false;
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
    if (this.isAuthenticated) this.send(MessageKind.Stateless, text(payload));
  }

  onSocketOpen() {
    if (this.wanted) void this.join();
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
        this.config.onAuthenticationFailed?.({ reason });
        return;
      }
      case MessageKind.Closed: {
        const event = readClosed(payload);
        this.endChannel();
        this.config.onClose?.(event);
        return;
      }
      case MessageKind.Sync:
        this.sync(payload);
        return;
      case MessageKind.Ack: {
        const count = new Reader(payload).varUint();
        this.setUnsynced(Math.max(0, this.unsyncedChanges - count));
        return;
      }
      case MessageKind.Awareness:
        applyAwarenessUpdate(this.awareness, payload, this);
        return;
      case MessageKind.Stateless:
        this.config.onStateless?.({ payload: readText(payload) });
        return;
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
      this.socket.send(message(this.channel, kind, payload));
  }

  private async join() {
    if (this.channel !== null || !this.wanted) return;
    const channel = this.socket.channel(this);
    this.channel = channel;
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
    this.socket.send(
      message(channel, MessageKind.Join, joinPayload(this.config.name, token))
    );
  }

  private joined(_writable: boolean) {
    this.isAuthenticated = true;
    this.isConnected = true;
    this.config.onAuthenticated?.();
    this.config.onConnect?.();
    this.send(
      MessageKind.Sync,
      syncMessage(SyncKind.Step1, Y.encodeStateVector(this.document))
    );
    if (this.awareness.getLocalState() !== null)
      this.send(
        MessageKind.Awareness,
        encodeAwarenessUpdate(this.awareness, [this.document.clientID])
      );
  }

  private sync(payload: Uint8Array) {
    const { body, kind } = readSync(payload);
    if (kind === SyncKind.Step1) {
      // The server asks for everything it lacks: this reply carries this
      // client's offline or restored edits, and an unplaced update's resend.
      this.setUnsynced(this.unsyncedChanges + 1);
      this.send(
        MessageKind.Sync,
        syncMessage(SyncKind.Step2, Y.encodeStateAsUpdate(this.document, body))
      );
      return;
    }
    Y.applyUpdate(this.document, body, this);
    if (kind === SyncKind.Step2 && !this.isSynced) {
      this.isSynced = true;
      this.config.onSynced?.({ state: true });
    }
  }

  private setUnsynced(count: number) {
    if (count === this.unsyncedChanges) return;
    this.unsyncedChanges = count;
    this.config.onUnsyncedChanges?.({ number: count });
  }

  /** The channel ended (left, refused, closed, socket gone). */
  private endChannel() {
    if (this.channel !== null) this.socket.release(this.channel);
    this.channel = null;
    const wasSynced = this.isSynced;
    this.isAuthenticated = false;
    this.isConnected = false;
    this.isSynced = false;
    this.setUnsynced(0);
    // Remote cursors go with the room.
    const remote = [...this.awareness.getStates().keys()].filter(
      (client) => client !== this.document.clientID
    );
    if (remote.length) removeAwarenessStates(this.awareness, remote, this);
    if (wasSynced) this.config.onSynced?.({ state: false });
  }

  private readonly documentUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this || !this.isAuthenticated) return;
    this.setUnsynced(this.unsyncedChanges + 1);
    this.send(MessageKind.Sync, syncMessage(SyncKind.Update, update));
  };

  private readonly awarenessUpdate = (
    {
      added,
      removed,
      updated,
    }: { added: number[]; removed: number[]; updated: number[] },
    origin: unknown
  ) => {
    if (!this.isAuthenticated) return;
    // A change applied from the server is not sent back, except this
    // client's own state, which y-protocols re-asserts with a newer clock when
    // the server outdates it.
    let clients = [...added, ...updated, ...removed];
    if (origin === this) {
      const own = this.document.clientID;
      clients = updated.includes(own) || removed.includes(own) ? [own] : [];
    }
    if (clients.length)
      this.send(
        MessageKind.Awareness,
        encodeAwarenessUpdate(this.awareness, clients)
      );
  };
}
