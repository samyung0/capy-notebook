/**
 * The collaboration server's update allowance per user (Epo 2026-10-18;
 * its defaults in collaboration-rs/crates/server/src/config.rs): a burst of
 * 10,000 messages or 8 MiB, then 200 messages and 2 MiB a second, shared by
 * the user's sockets and draft sends; SYNC, awareness, awareness queries
 * and JOINs take from it (full-document answers draw on a separate open
 * budget the server keeps, which slows opens and never times out). A tab
 * paces what it sends under it (`tabAllowance`: its socket and its draft
 * sends), so a large update's pieces wait instead of timing the user out.
 * Another tab of the same user draws from the same server allowance unseen
 * here; going over puts the user in a timeout, after which every tab starts
 * again from a full allowance.
 */
const BURST = { bytes: 8 * 1024 * 1024, messages: 10_000 };
const PER_SECOND = { bytes: 2 * 1024 * 1024, messages: 200 };

export class Allowance {
  private messages = BURST.messages;
  private bytes = BURST.bytes;
  private at = performance.now();

  private refill() {
    const now = performance.now();
    const seconds = Math.max(0, now - this.at) / 1000;
    this.at = now;
    this.messages = Math.min(
      BURST.messages,
      this.messages + seconds * PER_SECOND.messages
    );
    this.bytes = Math.min(BURST.bytes, this.bytes + seconds * PER_SECOND.bytes);
  }

  /**
   * Charges one message of `size` bytes and returns how many ms to wait
   * before sending it (0: now). The allowance may go below zero: a message
   * charged after it waits longer, so sends keep their order.
   */
  reserve(size: number): number {
    this.refill();
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

  /** Full again: a timeout ended, and pacing starts from the defaults. */
  reset() {
    this.messages = BURST.messages;
    this.bytes = BURST.bytes;
    this.at = performance.now();
  }
}

/** This tab's: its shared socket's and its draft sends'. */
export const tabAllowance = new Allowance();

/** A full allowance again (tests). */
export function resetAllowance() {
  tabAllowance.reset();
}
