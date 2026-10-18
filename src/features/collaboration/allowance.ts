/**
 * The collaboration server's update allowance per user (Epo 2026-10-18;
 * its defaults in collaboration-rs/crates/server/src/config.rs): a burst of
 * 10,000 SYNC messages or 8 MiB, then 200 messages and 2 MiB a second,
 * shared by the user's sockets and draft sends. A tab paces what it sends
 * under it (`tabAllowance`: its socket and its draft sends), so a large
 * update's pieces wait instead of closing the socket. Another tab of the
 * same user draws from the same server allowance unseen here; going over
 * closes one socket, which resyncs.
 */
const BURST = { bytes: 8 * 1024 * 1024, messages: 10_000 };
const PER_SECOND = { bytes: 2 * 1024 * 1024, messages: 200 };

export class Allowance {
  private messages = BURST.messages;
  private bytes = BURST.bytes;
  private at = performance.now();

  /**
   * Charges one message of `size` bytes and returns how many ms to wait
   * before sending it (0: now). The allowance may go below zero: a message
   * charged after it waits longer, so sends keep their order.
   */
  reserve(size: number): number {
    const now = performance.now();
    const seconds = Math.max(0, now - this.at) / 1000;
    this.at = now;
    this.messages = Math.min(
      BURST.messages,
      this.messages + seconds * PER_SECOND.messages
    );
    this.bytes = Math.min(BURST.bytes, this.bytes + seconds * PER_SECOND.bytes);
    this.messages -= 1;
    this.bytes -= size;
    return (
      Math.max(
        0,
        -this.messages / PER_SECOND.messages,
        -this.bytes / PER_SECOND.bytes
      ) * 1000
    );
  }
}

/** This tab's: its shared socket's and its draft sends'. */
export let tabAllowance = new Allowance();

/** A full allowance again (tests). */
export function resetAllowance() {
  tabAllowance = new Allowance();
}
