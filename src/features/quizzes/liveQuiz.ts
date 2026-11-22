import * as Y from 'yjs';
import { applyTextChange, LOCAL_EDIT } from '@/features/collaboration/yText';
import { repairGroups } from '@/features/questions/groups';
import type { FigureAt, FigureRoom } from '@/features/questions/questionEdits';
import {
  gapNumbers,
  type LearnerAnswer,
  type LearnerQuestion,
  type MarkItem,
  multipleAnswers,
  type Question,
  type QuestionAnswer,
  type QuestionBlock,
  type QuestionGroup,
  type QuestionPart,
  shuffledOrder,
} from '@/features/questions/types';
import { m } from '@/i18n';
import { uid } from '@/lib/id';
import { keyBetween } from '@/lib/orderKey';
import { Rng } from '@/lib/rng';
import {
  blockKey,
  keyBlock,
  type QuizDocs,
  readFigure,
  sectionMap,
  writeFigure,
} from './liveFigures';
import {
  alignAxis,
  child,
  type Entry,
  KEYS_ROOT,
  mapAt,
  ordered,
  orderedKeys,
  plain,
  QUESTIONS_ROOT,
  reorder,
  setPlain,
  setText,
  text,
  type YMap,
} from './liveMaps';
import { roomFigureBinding } from './roomFigureBinding';

/* A quiz's two live documents (live-items DESIGN.md 1.2, 1.3; Epo
 * 2026-10-10). The content document, which readers join too, holds
 * `questions`: question id -> {order, layout, labels, level?, topicIds?, stem,
 * groups?, parts} (topicIds a plain list, never empty), group id ->
 * {blocks}, part id -> {order, marks, blocks, answer, group?}. A group has no order of its own: it sits where its first part sits,
 * and what a merge leaves reads repaired (`repairGroups`, Epo 2026-11-04). The
 * answer map holds the type and what a learner may see: mcq options,
 * `multiple` (true while several are correct or the author's flag is set),
 * `shuffle` and `locked` (option id -> true; Shuffle options, Epo
 * 2026-11-15), a short answer's unit and matching left items. The keys document, which only
 * editors with write access join, holds `keys`: part id -> {type, solution,
 * correct | accepted | markscheme | gaps | options | pairs | items},
 * and an mcq's author `multiple` flag (Multiple answer, Epo 2026-11-15). Editors type ordering
 * items and matching options there; readers get them outside Yjs, as the
 * shuffled lists the content room pushes (`quiz-items`, D3 as revised
 * 2026-10-10), so neither their typing order nor their ids reach a reader.
 * The server checks both shapes (collaboration-rs/crates/items/src/quiz.rs)
 * and projects the complete questions to today's quiz JSON. */

export { KEYS_ROOT, QUESTIONS_ROOT } from './liveMaps';

export const questionsScope = (doc: Y.Doc) => doc.getMap<YMap>(QUESTIONS_ROOT);
export const keysScope = (doc: Y.Doc) => doc.getMap<YMap>(KEYS_ROOT);

/* --------------------------------------------------------------- reading */

/** A block entry of a kind this version has no reader for: a newer version
 * wrote it, and its rooms are read-only (collaboration-rs `Model::stored`,
 * Epo 2026-10-13). It shows as the unsupported notice and is never written
 * over ([writeBlocks] refuses a list holding one). */
const UNREADABLE = Object.freeze({ unreadable: true });
const unreadable = (
  read: QuestionBlock | null | typeof UNREADABLE
): read is typeof UNREADABLE => read === UNREADABLE;

/** A block entry as its question block; none while it is incomplete (no
 * type yet, a figure without its maps). A chart, plot or graph is read by
 * liveFigures.ts, once per change of its own. */
function readBlock(entry: YMap): QuestionBlock | null | typeof UNREADABLE {
  const type = plain<string>(entry, 'type');
  switch (type) {
    case 'text':
      return { text: text(entry, 'text'), type };
    case 'table': {
      const rows = orderedKeys(mapAt(entry, 'rows'));
      const columns = orderedKeys(mapAt(entry, 'columns'));
      const cells = mapAt(entry, 'cells');
      return {
        header: plain<boolean>(entry, 'header') === true,
        rows: rows.map((row) =>
          columns.map((column) => text(cells, `${row}/${column}`))
        ),
        type,
      };
    }
    case 'image': {
      const attribution = plain<string>(entry, 'attribution');
      // An image without a description holds an empty text (optional).
      const description = text(entry, 'description');
      return {
        ...(description ? { description } : {}),
        height: plain<number>(entry, 'height') ?? 1,
        image: plain<{ url: string } | { assetId: string }>(entry, 'image') ?? {
          url: '',
        },
        type,
        width: plain<number>(entry, 'width') ?? 1,
        ...(typeof attribution === 'string' ? { attribution } : {}),
      };
    }
    case 'chart':
    case 'plot':
    case 'graph':
      return readFigure(entry, type)?.block ?? null;
    case undefined:
      return null;
    default:
      return UNREADABLE;
  }
}

