import { Allowance, tabAllowance } from './allowance';
import { setHeld } from './held';
import { decodeFrame, type Message, MessageKind } from './protocol';

/** One room on the socket (a RoomProvider). */
export interface ChannelHandler {
  onMessage(message: Message): void;
  /** The socket closed: every channel on it ended. */
  onSocketClose(): void;
  /** The socket opened (again): a room that wants to be joined joins. */
  onSocketOpen(): void;
  /** The user's timeout ended: a room paused by it joins again and resyncs. */
  onResume(): void;
}

export type SocketStatus = 'connecting' | 'connected' | 'disconnected';

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;
/** A socket with no room left closes after this long (a quick remount reuses it). */
const IDLE_CLOSE_MS = 5000;
/** How long `warm` holds a socket open for the room expected on it. */
const WARM_MS = 10_000;
/** Joins the server authenticates at once per socket; it closes the socket on
 * one more (`MAX_PENDING_JOINS`, collaboration-rs/crates/server/src/socket.rs).
 * A note with many embeds on screen queues the rest here. */
const MAX_PENDING_JOINS = 8;

/**
 * The tab's socket to one collaboration URL, shared by every room open in
 * the tab (capy-sync 1 multiplexes them by channel). It connects while a room
 * wants it and reconnects with backoff after a drop.
 */
export class CollabSocket {
  private static readonly sockets = new Map<string, CollabSocket>();

  /** A socket of its own (a load generator's peer), not the tab's shared
   * one, pacing its updates under an allowance of its own. */
  static create(url: string): CollabSocket {
    return new CollabSocket(url, new Allowance());
  }

  static for(url: string): CollabSocket {
    let socket = CollabSocket.sockets.get(url);
    if (!socket) {
      socket = new CollabSocket(url);
      CollabSocket.sockets.set(url, socket);
    }
    return socket;
  }

  /** Opens the tab's socket now for a room about to join on it (its token
   * just arrived), so the join does not wait for the connection. */
  static warm(url: string) {
    const socket = CollabSocket.for(url);
    const holder: ChannelHandler = {
      onMessage() {},
      onResume() {},
      onSocketClose() {},
      onSocketOpen() {},
    };
    socket.attach(holder);
    setTimeout(() => socket.detach(holder), WARM_MS);
  }

  status: SocketStatus = 'disconnected';
  private ws: WebSocket | null = null;
  private readonly handlers = new Set<ChannelHandler>();
  private readonly channels = new Map<number, ChannelHandler>();
  /** Channels whose JOIN went out without an answer yet. */
  private readonly pending = new Set<number>();
  private queued: { bytes: Uint8Array<ArrayBuffer>; channel: number }[] = [];
  /** Frames waiting for the allowance (`reserve`), in order, each with the
   * time it may go; a frame sent behind them waits its turn. */
  private outbox: {
    at: number;
    bytes: Uint8Array<ArrayBuffer>;
    charged: boolean;
  }[] = [];
  private draining: ReturnType<typeof setTimeout> | undefined;
  /** The user's timeout: it ends at this timer (`timeOut`). */
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private timeoutEnds = 0;
  private nextChannel = 1;
  private attempts = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;

  readonly url: string;
  /** Its own allowance; the tab's (`tabAllowance`) when none. */
  private readonly allowance: Allowance | null;

  private constructor(url: string, allowance: Allowance | null = null) {
    this.url = url;
    this.allowance = allowance;
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
    this.answered(channel);
  }

