import { QUESTION_BLOCKS_MAX } from '@/api/limits.generated';
import type { Question, QuestionGroup, QuestionPart } from './types';

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

/** A new group at the end of the question, with its first part. */
export function appendGroup(
  question: Question,
  group: QuestionGroup,
  part: QuestionPart
): Question {
  return {
    ...question,
    groups: [...(question.groups ?? []), group],
    parts: [...question.parts, { ...part, group: group.id }],
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

/** Its parts become top-level parts where they are; no text or figure is lost:
 * the group's join its first part's top. */
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
      return { ...rest, blocks: [...filledBlocks(group), ...part.blocks] };
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

/** A question keeps a part, and a group too: its Ungroup or Remove takes it. */
export function canRemovePart(question: Question, partId: string): boolean {
  const group = question.parts.find((part) => part.id === partId)?.group;
  return (
    question.parts.length > 1 &&
    (!group || question.parts.filter((part) => part.group === group).length > 1)
  );
}
