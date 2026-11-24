import { QUESTION_BLOCKS_MAX } from '@/api/limits.generated';
import type { KeptPart } from './typeMemory';
import {
  canvasCount,
  partAnswerCanvas,
  type Question,
  type QuestionBlock,
  type QuestionGroup,
  type QuestionPart,
} from './types';

/* Grouped parts (Epo 2026-11-04). Flat, not nested: a group holds text and
 * figures, and parts stay the one unit for answers, marks, grading and review.
 * A group has no place of its own: it sits where its first part sits, its parts
 * next to each other in `parts`. Labels are computed: a top-level item (an
 * ungrouped part or a group) takes the question's `labels`, a part inside a
 * group (i), (ii), (iii). */

type Grouped = {
  groups?: QuestionGroup[];
  labels: Question['labels'];
  parts: { id: string; group?: string }[];
};

const ROMAN = [
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
] as const;

function roman(value: number): string {
  let rest = value;
  let out = '';
  for (const [size, numeral] of ROMAN)
    while (rest >= size) {
      out += numeral;
      rest -= size;
    }
  return out;
}

const TRAILING_DOT = /\.$/;

export const subLabel = (index: number) => `(${roman(index + 1)})`;
const topLabel = (labels: Question['labels'], index: number) =>
  labels === 'letters'
    ? `(${String.fromCharCode(97 + index)})`
    : `${index + 1}.`;

/** A lone part needs no label; one inside a group has the group's beside it. */
export const isLonePart = (question: { parts: { group?: string }[] }) =>
  question.parts.length === 1 && question.parts[0].group === undefined;

export type QuestionItem<P> =
  | { kind: 'part'; label: string; part: P }
  | {
      group: QuestionGroup;
      kind: 'group';
      label: string;
      parts: { label: string; part: P }[];
    };

/** A question's top-level items in reading order, with their labels. */
export function questionItems<P extends { id: string; group?: string }>(
  question: Grouped & { parts: P[] }
): QuestionItem<P>[] {
  const groups = new Map(question.groups?.map((group) => [group.id, group]));
  const items: QuestionItem<P>[] = [];
  for (const part of question.parts) {
    const group = part.group ? groups.get(part.group) : undefined;
    const last = items.at(-1);
    if (group && last?.kind === 'group' && last.group.id === group.id)
      last.parts.push({ label: subLabel(last.parts.length), part });
    else if (group)
      items.push({
        group,
        kind: 'group',
        label: topLabel(question.labels, items.length),
        parts: [{ label: subLabel(0), part }],
      });
    else
      items.push({
        kind: 'part',
        label: topLabel(question.labels, items.length),
        part,
      });
  }
  return items;
}

/** A part's place: its top-level item, and its place in a group. */
export function partPlaces(question: Grouped) {
  const places = new Map<string, { item: number; sub?: number }>();
  questionItems(question).forEach((item, index) => {
    if (item.kind === 'part') places.set(item.part.id, { item: index });
    else
      item.parts.forEach(({ part }, sub) => {
        places.set(part.id, { item: index, sub });
      });
  });
  return places;
}

/** A part's label in full, where nothing beside it shows its group: "(b)(i)"
 * or "2(i)"; an ungrouped part's own label. */
export function fullPartLabel(question: Grouped, partId: string): string {
  const place = partPlaces(question).get(partId);
  if (!place) return '';
  const top = topLabel(question.labels, place.item);
  return place.sub === undefined
    ? top
    : `${top.replace(TRAILING_DOT, '')}${subLabel(place.sub)}`;
}

/** What a merge of two editors' changes can leave, as readers take it: a part
 * naming a group that is gone has no group, a group with no parts goes, and a
 * group's parts come together at the first one's place, in their order; `groups`
 * lists what is left in reading order. The collaboration server's
 * `repair_groups` is the same; both run testdata/repairs/groups.json. */
export function repairGroups<
  Q extends { groups?: QuestionGroup[]; parts: { group?: string }[] },
