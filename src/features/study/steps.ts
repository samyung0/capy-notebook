import { useState } from 'react';

/* One item at a time with Previous and Next, shared by the review session,
   flashcard study and Quick review. The timeline is every item shown so far,
   with what was recorded for it; Previous walks back along it. An item with a
   record (rated or checked) is read only there, so nothing is recorded twice;
   one that was only skipped can still be answered. */

export interface Step<R> {
  key: string;
  record?: R;
}

export interface Steps<R> {
  /** The timeline step shown; at timeline.length it is the queue's head. */
  cursor: number;
  queue: string[];
  timeline: Step<R>[];
}

export interface StepOptions {
  /** A second skip leaves the item behind instead of sending it to the end
   * again, so a session reaches its end. */
  skipOnce?: boolean;
}

export const startSteps = <R>(keys: string[], done: Step<R>[] = []) => ({
  cursor: done.length,
  queue: keys,
  timeline: done,
});

/** The latest record of a key anywhere on the timeline. */
export function recordOf<R>(s: Steps<R>, key: string): R | undefined {
  for (let i = s.timeline.length - 1; i >= 0; i--) {
    const step = s.timeline[i];
    if (step.key === key && step.record !== undefined) return step.record;
  }
}

/** The shown item: a past step, or the queue's head; null at the end. */
export function currentStep<R>(s: Steps<R>) {
  const past = s.timeline[s.cursor];
  if (past) {
    const record = recordOf(s, past.key);
    return { key: past.key, past: true, record };
  }
  const key = s.queue[0];
  return key === undefined ? null : { key, past: false, record: undefined };
}

export interface AnswerOptions {
  /** Sends the item back to the end to come round again (flashcard study's
   * Again). */
  requeue?: boolean;
  /** Stays on the item to show its result (a checked question); otherwise
   * the next item follows. */
  stay?: boolean;
}

/** Records the shown item if it has no record yet. A live item joins the
 * timeline; a past skipped one is answered in place and leaves the queue. */
export function answerStep<R>(
  s: Steps<R>,
  record: R,
  { requeue = false, stay = false }: AnswerOptions = {}
) {
  const shown = currentStep(s);
  if (!shown || shown.record !== undefined) return s;
  if (shown.past) {
    const timeline = s.timeline.map((step, i) =>
      i === s.cursor ? { ...step, record } : step
    );
    const at = requeue ? -1 : s.queue.indexOf(shown.key);
    const queue =
      at < 0 ? s.queue : [...s.queue.slice(0, at), ...s.queue.slice(at + 1)];
    return { cursor: stay ? s.cursor : s.cursor + 1, queue, timeline };
  }
  const [head, ...rest] = s.queue;
  const timeline = [...s.timeline, { key: head, record }];
  return {
    cursor: stay ? timeline.length - 1 : timeline.length,
    queue: requeue ? [...rest, head] : rest,
    timeline,
  };
}

/** Next: forward along the timeline, or past a live item without a record,
 * which waits at the end of the queue. */
export function nextStep<R>(s: Steps<R>, options: StepOptions = {}) {
  if (s.cursor < s.timeline.length) return { ...s, cursor: s.cursor + 1 };
  const [head, ...rest] = s.queue;
  if (head === undefined) return s;
  const skippedBefore = s.timeline.some((step) => step.key === head);
  const timeline = [...s.timeline, { key: head }];
  return {
    cursor: timeline.length,
    queue: options.skipOnce && skippedBefore ? rest : [...rest, head],
    timeline,
  };
}

export const previousStep = <R>(s: Steps<R>) =>
  s.cursor > 0 ? { ...s, cursor: s.cursor - 1 } : s;

/** The steps as state. Each move returns the state it sets, so a caller can
 * tell at once whether it reached the end. */
export function useSteps<R>(
  keys: string[],
  options: StepOptions & { done?: Step<R>[] } = {}
) {
  const [steps, setSteps] = useState<Steps<R>>(() =>
    startSteps(keys, options.done)
  );
  const set = (next: Steps<R>) => {
    setSteps(next);
    return next;
  };
  return {
    answer: (record: R, answer?: AnswerOptions) =>
      set(answerStep(steps, record, answer)),
    current: currentStep(steps),
    next: () => set(nextStep(steps, options)),
    previous: () => set(previousStep(steps)),
    reset: (next: string[], done: Step<R>[] = []) =>
      set(startSteps(next, done)),
    steps,
  };
}
