import * as Y from 'yjs';
import { applyTextChange, LOCAL_EDIT } from '@/features/collaboration/yText';
import {
  gapNumbers,
  type LearnerAnswer,
  type LearnerQuestion,
  type MarkItem,
  type Question,
  type QuestionAnswer,
  type QuestionBlock,
  type QuestionPart,
} from '@/features/questions/types';
import { uid } from '@/lib/id';
import { keyBetween } from '@/lib/orderKey';

/* A quiz's two live documents (live-items DESIGN.md 1.2, 1.3; Epo
 * 2026-10-10). The content document, which readers join too, holds
 * `questions`: question id -> {order, layout, labels, level?, stem, parts},
 * part id -> {order, marks, blocks, answer}. The answer map holds the type and
 * what a learner may see: mcq and multi options, a short answer's unit and
 * matching left items. The keys document, which only editors with write
 * access join, holds `keys`: part id -> {type, solution, correct | accepted |
 * hints | markscheme | gaps | options | pairs | items}. Editors type ordering
 * items and matching options there; readers get them outside Yjs, as the
 * shuffled lists the content room pushes (`quiz-items`, D3 as revised
 * 2026-10-10), so neither their typing order nor their ids reach a reader.
 * The server checks both shapes (collaboration-rs/crates/items/src/quiz.rs)
 * and projects the complete questions to today's quiz JSON. */

export const QUESTIONS_ROOT = 'questions';
export const KEYS_ROOT = 'keys';

type YMap = Y.Map<unknown>;
type Entry = { entry: YMap; id: string; order: string };

export const questionsScope = (doc: Y.Doc) => doc.getMap<YMap>(QUESTIONS_ROOT);
export const keysScope = (doc: Y.Doc) => doc.getMap<YMap>(KEYS_ROOT);

const byOrder = (a: Entry, b: Entry) =>
  a.order < b.order
    ? -1
    : a.order > b.order
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;

function mapAt(parent: YMap | undefined, key: string): YMap | undefined {
  const value = parent?.get(key);
  return value instanceof Y.Map ? (value as YMap) : undefined;
}

/** A map's entries that are maps, in `(order, id)` order. */
function ordered(map: YMap | undefined): Entry[] {
  const out: Entry[] = [];
  map?.forEach((value, id) => {
    if (!(value instanceof Y.Map)) return;
    const order = value.get('order');
    out.push({
      entry: value as YMap,
      id,
      order: typeof order === 'string' ? order : '',
    });
  });
  return out.sort(byOrder);
}

/** A table's row or column ids (id -> order key), in order. */
function orderedKeys(map: YMap | undefined): string[] {
  const out: { id: string; order: string }[] = [];
  map?.forEach((value, id) => {
    out.push({ id, order: typeof value === 'string' ? value : '' });
  });
  return out
    .sort((a, b) =>
      a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1
    )
    .map((row) => row.id);
}

function text(map: YMap | undefined, key: string): string {
  const value = map?.get(key);
  return value instanceof Y.Text ? value.toString() : '';
}

const plain = <T>(map: YMap | undefined, key: string) =>
  map?.get(key) as T | undefined;

/* --------------------------------------------------------------- reading */

/** A block entry as its question block; none while it is incomplete (no
 * type yet, a chart without its value). A type it has no reader for throws
 * instead of dropping the block, which the next save would delete: the room
 * admits only the kinds this reads (collaboration-rs items quiz.rs). */