>(question: Q): Q {
  const held = new Map(question.groups?.map((group) => [group.id, group]));
  const groups: QuestionGroup[] = [];
  const parts: Q['parts'] = [];
  for (const part of question.parts) {
    const group = part.group === undefined ? undefined : held.get(part.group);
    if (part.group === undefined) parts.push(part);
    else if (!group) {
      const { group: _gone, ...ungrouped } = part;
      parts.push(ungrouped);
    } else if (!groups.includes(group)) {
      groups.push(group);
      parts.push(...question.parts.filter((p) => p.group === part.group));
    }
  }
  const { groups: _held, ...rest } = question;
  return { ...rest, parts, ...(groups.length > 0 ? { groups } : {}) } as Q;
}

/* ------------------------------------------------- the editor's actions */

/** A top-level part or group, or a part inside a group. */
export type ItemRef = { group?: never; part: string } | { group: string };

type Unit = { key: string; parts: QuestionPart[] };
const refKey = (ref: ItemRef) =>
  ref.group === undefined ? `part:${ref.part}` : `group:${ref.group}`;

/** The list a ref moves in: a sub-part among its group's parts, anything else
 * among the top-level items, a group with all its parts. */
function level(question: Question, ref: ItemRef): Unit[] {
  const part =
    ref.group === undefined
      ? question.parts.find((item) => item.id === ref.part)
      : undefined;
  if (part?.group)
    return question.parts
      .filter((item) => item.group === part.group)
      .map((item) => ({ key: `part:${item.id}`, parts: [item] }));
  return questionItems(question).map((item) =>
    item.kind === 'part'
      ? { key: `part:${item.part.id}`, parts: [item.part] }
      : {
          key: `group:${item.group.id}`,
          parts: item.parts.map(({ part: inner }) => inner),
        }
  );
}

/** The question with `ref`'s list reading as `units`. */
function withLevel(question: Question, ref: ItemRef, units: Unit[]): Question {
  const parts = units.flatMap((unit) => unit.parts);
  const inner =
    ref.group === undefined
      ? question.parts.find((item) => item.id === ref.part)?.group
      : undefined;
  if (!inner) return { ...question, parts };
  let next = 0;
  return {
    ...question,
    parts: question.parts.map((item) =>
      item.group === inner ? parts[next++] : item
    ),
  };
}

export function canMoveItem(
  question: Question,
  ref: ItemRef,
  direction: number
): boolean {
  const units = level(question, ref);
  const index = units.findIndex((unit) => unit.key === refKey(ref));
  const target = index + direction;
  return index >= 0 && target >= 0 && target < units.length;
}

/** Moves a part or group one place among its list. */
export function moveItem(
  question: Question,
  ref: ItemRef,
  direction: number
): Question {
  if (!canMoveItem(question, ref, direction)) return question;
  const units = level(question, ref);
  const index = units.findIndex((unit) => unit.key === refKey(ref));
  [units[index], units[index + direction]] = [
    units[index + direction],
    units[index],
  ];
  return withLevel(question, ref, units);
}

/** Whether `source` may land beside `target`: both in the same list. */
export function canPlaceItem(
  question: Question,
  source: ItemRef,
  target: ItemRef
): boolean {
  return (
    refKey(source) !== refKey(target) &&
    level(question, source).some((unit) => unit.key === refKey(target)) &&
    level(question, target).some((unit) => unit.key === refKey(source))
  );
}

/** Puts `source` just before or after `target`, in their list. */
export function placeItem(
  question: Question,
  source: ItemRef,
  target: ItemRef,
  after: boolean
): Question {
  if (!canPlaceItem(question, source, target)) return question;
  const units = level(question, source);
  const moved = units.find((unit) => unit.key === refKey(source));
  const rest = units.filter((unit) => unit.key !== refKey(source));
  const index = rest.findIndex((unit) => unit.key === refKey(target));
  if (!moved) return question;
  rest.splice(index + Number(after), 0, moved);
  return withLevel(question, source, rest);
}

/** A part blanked by Add part or Add sub-part (Epo 2026-11-24): its blocks
 * join the list above it (`above`, the stem's or a new group's), but for its
 * canvas when that list holds one already, which goes in `kept` with its
 * answer, marking scheme, marks and explanation; `parts` are the blank parts
 * made in its place. */