/** A section's blocks, each keyed by its entry (`FigureRoom.key`). */
function readBlocks(map: YMap | undefined): QuestionBlock[] {
  return ordered(map).flatMap(({ entry, id }): QuestionBlock[] => {
    const read = readBlock(entry);
    const block: QuestionBlock | null = unreadable(read)
      ? { text: m.material_unsupported_block(), type: 'text' }
      : read;
    if (!block) return [];
    keyBlock(block, id);
    return [block];
  });
}

const texts = (map: YMap | undefined) =>
  ordered(map).map(({ entry }) => text(entry, 'text'));

/** A part's keys, or none when they were written for another answer type. */
function partKeys(keys: Y.Doc | null, partId: string, type: string) {
  const key = keys ? mapAt(keysScope(keys) as YMap, partId) : undefined;
  return key && plain<string>(key, 'type') === type ? key : undefined;
}

const readMarkscheme = (key: YMap | undefined): MarkItem[] =>
  ordered(mapAt(key, 'markscheme')).map(({ entry }) => ({
    marks: plain<number>(entry, 'marks') ?? 1,
    text: text(entry, 'text'),
  }));

/** An mcq's locked option indices, only while Shuffle options is on. */
function lockedIndexes(answer: YMap | undefined, options: Entry[]): number[] {
  const locked = mapAt(answer, 'locked');
  if (plain<boolean>(answer, 'shuffle') !== true || !locked) return [];
  return options.flatMap((option, i) =>
    locked.get(option.id) === true ? [i] : []
  );
}

/** The order a reader already sees each shuffled mcq part's options in, by
 * part id: the stored view's, which the server seeds per viewer and quiz. */
export type ShownOrders = ReadonlyMap<string, readonly number[]>;

/** A learner's shown order of a part's options (Shuffle options, Epo
 * 2026-11-15): the order already shown while it still fits (as many options,
 * locked ones in place), so a sync or an edit elsewhere moves nothing; else
 * one seeded by the quiz and part, the same on every read. */
function readerOrder(
  shown: readonly number[] | undefined,
  count: number,
  locked: number[],
  seed: string
): number[] {
  if (
    shown?.length === count &&
    new Set(shown).size === count &&
    shown.every((index) => index >= 0 && index < count) &&
    locked.every((index) => shown[index] === index)
  )
    return [...shown];
  const rng = new Rng(seed);
  return shuffledOrder(count, locked, () => rng.next());
}

function readAnswer(
  answer: YMap | undefined,
  key: YMap | undefined
): { answer: QuestionAnswer; markscheme?: MarkItem[] } {
  const type = plain<string>(answer, 'type');
  switch (type) {
    case 'mcq': {
      const options = ordered(mapAt(answer, 'options'));
      const correct = key?.get('correct');
      const indexes = options.flatMap((option, i) =>
        correct instanceof Y.Map && correct.get(option.id) === true ? [i] : []
      );
      const locked = lockedIndexes(answer, options);
      return {
        answer: {
          correct: indexes,
          options: options.map(({ entry }) => text(entry, 'text')),
          type,
          ...(key?.get('multiple') === true ? { multiple: true as const } : {}),
          ...(plain<boolean>(answer, 'shuffle') === true
            ? { shuffle: true as const, ...(locked.length ? { locked } : {}) }
            : {}),
        },
      };
    }
    case 'boolean':
      return { answer: { correct: key?.get('correct') === true, type } };
    case 'short': {
      const unit = plain<string>(answer, 'unit');
      return {
        answer: {
          accepted: texts(mapAt(key, 'accepted')),
          type,
          ...(typeof unit === 'string' ? { unit } : {}),
        },
      };
    }
    case 'open':
      return {
        answer: {
          accepted: texts(mapAt(key, 'accepted')),
          type,
        },
        markscheme: readMarkscheme(key),
      };
    case 'drawing': {
      // A drawn sample answer is a key: its board and image asset ids.
      const board = plain<string>(key, 'sampleBoard');
      const image = plain<string>(key, 'sampleImage');
      return {
        answer: board && image ? { sample: { board, image }, type } : { type },
        markscheme: readMarkscheme(key),
      };
    }
    case 'gaps': {
      const gaps = mapAt(key, 'gaps');
      const numbers: number[] = [];
      gaps?.forEach((_, number) => {
        numbers.push(Number(number));
      });
      numbers.sort((a, b) => a - b);
      return {
        answer: {
          accepted: numbers.map((number) => texts(mapAt(gaps, String(number)))),
          type,
        },
      };
    }
    case 'matching': {
      const options = ordered(mapAt(key, 'options'));
      const pairs = mapAt(key, 'pairs');
      return {
        answer: {
          options: options.map(({ entry }) => text(entry, 'text')),
          pairs: ordered(mapAt(answer, 'left')).map(({ entry, id }) => ({
            left: text(entry, 'text'),
            right: options.findIndex((option) => option.id === pairs?.get(id)),
          })),
          type,
        },
      };
    }
    case 'ordering':
      return { answer: { items: texts(mapAt(key, 'items')), type } };
    default:
      return { answer: { accepted: [], type: 'short' } };
  }
}

