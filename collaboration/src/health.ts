import { monitorEventLoopDelay } from 'node:perf_hooks';
import { log } from './observability.js';

/** The value at quantile `p` (0-1) of `values`, or 0 for none. Sorts in place. */
export function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.ceil(p * values.length) - 1)];
}

/** A save this long or longer also logs its own `slow_save` line. */
export const SLOW_SAVE_MS = 2000;

/** One interval's store durations and failures for a kind of room. */
export class StoreTimings {
  private durations: number[] = [];
  private failures = 0;
  private readonly kind: 'material' | 'source';

  constructor(kind: 'material' | 'source') {
    this.kind = kind;
  }

  record(ms: number, ok: boolean, save: { bytes: number; room: string }) {
    this.durations.push(ms);
    if (!ok) this.failures += 1;
    if (ms >= SLOW_SAVE_MS)
      log('warn', 'slow_save', {
        ...save,
        kind: this.kind,
        ms: Math.round(ms),
        ok,
      });
  }

  /** This interval's summary; the next interval starts empty. */
  take() {
    const durations = this.durations;
    const summary = {
      count: durations.length,
      failures: this.failures,
      max_ms: Math.round(durations.length ? Math.max(...durations) : 0),
      p95_ms: Math.round(percentile(durations, 0.95)),
    };
    this.durations = [];
    this.failures = 0;
    return summary;
  }
}

// The top-level frame type of an inbound message, read without allocating:
// the varstring document name, then the type (0 sync, 1 awareness).
function frameType(message: Uint8Array) {
  let at = 0;
  let length = 0;
  for (let shift = 0; at < message.length && shift < 35; shift += 7) {
    const byte = message[at++];
    length += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
  }
  at += length;
  return at < message.length ? message[at] : -1;
}

/**
 * The per-minute `collab_health` line: event-loop delay, inbound message
 * rate, store durations per kind of room, connections and loaded rooms.
 * Counting a message is two comparisons and an increment.
 */
export function startHealthLog(
  counts: () => { connections: number; rooms: number },
  intervalMs = 60_000
) {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let updates = 0;
  let awareness = 0;
  let since = Date.now();
  const material = new StoreTimings('material');
  const source = new StoreTimings('source');
  const timer = setInterval(() => {
    const seconds = Math.max((Date.now() - since) / 1000, 1);
    const ms = (ns: number) => Math.round(ns / 1e6);
    log('info', 'collab_health', {
      ...counts(),
      awareness_per_s: Math.round((awareness / seconds) * 10) / 10,
      lag_max_ms: ms(delay.max),
      lag_p99_ms: ms(delay.percentile(99)),
      material_stores: material.take(),
      source_stores: source.take(),
      updates_per_s: Math.round((updates / seconds) * 10) / 10,
    });
    delay.reset();
    updates = 0;
    awareness = 0;
    since = Date.now();
  }, intervalMs);
  timer.unref();
  return {
    material,
    message(raw: Uint8Array) {
      const type = frameType(raw);
      if (type === 0) updates += 1;
      else if (type === 1) awareness += 1;
    },
    source,
    stop: () => clearInterval(timer),
  };
}