function readBlock(entry: YMap): QuestionBlock | null {
  const type = plain<string>(entry, 'type');
  switch (type) {
    case 'text': {
      const label = plain<string>(entry, 'label');
      return {
        text: text(entry, 'text'),
        type,
        ...(typeof label === 'string' ? { label } : {}),
      };
    }
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
      return {
        description: text(entry, 'description'),
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
    case 'graph': {
      const value = plain<Record<string, unknown>>(entry, 'value');
      return value ? ({ ...value, type } as QuestionBlock) : null;
    }
    case undefined:
      return null;
    default:
      throw new Error(`No reader for the question block type ${type}`);
  }
}

function readBlocks(map: YMap | undefined): QuestionBlock[] {
  return ordered(map).flatMap(({ entry }) => readBlock(entry) ?? []);
}

const texts = (map: YMap | undefined) =>
  ordered(map).map(({ entry }) => text(entry, 'text'));

/** A part's keys, or none when they were written for another answer type. */
function partKeys(keys: Y.Doc | null, partId: string, type: string) {
  const key = keys ? mapAt(keysScope(keys) as YMap, partId) : undefined;
  return key && plain<string>(key, 'type') === type ? key : undefined;
}

function readAnswer(
  answer: YMap | undefined,
  key: YMap | undefined
): { answer: QuestionAnswer; markscheme?: MarkItem[] } {
  const type = plain<string>(answer, 'type');
  switch (type) {
    case 'mcq':
    case 'multi': {
      const options = ordered(mapAt(answer, 'options'));
      const correct = key?.get('correct');
      const indexes =
        type === 'mcq'
          ? options.flatMap((option, i) => (option.id === correct ? [i] : []))
          : options.flatMap((option, i) =>
              correct instanceof Y.Map && correct.get(option.id) === true
                ? [i]
                : []
            );
      return {
        answer: {
          correct: indexes,
          options: options.map(({ entry }) => text(entry, 'text')),
          type,
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
          hints: texts(mapAt(key, 'hints')),
          type,
        },
        markscheme: ordered(mapAt(key, 'markscheme')).map(({ entry }) => ({
          marks: plain<number>(entry, 'marks') ?? 1,
          text: text(entry, 'text'),
        })),
      };
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

/** Every question as editors see it, keys included (`keys` null: none). */
export function readQuestions(content: Y.Doc, keys: Y.Doc | null): Question[] {
  return ordered(questionsScope(content) as YMap).map(({ entry, id }) => {
    const level = plain<Question['level']>(entry, 'level');
    return {
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
            ...(markscheme ? { markscheme } : {}),
          };
        }
      ),
      stem: readBlocks(mapAt(entry, 'stem')),
      ...(level ? { level } : {}),
    };
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
  lists: ReaderLists = NO_LISTS
): LearnerQuestion[] {
  const items = (partId: string, kind: ReaderList['kind']) => {
    const list = lists.get(partId);
    return list?.kind === kind ? list.items : [];
  };
  return ordered(questionsScope(content) as YMap).map(({ entry, id }) => {
    const level = plain<Question['level']>(entry, 'level');
    return {
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
            case 'mcq':
            case 'multi':
              learner = { options: texts(mapAt(answer, 'options')), type };
              break;
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
            default:
              learner = { type: type === 'boolean' ? 'boolean' : 'open' };
          }
          return {
            answer: learner,
            blocks,
            id: partId,
            marks: plain<number>(part, 'marks') ?? 1,
          };
        }
      ),
      stem: readBlocks(mapAt(entry, 'stem')),
      ...(level ? { level } : {}),
    };
  });
}

/* --------------------------------------------------------------- writing */

function setPlain(map: YMap, key: string, value: unknown) {
  if (value === undefined) {
    if (map.has(key)) map.delete(key);
    return;
  }
  const current = map.get(key);
  if (JSON.stringify(current) !== JSON.stringify(value)) map.set(key, value);
}

/** The map at `key`, created when missing. */
function child(map: YMap, key: string): YMap {
  const found = mapAt(map, key);
  if (found) return found;
  const created = new Y.Map<unknown>();
  map.set(key, created);
  return created;
}

function setText(map: YMap, key: string, value: string) {
  const current = map.get(key);
  if (current instanceof Y.Text) applyTextChange(current, value, null);
  else map.set(key, new Y.Text(value));
}

/** Order keys for `count` new entries between two existing ones. */
function keysBetween(
  after: string | null,
  before: string | null,
  count: number
) {
  const out: string[] = [];
  let last = after;
  for (let i = 0; i < count; i++) {
    // Past the last key a key after `last` suffices; otherwise squeeze in.
    last = before === null ? keyBetween(last, null) : keyBetween(last, before);
    out.push(last);
  }
  return out;
}

/** Reorders `entries` (current order) so they read as `ids`: keys of entries
 * already in a rising run stay, the others get new keys between neighbours. */
function reorder(entries: Map<string, YMap>, ids: string[]) {
  const orders = ids.map((id) => plain<string>(entries.get(id), 'order') ?? '');
  for (let i = 0; i < ids.length; i++) {
    const previous = i > 0 ? orders[i - 1] : null;
    if (previous === null ? orders[i] !== '' : orders[i] > previous) {
      // Keep it if it also stays below the next kept key.
      const next = orders.slice(i + 1).find((order) => order > orders[i]);
      if (next !== undefined || i === ids.length - 1) continue;
    }
    const upper = orders.slice(i + 1).find((order) => order > (previous ?? ''));
    orders[i] = keyBetween(previous, upper ?? null);
    entries.get(ids[i])?.set('order', orders[i]);
  }
}

type ListItem = { text: string; set?: (entry: YMap) => void };