/** A question's groups as they are held; `repairGroups` takes them from here. */
function readGroups(entry: YMap) {
  const groups = ordered(mapAt(entry, 'groups')).map(
    ({ entry: group, id }) => ({
      blocks: readBlocks(mapAt(group, 'blocks')),
      id,
    })
  );
  return groups.length > 0 ? { groups } : {};
}

/** The group a part names, as a field. */
function groupOf(part: YMap) {
  const group = plain<string>(part, 'group');
  return typeof group === 'string' ? { group } : {};
}

/** Every question as editors see it, keys included (`keys` null: none). */
export function readQuestions(content: Y.Doc, keys: Y.Doc | null): Question[] {
  return ordered(questionsScope(content) as YMap).map(({ entry, id }) => {
    const level = plain<Question['level']>(entry, 'level');
    const topicIds = plain<string[]>(entry, 'topicIds');
    return repairGroups({
      ...readGroups(entry),
      id,
      labels: plain<Question['labels']>(entry, 'labels') ?? 'letters',
      layout: plain<Question['layout']>(entry, 'layout') ?? 'paper',
      parts: ordered(mapAt(entry, 'parts')).map(
        ({ entry: part, id: partId }) => {
          const answerMap = mapAt(part, 'answer');
          const type = plain<string>(answerMap, 'type') ?? '';
          const key = partKeys(keys, partId, type);
          const { answer, markscheme } = readAnswer(answerMap, key);
          return {
            answer,
            blocks: readBlocks(mapAt(part, 'blocks')),
            id: partId,
            marks: plain<number>(part, 'marks') ?? 1,
            solution: readBlocks(mapAt(key, 'solution')),
            ...groupOf(part),
            ...(markscheme ? { markscheme } : {}),
          };
        }
      ),
      stem: readBlocks(mapAt(entry, 'stem')),
      ...(level ? { level } : {}),
      ...(topicIds?.length ? { topicIds } : {}),
    });
  });
}

/** A part's matching options or ordering items as readers get them: a plain
 * shuffled list the content room pushes over its channels, never in Yjs. */
export interface ReaderList {
  items: string[];
  kind: 'matching' | 'ordering';
}
export type ReaderLists = ReadonlyMap<string, ReaderList>;
const NO_LISTS: ReaderLists = new Map();

/** A `quiz-items` message applied: `full` replaces what the channel holds,
 * otherwise the parts it names change (`null`: no list any more). */
export function applyReaderMessage(
  current: ReaderLists,
  message: { full?: boolean; parts?: Record<string, ReaderList | null> }
): ReaderLists {
  const next = new Map(message.full ? [] : current);
  for (const [part, list] of Object.entries(message.parts ?? {}))
    if (list && Array.isArray(list.items)) next.set(part, list);
    else next.delete(part);
  return next;
}

/** Every question as a learner sees it: the content document, with matching
 * options and ordering items from the room's lists. */
