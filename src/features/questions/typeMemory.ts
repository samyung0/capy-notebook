import {
  type CanvasBlock,
  type DrawnSample,
  QUESTION_TYPES,
  type QuestionPart,
  type QuestionType,
} from './types';

/* What a part's edits take out of the question, kept for this tab in
 * sessionStorage, gone when the tab closes and never on the server (Epo
 * 2026-11-23: multiple choice to blanks and back lost its options, and Undo
 * didn't bring them back). Each is kept, taken or forgotten once the edit's
 * write lands (Epo 2026-11-24):
 * - a type it leaves: its answer and marking scheme, by quiz, part and type,
 *   taken back in place of an empty answer when it switches back. A canvas
 *   stays as a block through a type switch.
 * - a drawn sample that switch back held off at the question's canvas cap
 *   (Epo 2026-11-24), by quiz and part, back on a later switch that fits it,
 *   forgotten once the part's sample is drawn, replaced, removed or restored.
 * - its own canvas when it answers in the canvas above (Same canvas), by quiz
 *   and part, put back on New canvas.
 * - a part's answer, marking scheme, marks and explanation when Add part or
 *   Add sub-part blanks it, by quiz and question with the blank parts made and
 *   the part's own memory above, back when one of them is left alone again. */

type Kept = Pick<QuestionPart, 'answer' | 'markscheme'>;

const key = (quiz: string, part: string, type: QuestionType) =>
  `capy.answerType.${quiz}.${part}.${type}`;

function store(key: string, value: unknown) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage off or full: the edit forgets, as before.
  }
}

function read<T>(key: string): T | null {
  try {
    const held = sessionStorage.getItem(key);
    return held ? (JSON.parse(held) as T) : null;
  } catch {
    return null;
  }
}

function forget(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Nothing kept to forget.
  }
}

/** Keeps `part`'s answer and marking scheme under its type, as it leaves it. */
export function keepAnswer(quiz: string, part: QuestionPart) {
  const kept: Kept = { answer: part.answer, markscheme: part.markscheme };
  store(key(quiz, part.id, part.answer.type), kept);
}

/** What part `part` held when it last left `type` in this tab, or null. */
export function keptAnswer(
  quiz: string,
  part: string,
  type: QuestionType
): Kept | null {
  const kept = read<Kept>(key(quiz, part, type));
  return kept?.answer?.type === type ? kept : null;
}

const sampleKey = (quiz: string, part: string) =>
  `capy.heldSample.${quiz}.${part}`;

/** Holds `sample` off for part `part`, or with none forgets the one held. */
export function holdSample(
  quiz: string,
  part: string,
  sample: DrawnSample | undefined
) {
  if (sample) store(sampleKey(quiz, part), sample);
  else forget(sampleKey(quiz, part));
}

/** The drawn sample held off for part `part`, or null; it stays held until
 * `holdSample` forgets it. */
export function heldSample(quiz: string, part: string): DrawnSample | null {
  const held = read<DrawnSample>(sampleKey(quiz, part));
  return held?.board && held.image ? held : null;
}

/** A canvas a part gave up, and its place in the part's blocks: its own as
 * Same canvas took it out, or one Add part took off a lone part whose stem
 * held a canvas already. */
export type KeptCanvas = { block: CanvasBlock; index: number };

const canvasKey = (quiz: string, part: string) =>
  `capy.partCanvas.${quiz}.${part}`;

export function keepCanvas(quiz: string, part: string, kept: KeptCanvas) {
  store(canvasKey(quiz, part), kept);
}

/** The canvas part `part` last gave up for the canvas above, or null; it
 * stays kept until `forgetCanvas`, once New's write lands. */
export function keptCanvas(quiz: string, part: string): KeptCanvas | null {
  const kept = read<KeptCanvas>(canvasKey(quiz, part));
  return kept?.block?.type === 'canvas' ? kept : null;
}

export function forgetCanvas(quiz: string, part: string) {
  forget(canvasKey(quiz, part));
}

/** A part's own memory above: its answers by type, the canvas Same canvas
 * took and a held drawn sample. */
export type PartMemory = {
  answers: Kept[];
  canvas?: KeptCanvas;
  sample?: DrawnSample;
};

function partMemory(quiz: string, part: string): PartMemory {
  const canvas = keptCanvas(quiz, part);
  const sample = heldSample(quiz, part);
  return {
    answers: QUESTION_TYPES.flatMap(
      (type) => keptAnswer(quiz, part, type) ?? []
    ),
    ...(canvas && { canvas }),
    ...(sample && { sample }),
  };
}

/** What Add part or Add sub-part blanked on part `from`: its answer, marking
 * scheme, marks and explanation, a canvas it gave up (`canvas`), the blank
 * parts made in its place (`parts`), the only ones it goes back into, and its
 * own memory (`own`), which goes back with it under that part's id. */
export type KeptPart = Pick<
  QuestionPart,
  'answer' | 'markscheme' | 'marks' | 'solution'
> & { canvas?: KeptCanvas; from: string; own?: PartMemory; parts: string[] };

const partsKey = (quiz: string, question: string) =>
  `capy.keptParts.${quiz}.${question}`;

const keptParts = (quiz: string, question: string) => {
  const held = read<KeptPart[]>(partsKey(quiz, question));
  return Array.isArray(held)
    ? held.filter((kept) => kept?.answer && Array.isArray(kept.parts))
    : [];
};

function storeParts(quiz: string, question: string, held: KeptPart[]) {
  if (held.length) store(partsKey(quiz, question), held);
  else forget(partsKey(quiz, question));
}

/** Keeps what Add part or Add sub-part blanked, with the blanked part's own
 * memory. */
export function keepPart(quiz: string, question: string, kept: KeptPart) {
  const own = partMemory(quiz, kept.from);
  storeParts(quiz, question, [...keptParts(quiz, question), { ...kept, own }]);
}

/** What was kept when part `part` was made blank in its place, or null; it
 * stays kept until `forgetPart`, once the write that used it lands. */
export function keptPart(
  quiz: string,
  question: string,
  part: string
): KeptPart | null {
  return (
    keptParts(quiz, question).find((item) => item.parts.includes(part)) ?? null
  );
}

export function forgetPart(quiz: string, question: string, part: string) {
  const held = keptParts(quiz, question);
  const left = held.filter((item) => !item.parts.includes(part));
  if (left.length !== held.length) storeParts(quiz, question, left);
}

/** A kept part's own memory given to part `part`, which took what it kept. */
export function giveMemory(quiz: string, part: string, own: PartMemory) {
  for (const kept of own.answers)
    store(key(quiz, part, kept.answer.type), kept);
  if (own.canvas) keepCanvas(quiz, part, own.canvas);
  if (own.sample) holdSample(quiz, part, own.sample);
}

/** Forgets what was kept for blank parts gone from the question, as Undo of
 * Add part leaves it, bringing back the part it blanked with its own id (Epo
 * 2026-11-24): nothing stale is restored later. What a later Add sub-part
 * blanked one of them into still leads back to it (`from`), so Undo of that
 * can still restore it. */
export function forgetGoneParts(
  quiz: string,
  question: string,
  parts: readonly string[]
) {
  const held = keptParts(quiz, question);
  const live = new Set(
    held.filter((kept) => kept.parts.some((id) => parts.includes(id)))
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const kept of held)
      if (
        !live.has(kept) &&
        [...live].some((later) => kept.parts.includes(later.from))
      ) {
        live.add(kept);
        grew = true;
      }
  }
  if (live.size !== held.length)
    storeParts(
      quiz,
      question,
      held.filter((kept) => live.has(kept))
    );
}
