import { createContext } from 'react';
import type { RoomProvider } from './roomProvider';

/** A room that joins inside a note's channel (an embed's RoomProvider). */
export interface SeatedRoom {
  /** The note's channel ended or joins again; the server closed the room's
   * channel with it. */
  noteEnded(): void;
  /** The note's channel joined: the room joins inside it. */
  noteJoined(): void;
}

/**
 * A note's channel on the tab's socket, inside which its embedded quizzes'
 * and sets' rooms join (Epo 2026-10-20): their JOIN names it, they take no
 * place among the user's 22 joined documents, they close with it and join
 * again when it does. One per mounted note; the note's provider comes and
 * goes (`attach`).
 */
export class NoteSeat {
  private provider: RoomProvider | null = null;
  private readonly rooms = new Set<SeatedRoom>();

  /** The note's provider now, or none. */
  attach(provider: RoomProvider | null) {
    if (provider === this.provider) return;
    this.provider?.seat(null);
    this.provider = provider;
    provider?.seat(this);
    if (this.channel() === null) this.ended();
    else this.joined();
  }

  /** The note's joined channel, or null while it is not joined. */
  channel(): number | null {
    return this.provider?.seatChannel ?? null;
  }

  add(room: SeatedRoom) {
    this.rooms.add(room);
  }

  delete(room: SeatedRoom) {
    this.rooms.delete(room);
  }

  joined() {
    for (const room of [...this.rooms]) room.noteJoined();
  }

  ended() {
    for (const room of [...this.rooms]) room.noteEnded();
  }
}

/** The seat of the note an embed renders in (none: it joins on its own). */
export const NoteSeatContext = createContext<NoteSeat | null>(null);

/** Where an embed's rooms join: inside its note's seat, waking (when closed
 * as the note's oldest embed) as `wake` grows (`useNearScreen().entered`). */
export interface InNote {
  inside?: NoteSeat | null;
  wake?: number;
}