export function readLearnerQuestions(
  content: Y.Doc,
  lists: ReaderLists = NO_LISTS,
  { quizId = '', shown }: { quizId?: string; shown?: ShownOrders } = {}
): LearnerQuestion[] {
  const items = (partId: string, kind: ReaderList['kind']) => {
    const list = lists.get(partId);
    return list?.kind === kind ? list.items : [];
  };
  return ordered(questionsScope(content) as YMap).map(({ entry, id }) => {
    const level = plain<Question['level']>(entry, 'level');
    return repairGroups({
      ...readGroups(entry),
      id,
      labels: plain<Question['labels']>(entry, 'labels') ?? 'letters',
      layout: plain<Question['layout']>(entry, 'layout') ?? 'paper',
      parts: ordered(mapAt(entry, 'parts')).map(
        ({ entry: part, id: partId }) => {
          const answer = mapAt(part, 'answer');
          const blocks = readBlocks(mapAt(part, 'blocks'));
          const type = plain<string>(answer, 'type');
          let learner: LearnerAnswer;
          switch (type) {
            case 'mcq': {
              const options = ordered(mapAt(answer, 'options'));
              learner = {
                options: options.map(({ entry }) => text(entry, 'text')),
                type,
                ...(plain<boolean>(answer, 'multiple') === true
                  ? { multiple: true as const }
                  : {}),
                ...(plain<boolean>(answer, 'shuffle') === true
                  ? {
                      order: readerOrder(
                        shown?.get(partId),
                        options.length,
                        lockedIndexes(answer, options),
                        `${quizId}/${partId}`
                      ),
                    }
                  : {}),
              };
              break;
            }
            case 'short': {
              const unit = plain<string>(answer, 'unit');
              learner = { type, ...(typeof unit === 'string' ? { unit } : {}) };
              break;
            }
            case 'matching':
              learner = {
                left: texts(mapAt(answer, 'left')),
                options: items(partId, 'matching'),
                type,
              };
              break;
            case 'ordering':
              learner = { items: items(partId, 'ordering'), type };
              break;
            case 'gaps':
              learner = { gaps: gapNumbers(blocks).length, type };
              break;
            case 'drawing':
              learner = { type };
              break;
            default:
              learner = { type: type === 'boolean' ? 'boolean' : 'open' };
          }
          return {
            answer: learner,
            blocks,
            id: partId,
            marks: plain<number>(part, 'marks') ?? 1,
            ...groupOf(part),
          };
        }
      ),
      stem: readBlocks(mapAt(entry, 'stem')),
      ...(level ? { level } : {}),
    });
  });
}

/* --------------------------------------------------------------- writing */

type ListItem = { text: string; set?: (entry: YMap) => void };

/** A list's entries by id, as `reorder` takes them. */
const entriesOf = (map: YMap) =>
  new Map(ordered(map).map(({ entry, id }) => [id, entry]));

/** Writes `next` into an ordered list of `{order, text}` entries with the
 * fewest changes, assuming one editor action (an edit, an insert, a removal,
 * a move): the common head and tail stay; a middle that is a permutation of
 * the current one only reorders; otherwise texts change in place and the rest
 * is inserted or removed, new entries keyed by `reorder` over the whole list
 * (so one lands even between two editors' appends holding one key). Returns
 * the entry ids in the new order. */
function writeList(map: YMap, next: ListItem[], prefix: string): string[] {
  const current = ordered(map).map((item) => ({
    ...item,
    text: text(item.entry, 'text'),
  }));
  let head = 0;
  while (
    head < current.length &&
    head < next.length &&
    current[head].text === next[head].text
  )
    head++;
  let tail = 0;
  while (
    tail < current.length - head &&
    tail < next.length - head &&
    current.at(-1 - tail)?.text === next.at(-1 - tail)?.text
  )
    tail++;
  const was = current.slice(head, current.length - tail);
  const will = next.slice(head, next.length - tail);
  const ids = current.map((item) => item.id);
  const sorted = (items: string[]) => [...items].sort().join('\u0000');
  if (
    was.length === will.length &&
    was.length > 1 &&
    sorted(was.map((item) => item.text)) ===
      sorted(will.map((item) => item.text))
  ) {
    // A move: entries keep their texts.
    const pool = [...was];
    const moved = will.map((item) => {
      const at = pool.findIndex((candidate) => candidate.text === item.text);
      return pool.splice(at, 1)[0].id;
    });
    const order = [
      ...ids.slice(0, head),
      ...moved,
      ...ids.slice(ids.length - tail),
    ];
    reorder(entriesOf(map), order);
    next.forEach((item, i) => {
      const entry = mapAt(map, order[i]);
      if (entry) item.set?.(entry);
    });
    return order;
  }
  const shared = Math.min(was.length, will.length);
  for (let i = 0; i < shared; i++) setText(was[i].entry, 'text', will[i].text);
  for (const removed of was.slice(shared)) map.delete(removed.id);
  const addedIds = will.slice(shared).map((item) => {
    const id = uid(prefix);
    const entry = new Y.Map<unknown>();
    entry.set('text', new Y.Text(item.text));
    map.set(id, entry);
    return id;
  });
  const order = [
    ...ids.slice(0, head + shared),
    ...addedIds,
    ...ids.slice(ids.length - tail),
  ];
  if (addedIds.length > 0) reorder(entriesOf(map), order);
  next.forEach((item, i) => {
    const entry = mapAt(map, order[i]);
    if (entry) item.set?.(entry);
  });
  return order;
}

/** A new block under a fresh id, with no order yet (the caller's `reorder`
 * keys it): put in place first, so the table writer reads back the rows and
 * columns it adds. Its key. */
