/**
 * Spaced-repetition helpers — a thin wrapper around `ts-fsrs`.
 *
 * The rest of the app works with the serialized `SrsState` (ISO date strings) so
 * scheduling state round-trips through JSON / the mock API. These helpers convert
 * to and from the library's `Card` (which uses `Date`s) at the boundary.
 */
import {
  type Card,
  createEmptyCard,
  fsrs,
  type Grade,
  generatorParameters,
  Rating,
} from 'ts-fsrs';
import type { SrsState } from '@/api/types';

const scheduler = fsrs(generatorParameters({ enable_fuzz: true }));

export type SrsRating = 'again' | 'hard' | 'good' | 'easy';

export const SRS_RATINGS: SrsRating[] = ['again', 'hard', 'good', 'easy'];

const RATING_MAP: Record<SrsRating, Grade> = {
  again: Rating.Again,
  easy: Rating.Easy,
  good: Rating.Good,
  hard: Rating.Hard,
};

function toState(card: Card): SrsState {
  return {
    difficulty: card.difficulty,
    due: new Date(card.due).toISOString(),
    elapsed_days: card.elapsed_days,
    lapses: card.lapses,
    last_review: card.last_review
      ? new Date(card.last_review).toISOString()
      : undefined,
    learning_steps: (card as { learning_steps?: number }).learning_steps ?? 0,
    reps: card.reps,
    scheduled_days: card.scheduled_days,
    stability: card.stability,
    state: card.state,
  };
}

/**
 * Rebuild a full `ts-fsrs` `Card` from our serialized state. We start from a
 * fresh empty card so any fields a given library version needs are present, then
 * overlay the persisted values.
 */
function toCard(state: SrsState): Card {
  return {
    ...createEmptyCard(new Date(state.due)),
    difficulty: state.difficulty,
    due: new Date(state.due),
    elapsed_days: state.elapsed_days,
    lapses: state.lapses,
    last_review: state.last_review ? new Date(state.last_review) : undefined,
    learning_steps: state.learning_steps ?? 0,
    reps: state.reps,
    scheduled_days: state.scheduled_days,
    stability: state.stability,
    state: state.state,
  } as Card;
}

/** Fresh scheduling state for a brand-new card (due immediately). */
export function newSrsState(now: Date = new Date()): SrsState {
  return toState(createEmptyCard(now));
}

/** Apply a review rating and return the updated scheduling state. */
export function reviewSrs(
  state: SrsState,
  rating: SrsRating,
  now: Date = new Date()
): SrsState {
  const { card } = scheduler.next(toCard(state), now, RATING_MAP[rating]);
  return toState(card);
}

/** True once a card is a graduated Review-state card (used for the `known` flag). */
export function isKnown(state: SrsState): boolean {
  return state.state === 2; // State.Review
}

/** Whether a card is due for review at `now`. */
export function isDue(state: SrsState, now: Date = new Date()): boolean {
  return new Date(state.due).getTime() <= now.getTime();
}

/** Count how many cards in a list are currently due. */
export function dueCount(states: SrsState[], now: Date = new Date()): number {
  return states.reduce((n, s) => (isDue(s, now) ? n + 1 : n), 0);
}

/** Short human interval preview for each rating, e.g. { good: '3d' }. */
export function ratingPreviews(
  state: SrsState,
  now: Date = new Date()
): Record<SrsRating, string> {
  const log = scheduler.repeat(toCard(state), now);
  const fmt = (due: Date) =>
    formatInterval(new Date(due).getTime() - now.getTime());
  return {
    again: fmt(log[Rating.Again].card.due),
    easy: fmt(log[Rating.Easy].card.due),
    good: fmt(log[Rating.Good].card.due),
    hard: fmt(log[Rating.Hard].card.due),
  };
}

function formatInterval(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.round(mo / 12)}y`;
}