/** Writes `next` into an ordered list of `{order, text}` entries with the
 * fewest changes, assuming one editor action (an edit, an insert, a removal,
 * a move): the common head and tail stay; a middle that is a permutation of
 * the current one only reorders; otherwise texts change in place and the rest
 * is inserted or removed. Returns the entry ids in the new order. */
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
    reorder(new Map(current.map((item) => [item.id, item.entry])), order);
    next.forEach((item, i) => {
      const entry = mapAt(map, order[i]);
      if (entry) item.set?.(entry);
    });
    return order;
  }
  const shared = Math.min(was.length, will.length);
  for (let i = 0; i < shared; i++) setText(was[i].entry, 'text', will[i].text);
  for (const removed of was.slice(shared)) map.delete(removed.id);
  const added = will.slice(shared);
  const after =
    shared > 0
      ? was[shared - 1].order
      : head > 0
        ? current[head - 1].order
        : null;
  const before = tail > 0 ? (current.at(-tail)?.order ?? null) : null;
  const orders = keysBetween(after, before, added.length);
  const addedIds = added.map((item, i) => {
    const id = uid(prefix);
    const entry = new Y.Map<unknown>();
    entry.set('order', orders[i]);
    entry.set('text', new Y.Text(item.text));
    map.set(id, entry);
    return id;
  });
  const order = [
    ...ids.slice(0, head + shared),
    ...addedIds,
    ...ids.slice(ids.length - tail),
  ];
  next.forEach((item, i) => {
    const entry = mapAt(map, order[i]);
    if (entry) item.set?.(entry);
  });
  return order;
}

/** A new block under a fresh id: put in place first, so the table writer
 * reads back the rows and columns it adds. */
function insertBlock(map: YMap, block: QuestionBlock, order: string) {
  const entry = new Y.Map<unknown>();
  map.set(uid('block'), entry);
  entry.set('order', order);
  entry.set('type', block.type);
  writeBlockFields(entry, block);
}

