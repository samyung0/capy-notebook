import { decodeFrame, type Message } from './protocol';

/** One room on the socket (a RoomProvider). */
export interface ChannelHandler {
  onMessage(message: Message): void;
  /** The socket closed: every channel on it ended. */
  onSocketClose(): void;
  /** The socket opened (again): a room that wants to be joined joins. */
  onSocketOpen(): void;
}

export type SocketStatus = 'connecting' | 'connected' | 'disconnected';

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;
/** A socket with no room left closes after this long (a quick remount reuses it). */
const IDLE_CLOSE_MS = 5000;

/**
 * The tab's socket to one collaboration URL, shared by every room open in
 * the tab (capy-sync 1 multiplexes them by channel). It connects while a room
 * wants it and reconnects with backoff after a drop.
 */
export class CollabSocket {
  private static readonly sockets = new Map<string, CollabSocket>();

  /** A socket of its own (a load generator's peer), not the tab's shared one. */
  static create(url: string): CollabSocket {
    return new CollabSocket(url);
  }

  static for(url: string): CollabSocket {
    let socket = CollabSocket.sockets.get(url);
    if (!socket) {
      socket = new CollabSocket(url);
      CollabSocket.sockets.set(url, socket);
    }
    return socket;
  }

  status: SocketStatus = 'disconnected';
  private ws: WebSocket | null = null;
  private readonly handlers = new Set<ChannelHandler>();
  private readonly channels = new Map<number, ChannelHandler>();
  private nextChannel = 1;
  private attempts = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;

  readonly url: string;

  private constructor(url: string) {
    this.url = url;
    // Back online: reconnect now instead of waiting out the backoff.
    if (typeof window !== 'undefined')
      window.addEventListener('online', () => {
        if (this.status !== 'disconnected' || this.handlers.size === 0) return;
        clearTimeout(this.retry);
        this.retry = undefined;
        this.attempts = 0;
        this.open();
      });
  }

  /** A room wants the socket: it connects if it is not already. */
  attach(handler: ChannelHandler) {
    this.handlers.add(handler);
    clearTimeout(this.idle);
    this.idle = undefined;
    if (this.status === 'disconnected' && !this.retry) this.open();
  }

  /** The room no longer wants it; the last one out closes it after a while. */
  detach(handler: ChannelHandler) {
    this.handlers.delete(handler);
    for (const [channel, owner] of this.channels)
      if (owner === handler) this.channels.delete(channel);
    if (this.handlers.size > 0) return;
    clearTimeout(this.retry);
    this.retry = undefined;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.idle = undefined;
      if (this.handlers.size === 0) this.close();
    }, IDLE_CLOSE_MS);
  }

  /** A fresh channel number for a join of `handler`. */
  channel(handler: ChannelHandler): number {
    const channel = this.nextChannel++;
    this.channels.set(channel, handler);
    return channel;
  }

  release(channel: number) {
    this.channels.delete(channel);
  }

  send(bytes: Uint8Array<ArrayBuffer>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(bytes);
  }

  private open() {
    this.status = 'connecting';
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.status = 'connected';
      this.attempts = 0;
      for (const handler of [...this.handlers]) handler.onSocketOpen();
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws || !(event.data instanceof ArrayBuffer)) return;
      let messages: Message[];
      try {
        messages = decodeFrame(new Uint8Array(event.data));
      } catch (error) {
        console.warn('Malformed collaboration frame:', error);
        ws.close();
        return;
      }
      for (const message of messages)
        this.channels.get(message.channel)?.onMessage(message);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.status = 'disconnected';
      this.channels.clear();
      for (const handler of [...this.handlers]) handler.onSocketClose();
      if (this.handlers.size > 0) this.scheduleRetry();
    };
  }

  private scheduleRetry() {
    // Jittered, so a server's clients do not all return at the same instant.
    const delay =
      Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** this.attempts++) *
      (0.5 + Math.random());
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (this.handlers.size > 0 && this.status === 'disconnected') this.open();
    }, delay);
  }

  private close() {
    const ws = this.ws;
    this.ws = null;
    this.status = 'disconnected';
    this.channels.clear();
    ws?.close();
  }
}