function insertBlock(map: YMap, block: QuestionBlock) {
  const key = uid('block');
  const entry = new Y.Map<unknown>();
  map.set(key, entry);
  entry.set('type', block.type);
  writeBlockFields(entry, block);
  return key;
}

function writeTable(entry: YMap, rows: string[][]) {
  const rowMap = child(entry, 'rows');
  const columnMap = child(entry, 'columns');
  const cells = child(entry, 'cells');
  const width = Math.max(0, ...rows.map((row) => row.length));
  const cell = (row: string, column: string) => text(cells, `${row}/${column}`);
  const same = (a: string[], b: string[]) =>
    a.join('\u0000') === b.join('\u0000');
  // Columns first: a column added or removed shifts every row alike.
  const heldRows = orderedKeys(rowMap);
  const heldColumns = orderedKeys(columnMap);
  const columns = alignAxis(
    columnMap,
    width,
    (h, w) =>
      same(
        heldRows.map((row) => cell(row, heldColumns[h])),
        rows.slice(0, heldRows.length).map((row) => row[w] ?? '')
      ),
    'col',
    (column) => {
      for (const row of heldRows) cells.delete(`${row}/${column}`);
    }
  );
  // Then rows, by the same head and tail rule.
  const ids = alignAxis(
    rowMap,
    rows.length,
    (h, w) =>
      same(
        columns.map((column) => cell(heldRows[h], column)),
        columns.map((_, c) => rows[w][c] ?? '')
      ),
    'row',
    (row) => {
      for (const column of columns) cells.delete(`${row}/${column}`);
    }
  );
  ids.forEach((row, r) => {
    columns.forEach((column, c) => {
      const value = rows[r]?.[c] ?? '';
      const key = `${row}/${column}`;
      const current = cells.get(key);
      if (current instanceof Y.Text) applyTextChange(current, value, null);
      else cells.set(key, new Y.Text(value));
    });
  });
}

/** A block's fields written in place: texts as the fewest changes, small
 * values only when they differ, a chart, plot or graph as its fields and
 * maps (liveFigures.ts). */
function writeBlockFields(entry: YMap, block: QuestionBlock) {
  switch (block.type) {
    case 'text':
      setText(entry, 'text', block.text);
      return;
    case 'table':
      setPlain(entry, 'header', block.header);
      writeTable(entry, block.rows);
      return;
    case 'image':
      setPlain(entry, 'image', block.image);
      setPlain(entry, 'width', block.width);
      setPlain(entry, 'height', block.height);
      setText(entry, 'description', block.description ?? '');
      setPlain(entry, 'attribution', block.attribution);
      return;
    case 'chart':
    case 'plot':
    case 'graph':
      writeFigure(entry, block);
      return;
    default: {
      const unknown: never = block;
      const { type } = unknown as { type: string };
      throw new Error(`No writer for the question block type ${type}`);
    }
  }
}

/** A block as JSON with its keys sorted: a figure read from the room holds
 * its fields in the room's order. */
const blockJson = (block: QuestionBlock) =>
  JSON.stringify(block, (_, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))
        )
      : value
  );

/** Writes a block list with the fewest changes (same rule as `writeList`); a
 * block whose type changed is a new entry, keyed with the added ones. */
function writeBlocks(map: YMap, next: QuestionBlock[]) {
  const held = ordered(map).map((item) => ({
    ...item,
    read: readBlock(item.entry),
  }));
  if (held.some(({ read }) => unreadable(read)))
    throw new Error('A question holds a block this version cannot edit');
  const current = held.map(({ read, ...item }) => ({
    ...item,
    block: unreadable(read) ? null : read,
  }));
  const json = current.map((item) => (item.block ? blockJson(item.block) : ''));
  const wanted = next.map(blockJson);
  let head = 0;
  while (
    head < json.length &&
    head < wanted.length &&
    json[head] === wanted[head]
  )
    head++;
  let tail = 0;
  while (
    tail < json.length - head &&
    tail < wanted.length - head &&
    json.at(-1 - tail) === wanted.at(-1 - tail)
  )
    tail++;
  const was = current.slice(head, current.length - tail);
  const will = next.slice(head, next.length - tail);
  const sorted = (items: string[]) => [...items].sort().join('\u0001');
  if (
    was.length === will.length &&
    was.length > 1 &&
    sorted(json.slice(head, json.length - tail)) === sorted(will.map(blockJson))
  ) {
    const pool = was.map((item, i) => ({ id: item.id, json: json[head + i] }));
    const moved = will.map((block) => {
      const at = pool.findIndex(
        (candidate) => candidate.json === blockJson(block)
      );
      return pool.splice(at, 1)[0].id;
    });
    const ids = current.map((item) => item.id);
    reorder(entriesOf(map), [
      ...ids.slice(0, head),
      ...moved,
      ...ids.slice(ids.length - tail),
    ]);
    return;
  }
  const shared = Math.min(was.length, will.length);
  const kept = was.slice(0, shared).map((item, i) => {
    if (item.block?.type === will[i].type) {
      writeBlockFields(item.entry, will[i]);
      return item.id;
    }
    // Another type starts over as a new entry.
    map.delete(item.id);
    return insertBlock(map, will[i]);
  });
  for (const removed of was.slice(shared)) map.delete(removed.id);
  const added = will.slice(shared).map((block) => insertBlock(map, block));
  if (added.length === 0 && kept.every((id, i) => id === was[i].id)) return;
  const ids = current.map((item) => item.id);
  reorder(entriesOf(map), [
    ...ids.slice(0, head),
    ...kept,
    ...added,
    ...ids.slice(ids.length - tail),
  ]);
}

