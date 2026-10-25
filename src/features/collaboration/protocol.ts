/**
 * capy-sync 1, the collaboration server's wire protocol
 * (collaboration-rs/crates/server/src/protocol.rs): `varuint channel`,
 * `u8 type`, `varuint length`, `payload`, several messages per WebSocket
 * frame. SYNC and AWARENESS carry y-sync v1 and y-protocols awareness
 * messages unchanged.
 */

export const MessageKind = {
  Ack: 6,
  Awareness: 7,
  Closed: 4,
  Join: 0,
  Joined: 1,
  Leave: 3,
  QueryAwareness: 8,
  Refused: 2,
  Stateless: 9,
  Sync: 5,
  Token: 11,
  TokenRequest: 10,
} as const;
export type MessageKind = (typeof MessageKind)[keyof typeof MessageKind];

/** y-sync v1 message types inside SYNC. */
export const SyncKind = { Step1: 0, Step2: 1, Update: 2 } as const;

export interface Message {
  channel: number;
  kind: number;
  payload: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A growable byte buffer with lib0 varuint and varstring writers. */
export class Writer {
  private bytes: Uint8Array<ArrayBuffer> = new Uint8Array(64);
  private length = 0;

  private reserve(extra: number) {
    if (this.length + extra <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
  }

  varUint(value: number) {
    this.reserve(10);
    let rest = value;
    while (rest > 0x7f) {
      this.bytes[this.length++] = (rest % 0x80) | 0x80;
      rest = Math.floor(rest / 0x80);
    }
    this.bytes[this.length++] = rest;
    return this;
  }

  byte(value: number) {
    this.reserve(1);
    this.bytes[this.length++] = value;
    return this;
  }

  raw(value: Uint8Array) {
    this.reserve(value.length);
    this.bytes.set(value, this.length);
    this.length += value.length;
    return this;
  }

  varBytes(value: Uint8Array) {
    return this.varUint(value.length).raw(value);
  }

  varString(value: string) {
    return this.varBytes(encoder.encode(value));
  }

  done(): Uint8Array<ArrayBuffer> {
    return this.bytes.slice(0, this.length);
  }
}

/** Reads lib0 varuints and varstrings from a buffer. */
export class Reader {
  at = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get done() {
    return this.at >= this.bytes.length;
  }

  varUint(): number {
    let value = 0;
    let factor = 1;
    for (;;) {
      if (this.at >= this.bytes.length) throw new Error('truncated message');
      const byte = this.bytes[this.at++];
      value += (byte & 0x7f) * factor;
      if (byte < 0x80) return value;
      factor *= 0x80;
      if (factor > 2 ** 56) throw new Error('malformed varuint');
    }
  }

  byte(): number {
    if (this.at >= this.bytes.length) throw new Error('truncated message');
    return this.bytes[this.at++];
  }

  varBytes(): Uint8Array {
    const length = this.varUint();
    if (this.at + length > this.bytes.length)
      throw new Error('truncated message');
    const value = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return value;
  }

  varString(): string {
    return decoder.decode(this.varBytes());
  }
}

export function encodeMessage(
  writer: Writer,
  channel: number,
  kind: MessageKind,
  payload: Uint8Array
) {
  writer.varUint(channel).byte(kind).varBytes(payload);
}

export function message(
  channel: number,
  kind: MessageKind,
  payload: Uint8Array = new Uint8Array()
) {
  const writer = new Writer();
  encodeMessage(writer, channel, kind, payload);
  return writer.done();
}

export function decodeFrame(frame: Uint8Array): Message[] {
  const reader = new Reader(frame);
  const messages: Message[] = [];
  while (!reader.done) {
    const channel = reader.varUint();
    const kind = reader.byte();
    messages.push({ channel, kind, payload: reader.varBytes() });
  }
  return messages;
}

export const text = (value: string) => new Writer().varString(value).done();
export const readText = (payload: Uint8Array) =>
  new Reader(payload).varString();

export const syncMessage = (kind: number, body: Uint8Array) =>
  new Writer().varUint(kind).varBytes(body).done();

export function readSync(payload: Uint8Array) {
  const reader = new Reader(payload);
  const kind = reader.varUint();
  return { body: reader.varBytes(), kind };
}

/**
 * The client protocol this build speaks, sent on every JOIN and draft send.
 * The collaboration server refuses a client below its room family's minimum
 * or above its own number (`collaboration-outdated`); its `CLIENT_PROTOCOL`
 * in protocol.rs is the same number (a test keeps them equal). When to bump:
 * openwiki/frontend/plate-editor.md "Client protocol".
 */
export const CLIENT_PROTOCOL = 19;

/** A JOIN's payload: the room, the token, the client protocol, the Y.Doc's
 * client id (Q213); an embed's names its note's channel last (Epo
 * 2026-10-20). */
export function joinPayload(
  room: string,
  token: string,
  clientId: number,
  note?: number
) {
  const writer = new Writer()
    .varString(room)
    .varString(token)
    .varUint(CLIENT_PROTOCOL)
    .varUint(clientId);
  if (note !== undefined) writer.varUint(note);
  return writer.done();
}

const isClientId = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= 0xff_ff_ff_ff;

/** The Yjs client ids a collaboration token offers, which Go mints fresh
 * per token: the session's (`clientId`, Q213) and, on a DOCX write token,
 * its editor's resident layout worker's (`workerClientId`, Q219). A token
 * without a valid id is refused here: the server would refuse its JOIN
 * anyway. */
export function tokenClientIds(token: string): {
  clientId: number;
  workerClientId?: number;
} {
  const payload = token.split('.')[1] ?? '';
  let claims: { clientId?: unknown; workerClientId?: unknown } = {};
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    claims = JSON.parse(atob(base64)) as typeof claims;
  } catch {
    // Not a token the API minted; refused below.
  }
  const { clientId, workerClientId } = claims;
  if (
    !isClientId(clientId) ||
    !(workerClientId === undefined || isClientId(workerClientId))
  )
    throw new Error('The collaboration token offers no client id');
  return { clientId, workerClientId };
}

export const closedPayload = (code: number, reason: string) =>
  new Writer().varUint(code).varString(reason).done();

export function readClosed(payload: Uint8Array) {
  const reader = new Reader(payload);
  return { code: reader.varUint(), reason: reader.varString() };
}