function blankOut(
  part: QuestionPart,
  above: QuestionBlock[],
  parts: string[]
): { blocks: QuestionBlock[]; kept: KeptPart } {
  const index = canvasCount(above)
    ? part.blocks.findIndex((block) => block.type === 'canvas')
    : -1;
  const canvas = part.blocks[index];
  return {
    blocks: [...above, ...part.blocks.filter((_, i) => i !== index)],
    kept: {
      answer: part.answer,
      ...(canvas?.type === 'canvas' && { canvas: { block: canvas, index } }),
      from: part.id,
      marks: part.marks,
      markscheme: part.markscheme,
      parts,
      solution: part.solution,
    },
  };
}

/** A top-level part split into sub-parts (a part's ⋮ Add sub-part, Epo
 * 2026-11-24 as Add part): its blocks become the group's text and it becomes
 * `blank` as (i), `next` following as (ii), what it held in `kept`. A fill in
 * the blanks part stays (i) whole, its blanks living in its text, and the
 * group's text starts empty. */
export function splitPart(
  question: Question,
  partId: string,
  groupId: string,
  blank: QuestionPart,
  next: QuestionPart
): { kept?: KeptPart; question: Question } {
  const index = question.parts.findIndex((part) => part.id === partId);
  const part = question.parts[index];
  if (!part || part.group !== undefined) return { question };
  const gaps = part.answer.type === 'gaps';
  const { blocks, kept } = gaps
    ? { blocks: [{ text: '', type: 'text' as const }], kept: undefined }
    : blankOut(part, [], [blank.id, next.id]);
  const parts = [...question.parts];
  parts.splice(
    index,
    1,
    { ...(gaps ? part : blank), group: groupId },
    { ...next, group: groupId }
  );
  return {
    kept,
    question: repairGroups({
      ...question,
      groups: [...(question.groups ?? []), { blocks, id: groupId }],
      parts,
    }),
  };
}

/** Add part (Epo 2026-11-23, E1): `part` after the others. On a lone
 * question every block of its part joins the stem, after the stem's (its
 * canvas kept back when the stem holds one, Epo 2026-11-24), and the part
 * becomes `blank` (a new blank part), what it held in `kept`. A lone fill in
 * the blanks part stays (a) whole, its blanks living in its text. */
export function addPart(
  question: Question,
  part: QuestionPart,
  blank: QuestionPart
): { kept?: KeptPart; question: Question } {
  if (!isLonePart(question))
    return { question: { ...question, parts: [...question.parts, part] } };
  const [lone] = question.parts;
  if (lone.answer.type === 'gaps')
    return { question: { ...question, parts: [lone, part] } };
  const { blocks, kept } = blankOut(lone, question.stem, [blank.id, part.id]);
  return {
    kept,
    question: { ...question, parts: [blank, part], stem: blocks },
  };
}

/** The question with what Add part or Add sub-part kept back in part
 * `partId`: the answer, marking scheme, marks and explanation, and a canvas
 * kept back in its old place. A canvas answer whose own canvas went above
 * (to the stem or its group's text) answers in the canvas above now. */
export function withKeptPart(
  question: Question,
  partId: string,
  kept: KeptPart
): Question {
  const { answer, canvas, markscheme, marks, solution } = kept;
  return {
    ...question,
    parts: question.parts.map((part) => {
      if (part.id !== partId) return part;
      const at = Math.min(canvas?.index ?? 0, part.blocks.length);
      const blocks = canvas
        ? [...part.blocks.slice(0, at), canvas.block, ...part.blocks.slice(at)]
        : part.blocks;
      const above =
        answer.type === 'canvas' && !answer.shared && !canvasCount(blocks);
      // Each key set, a closed answer's absent marking scheme too.
      return {
        ...part,
        answer: above ? { ...answer, shared: true } : answer,
        blocks,
        marks,
        markscheme,
        solution,
      };
    }),
  };
}

