/**
 * How long a source save (Office or text) may go unconfirmed before the editor
 * says saving is delayed. A source room stores 5 s after its last change and
 * at most 30 s after its first (COLLABORATION_SOURCE_MAX_DEBOUNCE_MS), and a
 * receipt rides that store, so a healthy receipt arrives within about 30 s
 * plus the store itself; 45 s leaves 15 s for a slow Office export.
 */
export const SOURCE_SAVE_DELAY_MS = 45_000;
/**
 * The same for notes. A material room stores 2 s after its last change and at
 * most 10 s after its first (COLLABORATION_MAX_DEBOUNCE_MS); 25 s leaves 15 s
 * for the store.
 */
export const NOTE_SAVE_DELAY_MS = 25_000;

/**
 * Calls `onLate` once the oldest unanswered checkpoint request has waited
 * `limitMs` of connected time. An edit is counted from the request that
 * carries it (sent 1 s after typing stops), so a long burst of typing never
 * reads as delayed. Time spent disconnected does not count: the reconnect
 * status covers it. The clock starts disconnected.
 */
export class SaveDelayClock {
  // Request id to the connected time it was sent; oldest first.
  private readonly requests = new Map<string, number>();
  private elapsed = 0;
  private since: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly limitMs: number;
  private readonly onLate: () => void;
  private readonly now: () => number;

  constructor(limitMs: number, onLate: () => void, now = Date.now) {
    this.limitMs = limitMs;
    this.onLate = onLate;
    this.now = now;
  }

  /** A checkpoint request went out (a resend keeps its first time). */
  requested(id: string) {
    if (!this.requests.has(id)) this.requests.set(id, this.read());
    this.arm();
  }

  /** Receipts arrived: keep only the requests still unanswered. */
  retain(pending: Iterable<string>) {
    const keep = new Set(pending);
    for (const id of this.requests.keys())
      if (!keep.has(id)) this.requests.delete(id);
    this.arm();
  }

  connected() {
    this.since ??= this.now();
    this.arm();
  }

  disconnected() {
    if (this.since !== null) this.elapsed += this.now() - this.since;
    this.since = null;
    clearTimeout(this.timer);
  }

  dispose() {
    this.since = null;
    clearTimeout(this.timer);
  }

  private read() {
    return this.elapsed + (this.since === null ? 0 : this.now() - this.since);
  }

  private arm() {
    clearTimeout(this.timer);
    const oldest = this.requests.values().next();
    if (this.since === null || oldest.done) return;
    this.timer = setTimeout(
      this.onLate,
      Math.max(0, oldest.value + this.limitMs - this.read())
    );
  }
}