/** A map of ticks by option id holding exactly `ids`' (undefined: none). */
function setTicks(ticks: YMap, ids: (string | undefined)[]) {
  const wanted = new Set(ids);
  for (const id of [...ticks.keys()]) if (!wanted.has(id)) ticks.delete(id);
  for (const id of wanted)
    if (id && ticks.get(id) !== true) ticks.set(id, true);
}

/** What the keys write needs from the content write: entry ids by position. */
type PartIds = { left: string[]; options: string[] };

function writeContentAnswer(part: YMap, answer: QuestionAnswer): PartIds {
  let map = mapAt(part, 'answer');
  if (plain<string>(map, 'type') !== answer.type || !map) {
    // A type change replaces the answer map (and, below, the part's keys).
    map = new Y.Map<unknown>();
    part.set('answer', map);
    map.set('type', answer.type);
  }
  const ids: PartIds = { left: [], options: [] };
  switch (answer.type) {
    case 'mcq':
      ids.options = writeList(
        child(map, 'options'),
        answer.options.map((value) => ({ text: value })),
        'opt'
      );
      setPlain(map, 'multiple', multipleAnswers(answer) ? true : undefined);
      setPlain(map, 'shuffle', answer.shuffle);
      if (answer.shuffle && answer.locked?.length)
        setTicks(
          child(map, 'locked'),
          answer.locked.map((i) => ids.options[i])
        );
      else if (map.has('locked')) map.delete('locked');
      break;
    case 'short':
      setPlain(map, 'unit', answer.unit);
      break;
    case 'matching':
      ids.left = writeList(
        child(map, 'left'),
        answer.pairs.map((pair) => ({ text: pair.left })),
        'left'
      );
      break;
  }
  return ids;
}

function writeKeys(key: YMap, part: QuestionPart, ids: PartIds) {
  writeBlocks(child(key, 'solution'), part.solution);
  const answer = part.answer;
  const list = (name: string, items: string[], prefix: string) =>
    writeList(
      child(key, name),
      items.map((value) => ({ text: value })),
      prefix
    );
  switch (answer.type) {
    case 'mcq': {
      setPlain(key, 'multiple', answer.multiple);
      setTicks(
        child(key, 'correct'),
        answer.correct.map((i) => ids.options[i])
      );
      break;
    }
    case 'boolean':
      setPlain(key, 'correct', answer.correct);
      break;
    case 'short':
      list('accepted', answer.accepted, 'acc');
      break;
    case 'open':
    case 'drawing':
      if (answer.type === 'open') {
        list('accepted', answer.accepted, 'acc');
      } else {
        setPlain(key, 'sampleBoard', answer.sample?.board);
        setPlain(key, 'sampleImage', answer.sample?.image);
      }
      writeList(
        child(key, 'markscheme'),
        (part.markscheme ?? []).map((item) => ({
          set: (entry) => setPlain(entry, 'marks', item.marks),
          text: item.text,
        })),
        'mark'
      );
      break;
    case 'gaps': {
      const gaps = child(key, 'gaps');
      answer.accepted.forEach((accepted, i) => {
        writeList(
          child(gaps, String(i + 1)),
          accepted.map((value) => ({ text: value })),
          'gap'
        );
      });
      for (const number of [...gaps.keys()])
        if (Number(number) > answer.accepted.length) gaps.delete(number);
      break;
    }
    case 'matching': {
      const options = list('options', answer.options, 'mopt');
      const pairs = child(key, 'pairs');
      const wanted = new Map(
        answer.pairs.flatMap((pair, i) =>
          ids.left[i] && options[pair.right]
            ? [[ids.left[i], options[pair.right]] as const]
            : []
        )
      );
      for (const left of [...pairs.keys()])
        if (!wanted.has(left)) pairs.delete(left);
      for (const [left, option] of wanted) setPlain(pairs, left, option);
      break;
    }
    case 'ordering':
      list('items', answer.items, 'item');
      break;
  }
}