  /**
   * Sends a frame now, or after the frames waiting before it. A frame the
   * server charges (`charged`: SYNC, awareness) takes its share of the
   * user's update allowance first and waits while the allowance is spent;
   * nothing overtakes it, so a checkpoint request still follows the updates
   * it covers. In a timeout a charged frame is not sent (the server would
   * drop it; the rooms resync after).
   */
  send(bytes: Uint8Array<ArrayBuffer>, charged = false) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (charged && this.timeout) return;
    const now = performance.now();
    const at = Math.max(
      now +
        (charged
          ? (this.allowance ?? tabAllowance).reserve(bytes.byteLength)
          : 0),
      this.outbox.at(-1)?.at ?? 0
    );
    if (at <= now && !this.outbox.length) {
      this.ws.send(bytes);
      return;
    }
    this.outbox.push({ at, bytes, charged });
    this.drainLater();
    this.updateHeld();
  }

  /** The server charged this user an answer of `size` bytes (a step 1's):
   * what goes next waits for it. */
  charge(size: number) {
    (this.allowance ?? tabAllowance).charge(size);
  }

  /**
   * The user is in a timeout for `ms` (the server said so on one of their
   * channels; Epo 2026-10-18): charged frames waiting are dropped, none goes
   * until it ends, then the allowance is full again and every room paused by
   * it joins again on this socket and resyncs (`onResume`).
   */
  timeOut(ms: number) {
    const ends = performance.now() + ms;
    if (this.timeout && ends <= this.timeoutEnds) return;
    this.timeoutEnds = ends;
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => {
      this.timeout = undefined;
      (this.allowance ?? tabAllowance).reset();
      this.updateHeld();
      for (const handler of [...this.handlers]) handler.onResume();
    }, ms);
    const now = performance.now();
    this.outbox = this.outbox
      .filter((frame) => !frame.charged)
      .map((frame) => ({ ...frame, at: now }));
    clearTimeout(this.draining);
    this.draining = undefined;
    this.drainLater();
    this.updateHeld();
  }

  private drainLater() {
    if (this.draining || !this.outbox.length) return;
    this.draining = setTimeout(
      () => {
        this.draining = undefined;
        const now = performance.now();
        while (this.outbox.length && this.outbox[0].at <= now) {
          const { bytes } = this.outbox.shift()!;
          if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(bytes);
        }
        this.drainLater();
        this.updateHeld();
      },
      Math.max(0, this.outbox[0].at - performance.now())
    );
  }

  /** The tab holds back while frames wait or the user is in a timeout. */
  private updateHeld() {
    setHeld(this, this.outbox.length > 0 || this.timeout !== undefined);
  }

  /** The socket ended: what waited is dropped, and a timeout is forgotten
   * (rooms resync on rejoin; the server tells them again if it runs). */
  private dropOutbox() {
    clearTimeout(this.draining);
    this.draining = undefined;
    this.outbox = [];
    clearTimeout(this.timeout);
    this.timeout = undefined;
    this.updateHeld();
  }

  /** Sends a channel's JOIN, or holds it while eight others wait for theirs. */
  join(channel: number, bytes: Uint8Array<ArrayBuffer>) {
    if (this.pending.size < MAX_PENDING_JOINS) {
      this.pending.add(channel);
      this.send(bytes);
    } else this.queued.push({ bytes, channel });
  }

  /** The channel's JOIN was answered or the channel ended: the next goes. */
  private answered(channel: number) {
    if (!this.pending.delete(channel)) {
      this.queued = this.queued.filter((join) => join.channel !== channel);
      return;
    }
    while (this.pending.size < MAX_PENDING_JOINS && this.queued.length) {
      const next = this.queued.shift() as (typeof this.queued)[number];
      this.pending.add(next.channel);
      this.send(next.bytes);
    }
  }

  private forgetJoins() {
    this.pending.clear();
    this.queued = [];
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
      for (const message of messages) {
        if (
          message.kind === MessageKind.Joined ||
          message.kind === MessageKind.Refused ||
          message.kind === MessageKind.Closed
        )
          this.answered(message.channel);
        this.channels.get(message.channel)?.onMessage(message);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.status = 'disconnected';
      this.channels.clear();
      this.forgetJoins();
      this.dropOutbox();
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
    this.forgetJoins();
    this.dropOutbox();
    ws?.close();
  }
}