function writeTable(entry: YMap, rows: string[][]) {
  const rowMap = child(entry, 'rows');
  const columnMap = child(entry, 'columns');
  const cells = child(entry, 'cells');
  const width = Math.max(0, ...rows.map((row) => row.length));
  // Columns first: a column added or removed shifts every row alike.
  let columns = orderedKeys(columnMap);
  const rowIds = orderedKeys(rowMap);
  const cell = (row: string, column: string) => text(cells, `${row}/${column}`);
  if (columns.length !== width) {
    const current = columns.map((column) =>
      rowIds.map((row) => cell(row, column))
    );
    const wanted = Array.from({ length: width }, (_, c) =>
      rows.slice(0, rowIds.length).map((row) => row[c] ?? '')
    );
    const same = (a: string[], b: string[]) =>
      a.join('\u0000') === b.join('\u0000');
    let head = 0;
    while (
      head < current.length &&
      head < width &&
      same(current[head], wanted[head])
    )
      head++;
    let tail = 0;
    while (
      tail < current.length - head &&
      tail < width - head &&
      same(current.at(-1 - tail) ?? [], wanted[width - 1 - tail])
    )
      tail++;
    const removed = columns.slice(head, columns.length - tail);
    const keep = Math.min(removed.length, width - head - tail);
    for (const column of removed.slice(keep)) {
      columnMap.delete(column);
      for (const row of rowIds) cells.delete(`${row}/${column}`);
    }
    const count = width - head - tail - keep;
    const after = columnMap.get(columns[head + keep - 1] ?? '') as
      | string
      | undefined;
    const before =
      tail > 0 ? (columnMap.get(columns.at(-tail) ?? '') as string) : null;
    for (const order of keysBetween(
      after ?? (head > 0 ? (columnMap.get(columns[head - 1]) as string) : null),
      before,
      count
    ))
      columnMap.set(uid('col'), order);
    columns = orderedKeys(columnMap);
  }
  // Then rows, by the same head and tail rule.
  let ids = orderedKeys(rowMap);
  if (ids.length !== rows.length) {
    const current = ids.map((row) =>
      columns.map((column) => cell(row, column)).join('\u0000')
    );
    const wanted = rows.map((row) =>
      columns.map((_, c) => row[c] ?? '').join('\u0000')
    );
    let head = 0;
    while (
      head < current.length &&
      head < wanted.length &&
      current[head] === wanted[head]
    )
      head++;
    let tail = 0;
    while (
      tail < current.length - head &&
      tail < wanted.length - head &&
      current.at(-1 - tail) === wanted.at(-1 - tail)
    )
      tail++;
    const removed = ids.slice(head, ids.length - tail);
    const keep = Math.min(removed.length, wanted.length - head - tail);
    for (const row of removed.slice(keep)) {
      rowMap.delete(row);
      for (const column of columns) cells.delete(`${row}/${column}`);
    }
    const count = wanted.length - head - tail - keep;
    const afterId = ids[head + keep - 1];
    const after =
      afterId === undefined ? null : (rowMap.get(afterId) as string);
    const before =
      tail > 0 ? (rowMap.get(ids.at(-tail) ?? '') as string) : null;
    for (const order of keysBetween(after, before, count))
      rowMap.set(uid('row'), order);
    ids = orderedKeys(rowMap);
  }
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
 * values only when they differ, a chart, plot or graph as one value (D8). */
function writeBlockFields(entry: YMap, block: QuestionBlock) {
  switch (block.type) {
    case 'text':
      setText(entry, 'text', block.text);
      setPlain(entry, 'label', block.label);
      return;
    case 'table':
      setPlain(entry, 'header', block.header);
      writeTable(entry, block.rows);
      return;
    case 'image':
      setPlain(entry, 'image', block.image);
      setPlain(entry, 'width', block.width);
      setPlain(entry, 'height', block.height);
      setText(entry, 'description', block.description);
      setPlain(entry, 'attribution', block.attribution);
      return;
    case 'chart':
    case 'plot':
    case 'graph': {
      const { type: _type, ...value } = block;
      setPlain(entry, 'value', value);
      return;
    }
    default: {
      const unknown: never = block;
      const { type } = unknown as { type: string };
      throw new Error(`No writer for the question block type ${type}`);
    }
  }
}

const blockJson = (block: QuestionBlock) => JSON.stringify(block);

/** Writes a block list with the fewest changes (same rule as `writeList`). */
function writeBlocks(map: YMap, next: QuestionBlock[]) {
  const current = ordered(map).map((item) => ({
    ...item,
    block: readBlock(item.entry),
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
    reorder(new Map(current.map((item) => [item.id, item.entry])), [
      ...ids.slice(0, head),
      ...moved,
      ...ids.slice(ids.length - tail),
    ]);
    return;
  }
  const shared = Math.min(was.length, will.length);
  for (let i = 0; i < shared; i++) {
    const item = was[i];
    if (item.block?.type === will[i].type)
      writeBlockFields(item.entry, will[i]);
    else {
      map.delete(item.id);
      insertBlock(map, will[i], item.order);
    }
  }
  for (const removed of was.slice(shared)) map.delete(removed.id);
  const added = will.slice(shared);
  const after =
    shared > 0
      ? was[shared - 1].order
      : head > 0
        ? current[head - 1].order
        : null;
  const before = tail > 0 ? (current.at(-tail)?.order ?? null) : null;
  keysBetween(after, before, added.length).forEach((order, i) => {
    insertBlock(map, added[i], order);
  });
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
    case 'multi':
      ids.options = writeList(
        child(map, 'options'),
        answer.options.map((value) => ({ text: value })),
        'opt'
      );
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
    case 'mcq':
      setPlain(key, 'correct', ids.options[answer.correct[0] ?? -1]);
      break;
    case 'multi': {
      const correct = child(key, 'correct');
      const wanted = new Set(answer.correct.map((i) => ids.options[i]));
      for (const id of [...correct.keys()])
        if (!wanted.has(id)) correct.delete(id);
      for (const id of wanted)
        if (id && correct.get(id) !== true) correct.set(id, true);
      break;
    }
    case 'boolean':
      setPlain(key, 'correct', answer.correct);
      break;
    case 'short':
      list('accepted', answer.accepted, 'acc');
      break;
    case 'open':
      list('accepted', answer.accepted, 'acc');
      list('hints', answer.hints, 'hint');
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
    writeBlocks(child(entry, 'stem'), next.stem);
    const parts = child(entry, 'parts');
    const wanted = new Set(next.parts.map((part) => part.id));
    for (const id of [...parts.keys()]) if (!wanted.has(id)) parts.delete(id);
    const existing = new Map(
      ordered(parts).map((item) => [item.id, item.entry])
    );
    let last: string | null = null;
    for (const part of next.parts) {
      let map = existing.get(part.id);
      if (!map) {
        map = new Y.Map<unknown>();
        map.set('order', keyBetween(last, null));
        map.set('blocks', new Y.Map<unknown>());
        parts.set(part.id, map);
        existing.set(part.id, map);
      }
      last = plain<string>(map, 'order') ?? last;
      setPlain(map, 'marks', part.marks);
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
  const current = ordered(questions).filter((item) => item.id !== id);
  const target = Math.max(0, Math.min(index, current.length));
  const order = keyBetween(
    current[target - 1]?.order ?? null,
    current[target]?.order ?? null
  );
  content.transact(() => mapAt(questions, id)?.set('order', order), origin);
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