/** A question's groups, written as what differs; one that has none and never
 * had gets no map. */
function writeGroups(entry: YMap, next: QuestionGroup[]) {
  if (next.length === 0 && !mapAt(entry, 'groups')) return;
  const groups = child(entry, 'groups');
  const wanted = new Set(next.map((group) => group.id));
  for (const id of [...groups.keys()]) if (!wanted.has(id)) groups.delete(id);
  for (const group of next)
    writeBlocks(child(child(groups, group.id), 'blocks'), group.blocks);
}

function newQuestionMap(order: string): YMap {
  const entry = new Y.Map<unknown>();
  entry.set('order', order);
  entry.set('stem', new Y.Map<unknown>());
  entry.set('parts', new Y.Map<unknown>());
  return entry;
}

/** Writes one question into both documents with the fewest changes. Each
 * document takes one transaction with `origin` (the tab's own edits by
 * default, so its Undo covers them). */
export function writeQuestion(
  content: Y.Doc,
  keys: Y.Doc,
  next: Question,
  origin: unknown = LOCAL_EDIT
) {
  const ids = new Map<string, PartIds>();
  content.transact(() => {
    const questions = questionsScope(content) as YMap;
    let entry = mapAt(questions, next.id);
    if (!entry) {
      const last = ordered(questions).at(-1)?.order ?? null;
      entry = newQuestionMap(keyBetween(last, null));
      questions.set(next.id, entry);
    }
    setPlain(entry, 'layout', next.layout);
    setPlain(entry, 'labels', next.labels);
    setPlain(entry, 'level', next.level);
    setPlain(
      entry,
      'topicIds',
      next.topicIds?.length ? next.topicIds : undefined
    );
    writeBlocks(child(entry, 'stem'), next.stem);
    writeGroups(entry, next.groups ?? []);
    const parts = child(entry, 'parts');
    const wanted = new Set(next.parts.map((part) => part.id));
    for (const id of [...parts.keys()]) if (!wanted.has(id)) parts.delete(id);
    const existing = new Map(
      ordered(parts).map((item) => [item.id, item.entry])
    );
    for (const part of next.parts) {
      let map = existing.get(part.id);
      if (!map) {
        // Keyed by the reorder below.
        map = new Y.Map<unknown>();
        map.set('blocks', new Y.Map<unknown>());
        parts.set(part.id, map);
        existing.set(part.id, map);
      }
      setPlain(map, 'marks', part.marks);
      setPlain(map, 'group', part.group);
      writeBlocks(child(map, 'blocks'), part.blocks);
      ids.set(part.id, writeContentAnswer(map, part.answer));
    }
    reorder(
      existing,
      next.parts.map((part) => part.id)
    );
  }, origin);
  keys.transact(() => {
    const root = keysScope(keys) as YMap;
    for (const part of next.parts) {
      let key = mapAt(root, part.id);
      if (plain<string>(key, 'type') !== part.answer.type || !key) {
        key = new Y.Map<unknown>();
        root.set(part.id, key);
        key.set('type', part.answer.type);
      }
      writeKeys(key, part, ids.get(part.id) ?? { left: [], options: [] });
    }
  }, origin);
}

/** Removes a question from both documents. */
export function removeQuestion(
  content: Y.Doc,
  keys: Y.Doc,
  id: string,
  origin: unknown = LOCAL_EDIT
) {
  const question = mapAt(questionsScope(content) as YMap, id);
  const parts = [...(mapAt(question, 'parts')?.keys() ?? [])];
  content.transact(() => questionsScope(content).delete(id), origin);
  keys.transact(() => {
    for (const part of parts) keysScope(keys).delete(part);
  }, origin);
}

/** Moves a question to `index` in the quiz's order. */
export function moveQuestion(
  content: Y.Doc,
  id: string,
  index: number,
  origin: unknown = LOCAL_EDIT
) {
  const questions = questionsScope(content) as YMap;
  const entry = mapAt(questions, id);
  if (!entry) return;
  const others = ordered(questions).filter((item) => item.id !== id);
  const target = Math.max(0, Math.min(index, others.length));
  const lower = others[target - 1]?.order ?? null;
  const upper = others[target]?.order ?? null;
  content.transact(() => {
    // Only the moved entry takes a key, so a co-editor's move of a neighbour
    // survives; neighbours holding one key (two editors' adds) need `reorder`.
    if (lower === null || upper === null || lower < upper) {
      entry.set('order', keyBetween(lower, upper));
      return;
    }
    const ids = others.map((item) => item.id);
    ids.splice(target, 0, id);
    reorder(entriesOf(questions), ids);
  }, origin);
}