/** A new part after the group's last. */
export function addSubPart(
  question: Question,
  groupId: string,
  part: QuestionPart
): Question {
  const parts = [...question.parts];
  const last = parts.map((item) => item.group).lastIndexOf(groupId);
  parts.splice(last + 1, 0, { ...part, group: groupId });
  return { ...question, parts };
}

const withoutGroup = (question: Question, groupId: string) => {
  const groups = question.groups?.filter((group) => group.id !== groupId);
  const { groups: _held, ...rest } = question;
  return { ...rest, ...(groups?.length ? { groups } : {}) };
};

/** A group's blocks but its blank texts. */
const filledBlocks = (group: QuestionGroup) =>
  group.blocks.filter((block) => block.type !== 'text' || block.text.trim());

/** A group's text and figures join its first part's top when it is undone, as
 * long as they fit there. */
export function canUngroup(question: Question, groupId: string): boolean {
  const group = question.groups?.find((item) => item.id === groupId);
  const first = question.parts.find((part) => part.group === groupId);
  return (
    !!group &&
    !!first &&
    filledBlocks(group).length + first.blocks.length <= QUESTION_BLOCKS_MAX
  );
}

/** What stops a group's canvas going to its first part on Ungroup (Epo
 * 2026-11-24): `canvas`, that part holds one of its own, and a list holds
 * one; `answered`, another of its parts answers in the group's canvas, which
 * can't be taken from it while it does. Null with no canvas in its text. */
export function ungroupCanvasIssue(
  question: Question,
  groupId: string
): 'answered' | 'canvas' | null {
  const group = question.groups?.find((item) => item.id === groupId);
  if (!group || !canvasCount(group.blocks)) return null;
  const [first, ...others] = question.parts.filter(
    (part) => part.group === groupId
  );
  if (first && canvasCount(first.blocks)) return 'canvas';
  return others.some(
    (part) => partAnswerCanvas(question, part)?.place.section === 'group'
  )
    ? 'answered'
    : null;
}

/** Its parts become top-level parts where they are; no text or figure is lost:
 * the group's join its first part's top. A first part that answered in the
 * group's canvas answers in it as its own then, the same canvas (Epo
 * 2026-11-24). */
export function ungroup(question: Question, groupId: string): Question {
  const group = question.groups?.find((item) => item.id === groupId);
  if (!group) return question;
  let first = true;
  return {
    ...withoutGroup(question, groupId),
    parts: question.parts.map((part) => {
      if (part.group !== groupId) return part;
      const { group: _group, ...rest } = part;
      if (!first) return rest;
      first = false;
      const blocks = [...filledBlocks(group), ...part.blocks];
      if (
        rest.answer.type !== 'canvas' ||
        !rest.answer.shared ||
        !canvasCount(group.blocks)
      )
        return { ...rest, blocks };
      const { shared: _shared, ...answer } = rest.answer;
      return { ...rest, answer, blocks };
    }),
  };
}

/** Takes the group and its parts away; a question keeps at least one part. */
export function removeGroup(question: Question, groupId: string): Question {
  return {
    ...withoutGroup(question, groupId),
    parts: question.parts.filter((part) => part.group !== groupId),
  };
}

export const canRemoveGroup = (question: Question, groupId: string) =>
  question.parts.some((part) => part.group !== groupId);

/** Takes a part away. A group left with one sub-part turns back into a plain
 * part, as Add sub-part made it, when its text fits there. */
export function removePart(question: Question, partId: string): Question {
  const group = question.parts.find((part) => part.id === partId)?.group;
  const next = {
    ...question,
    parts: question.parts.filter((part) => part.id !== partId),
  };
  const left = next.parts.filter((part) => part.group === group).length;
  return group && left === 1 && canUngroup(next, group)
    ? ungroup(next, group)
    : next;
}

/** A question keeps a part, and a group too: its Ungroup or Remove takes it. */
export function canRemovePart(question: Question, partId: string): boolean {
  const group = question.parts.find((part) => part.id === partId)?.group;
  return (
    question.parts.length > 1 &&
    (!group || question.parts.filter((part) => part.group === group).length > 1)
  );
}