/** Writes new questions in after the one at `index` (-1: first), in the order
 * given: the editor's From the bank. One undo step takes them all, as Yjs
 * merges a burst of edits. */
export function insertQuestions(
  content: Y.Doc,
  keys: Y.Doc,
  questions: Question[],
  index: number
) {
  questions.forEach((question, i) => {
    writeQuestion(content, keys, question);
    moveQuestion(content, question.id, index + 1 + i);
  });
}

/** A quiz's blocks written by their room entries (Epo 2026-11-16): the
 * question card's figure dialogs write the entry the block was read from (a
 * chart or graph a change at a time through `bind`, a table at its Save,
 * writing only what differs) and remove it, so a figure a co-editor changed
 * meanwhile stays one figure. Each call is one undoable step. */
export function figureRoom(docs: QuizDocs): FigureRoom & { docs: QuizDocs } {
  const remove = (at: FigureAt) => {
    const { doc, map } = sectionMap(docs, at.question, at.section);
    if (!map?.has(at.entry)) return false;
    doc.transact(() => map.delete(at.entry), LOCAL_EDIT);
    return true;
  };
  return {
    bind: (at) => roomFigureBinding(docs, at, () => remove(at)),
    docs,
    insert: (place, block) => {
      const { doc, map } = sectionMap(docs, place.question, place.section);
      if (!map) return null;
      const ids = ordered(map).map((item) => item.id);
      const found = place.after ? ids.indexOf(place.after) : -1;
      const at = found >= 0 ? found + 1 : Math.min(place.index, ids.length);
      // Keyed by `reorder` over the section, so it lands at `at` even between
      // blocks holding one key.
      return doc.transact(() => {
        const key = insertBlock(map, block);
        ids.splice(at, 0, key);
        reorder(entriesOf(map), ids);
        return key;
      }, LOCAL_EDIT);
    },
    key: blockKey,
    remove,
    replace: (at, block) => {
      const { doc, map } = sectionMap(docs, at.question, at.section);
      const entry = mapAt(map, at.entry);
      if (!entry) return false;
      doc.transact(() => {
        // Another type starts its entry over under the same key.
        if (plain<string>(entry, 'type') !== block.type) {
          for (const key of [...entry.keys()])
            if (key !== 'order') entry.delete(key);
          entry.set('type', block.type);
        }
        writeBlockFields(entry, block);
      }, LOCAL_EDIT);
      return true;
    },
  };
}

/* ------------------------------------------- what the server follows */

/** Every matching and ordering part's entries in the keys document (id and
 * text, in the keys' order): what the content room's lists follow. The MSW
 * stand-in and tests use it. */
export function itemParts(keys: Y.Doc) {
  const out: {
    entries: { id: string; text: string }[];
    kind: ReaderList['kind'];
    part: string;
  }[] = [];
  keysScope(keys).forEach((key, part) => {
    const kind = plain<string>(key, 'type');
    if (kind !== 'matching' && kind !== 'ordering') return;
    out.push({
      entries: ordered(
        mapAt(key, kind === 'matching' ? 'options' : 'items')
      ).map((item) => ({ id: item.id, text: text(item.entry, 'text') })),
      kind,
      part,
    });
  });
  return out;
}

/** Seeds both documents from stored questions, as the server bootstraps a
 * quiz (the MSW stand-in and tests use it). */
export function seedQuiz(content: Y.Doc, keys: Y.Doc, questions: Question[]) {
  for (const question of questions)
    writeQuestion(content, keys, question, 'seed');
}

/** A learner's question in the editor's shape, with its keys still to come. */
export function withEmptyKeys(question: LearnerQuestion): Question {
  return {
    ...question,
    parts: question.parts.map((part): QuestionPart => {
      const { answer } = part;
      const full = (a: QuestionAnswer): QuestionPart => ({
        ...part,
        answer: a,
        solution: [],
      });
      switch (answer.type) {
        case 'mcq':
          return full({ ...answer, correct: [] });
        case 'boolean':
          return full({ correct: false, type: answer.type });
        case 'short':
          return full({ ...answer, accepted: [] });
        case 'matching':
          return full({
            options: answer.options,
            pairs: answer.left.map((left) => ({ left, right: 0 })),
            type: answer.type,
          });
        case 'ordering':
          return full(answer);
        case 'open':
          return full({ accepted: [], type: answer.type });
        case 'drawing':
          return full(answer);
        case 'gaps':
          return full({
            accepted: Array.from({ length: answer.gaps }, () => []),
            type: answer.type,
          });
        default:
          throw new Error('Unknown answer type');
      }
    }),
  };
}
