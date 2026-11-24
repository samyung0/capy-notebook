import {
  QUESTION_CANVASES_MAX,
  QUESTION_MARKS_MAX,
} from '@/api/limits.generated';
import { m } from '@/i18n';
import { sameJson } from '@/lib/sameJson';
import type { FigureBinding } from './figureBinding';
import { localFigureBinding } from './localFigureBinding';
import type { BlockSection } from './QuestionView';
import type { KeptCanvas } from './typeMemory';
import {
  blankQuestion,
  canvasCount,
  type DrawnSample,
  gapNumbers,
  gapText,
  modelMarked,
  type Question,
  type QuestionAnswer,
  type QuestionBlock,
  type QuestionPart,
} from './types';
import { questionCanvases } from './validation';

/** A part turned into blanks: one answer list for each blank its text has,
 * or a sample sentence holding one when it has none; `lists` (the blanks'
 * lists the part had when it left blanks, Epo 2026-11-23) go back to its
 * blanks in order. */
function gapsAnswer(part: QuestionPart, lists: string[][]): QuestionPart {
  const blanks = gapNumbers(part.blocks).length;
  const blocks: QuestionBlock[] = blanks
    ? part.blocks
    : [
        ...part.blocks,
        {
          text: m.question_ui_gaps_sample({ blank: gapText(1) }),
          type: 'text',
        },
      ];
  return {
    ...part,
    answer: {
      accepted: Array.from(
        { length: blanks || 1 },
        (_, i) => lists[i] ?? [m.question_default_answer()]
      ),
      type: 'gaps',
    },
    blocks,
    itemAwards: undefined,
    marks: Math.min(part.marks, QUESTION_MARKS_MAX),
    markscheme: undefined,
  };
}

/** A gaps part's text turned away from blanks: the author's text stays,
 * numbered blanks and all, so lists kept for the tab match them again on the
 * way back; the untouched sample sentence goes while its blank is the only
 * one (with others, the blanks after it would no longer match their lists). */
function withoutGaps(blocks: QuestionBlock[]): QuestionBlock[] {
  if (gapNumbers(blocks).length !== 1) return blocks;
  const sample = m.question_ui_gaps_sample({ blank: gapText(1) });
  return blocks.filter(
    (block) => !(block.type === 'text' && block.text === sample)
  );
}

/** Open and canvas answers carry a marking scheme worth the part's marks;
 * closed ones drop it, and with it marks merged items took past the cap.
 * Turned away from blanks, the text keeps its words; turned into blanks, the
 * answer's lists go to the text's blanks. A part turned into a canvas part
 * keeps its canvas, else gets an empty one, unless it answers in the canvas
 * above (Epo 2026-11-23). */
export function withAnswer(
  part: QuestionPart,
  answer: QuestionAnswer
): QuestionPart {
  if (answer.type === 'gaps')
    return part.answer.type === 'gaps'
      ? { ...part, answer, itemAwards: undefined, markscheme: undefined }
      : gapsAnswer(part, answer.accepted);
  const kept =
    part.answer.type === 'gaps' ? withoutGaps(part.blocks) : part.blocks;
  const blocks =
    answer.type === 'canvas' &&
    !answer.shared &&
    !kept.some((block) => block.type === 'canvas')
      ? [...kept, { type: 'canvas' as const }]
      : kept;
  return modelMarked(answer.type)
    ? {
        ...part,
        answer,
        blocks,
        markscheme: part.markscheme ?? [
          { marks: part.marks, text: m.question_default_marking_point() },
        ],
      }
    : {
        ...part,
        answer,
        blocks,
        itemAwards: undefined,
        marks: Math.min(part.marks, QUESTION_MARKS_MAX),
        markscheme: undefined,
      };
}

/** A canvas part answering in the canvas above (Same canvas, Epo
 * 2026-11-23): `shared`, its own canvas, the first of its blocks, out of
 * them (`kept`, with its place, for the tab). */
export function answerAbove(part: QuestionPart): {
  kept?: KeptCanvas;
  part: QuestionPart;
} {
  if (part.answer.type !== 'canvas') return { part };
  const index = part.blocks.findIndex((block) => block.type === 'canvas');
  const block = part.blocks[index];
  return {
    ...(block?.type === 'canvas' && { kept: { block, index } }),
    part: {
      ...part,
      answer: { ...part.answer, shared: true },
      blocks: part.blocks.filter((_, i) => i !== index),
    },
  };
}

/** A canvas part answering on a canvas of its own (New canvas): a canvas it
 * holds already (a view-only one) becomes its own, `kept` unused; else the
 * one Same canvas took out back in its place (`kept`), else an empty one
 * after its blocks. */
export function answerOwn(part: QuestionPart, kept?: KeptCanvas): QuestionPart {
  if (part.answer.type !== 'canvas') return part;
  const { shared: _, ...answer } = part.answer;
  if (canvasCount(part.blocks)) return { ...part, answer };
  const at = Math.min(kept?.index ?? part.blocks.length, part.blocks.length);
  return {
    ...part,
    answer,
    blocks: [
      ...part.blocks.slice(0, at),
      kept?.block ?? { type: 'canvas' },
      ...part.blocks.slice(at),
    ],
  };
}

/** A plot has no editor, so it is never added empty. A canvas is added
 * empty, to the stem, a group's or a quiz part's text (Epo 2026-11-23), and
 * comes with a part turned into a canvas part (`withAnswer`). */
export type AddableBlock = Exclude<QuestionBlock['type'], 'plot'>;

export function newQuestionBlock(type: AddableBlock): QuestionBlock {
  switch (type) {
    case 'canvas':
      return { type };
    case 'text':
      // Empty, its placeholder showing (Epo 2026-11-16): empty text is
      // dropped before a question is checked, so it is never an issue.
      return { text: '', type };
    case 'chart':
      return {
        kind: 'bar',
        labels: [''],
        series: [{ name: '', values: [null] }],
        title: '',
        type,
      };
    case 'graph':
      return {
        board: { axis: true, bbox: [-7.5, 5, 7.5, -5], grid: false },
        description: '',
        // A new graph starts drawing y = x (Epo 2026-10-26).
        elements: [
          { id: crypto.randomUUID(), latex: 'y=x', type: 'expression' },
        ],
        height: 400,
        type,
        width: 600,
      };
    case 'table':
      return {
        header: true,
        rows: [
          ['', ''],
          ['', ''],
        ],
        type,
      };
    case 'image':
      return { description: '', height: 1, image: { url: '' }, type, width: 1 };
  }
}

/** The blocks a section of the question holds: the stem, a group's, or a
 * part's text or worked solution. */
export function sectionBlocks(
  question: Question,
  section: BlockSection
): QuestionBlock[] {
  if (section.groupId)
    return (
      question.groups?.find((group) => group.id === section.groupId)?.blocks ??
      []
    );
  return section.partId
    ? (question.parts.find((part) => part.id === section.partId)?.[
        section.solution ? 'solution' : 'blocks'
      ] ?? [])
    : question.stem;
}

export function changeBlocks(
  question: Question,
  section: BlockSection,
  blocks: QuestionBlock[]
): Question {
  if (section.groupId)
    return {
      ...question,
      groups: question.groups?.map((group) =>
        group.id === section.groupId ? { ...group, blocks } : group
      ),
    };
  return section.partId
    ? {
        ...question,
        parts: question.parts.map((part) =>
          part.id === section.partId
            ? { ...part, [section.solution ? 'solution' : 'blocks']: blocks }
            : part
        ),
      }
    : { ...question, stem: blocks };
}

/** Where a live quiz's figure sits: its room entry in a question's section. */
export type FigureAt = {
  entry: string;
  question: string;
  section: BlockSection;
};

/** A live quiz's figures by their room entries (Epo 2026-11-16, D2): a block
 * read from the room knows its entry's key, and a figure dialog writes that
 * entry (a chart or graph each change as it is made, a table at its Save) and
 * removes it, so a figure a co-editor changed meanwhile stays one figure. A
 * draft (the bank's question dialog) has none: its figures save by place
 * ([saveFigure]). */
export type FigureRoom = {
  /** The figure at `at` as a chart or graph dialog edits it, live. */
  bind(at: FigureAt): FigureBinding;
  /** A new figure after the block keyed `after`, else (none, or a key that
   * went) at `index`; its entry key, or none when the section went or holds
   * its one canvas already. */
  insert(
    place: {
      after?: string;
      index: number;
      question: string;
      section: BlockSection;
    },
    block: QuestionBlock
  ): string | null;
  /** The entry a block was read from; none for one not read from the room. */
  key(block: QuestionBlock): string | undefined;
  remove(at: FigureAt): boolean;
  /** Writes only what differs; false when the figure is gone. */
  replace(at: FigureAt, block: QuestionBlock): boolean;
};

/** Where an equal block sits now, the one nearest `near` (its place when the
 * dialog opened); -1 when it is gone. A draft's blocks have no ids, and its
 * figure is found by content. */
export function findBlock(
  blocks: QuestionBlock[],
  block: QuestionBlock | undefined,
  near: number
) {
  if (!block) return -1;
  const json = JSON.stringify(block);
  let found = -1;
  blocks.forEach((item, i) => {
    if (
      JSON.stringify(item) === json &&
      (found < 0 || Math.abs(i - near) < Math.abs(found - near))
    )
      found = i;
  });
  return found;
}

/** The section's blocks with the dialog's figure saved: in place of the
 * figure as it was when the dialog opened, or for a new figure (or one gone
 * meanwhile) after the block that came before it, never over another block. */
export function saveFigure(
  blocks: QuestionBlock[],
  figure: {
    before?: QuestionBlock;
    block: QuestionBlock;
    index: number;
    isNew?: boolean;
  },
  block: QuestionBlock
) {
  const at = figure.isNew ? -1 : findBlock(blocks, figure.block, figure.index);
  if (at >= 0) return blocks.map((item, i) => (i === at ? block : item));
  const before = findBlock(blocks, figure.before, figure.index - 1);
  const place =
    before >= 0 ? before + 1 : Math.min(figure.index, blocks.length);
  return [...blocks.slice(0, place), block, ...blocks.slice(place)];
}

/** A figure as its card opens it: its block, place and the block before it
 * then; `isNew` when just added from Insert. */
export type FigureOpening = {
  before?: QuestionBlock;
  block: QuestionBlock;
  index: number;
  isNew?: boolean;
  section: BlockSection;
};

/** A chart's or graph's dialog bound to the figure where it lives (Epo
 * 2026-11-16, D2/D3/D13): a live quiz's room entry, or the question draft the
 * card writes through `writeBlocks`, each change written as it is made. A
 * figure just added goes in first, where Insert put it, so the dialog has it
 * to edit and Remove takes it out. Its place in the section (a draft's
 * figure is found by content near it); none when the section or the figure
 * went. */
export function bindFigure(
  opened: FigureOpening,
  {
    figures,
    question,
    writeBlocks,
  }: {
    figures?: FigureRoom;
    question: string;
    writeBlocks: (
      section: BlockSection,
      change: (blocks: QuestionBlock[]) => QuestionBlock[]
    ) => Question;
  }
): { binding: FigureBinding; index: number } | null {
  const { block, section } = opened;
  if (block.type !== 'chart' && block.type !== 'graph')
    throw new Error('Only charts and graphs are edited live');
  if (figures) {
    const entry = opened.isNew
      ? figures.insert(
          {
            after: opened.before && figures.key(opened.before),
            index: opened.index,
            question,
            section,
          },
          block
        )
      : figures.key(block);
    return entry
      ? {
          binding: figures.bind({ entry, question, section }),
          index: opened.index,
        }
      : null;
  }
  const index = opened.isNew
    ? sectionBlocks(
        writeBlocks(section, (blocks) => saveFigure(blocks, opened, block)),
        section
      ).indexOf(block)
    : opened.index;
  return {
    binding: localFigureBinding(block, {
      remove: (held) =>
        writeBlocks(section, (blocks) => {
          const at = findBlock(blocks, held, index);
          return at < 0 ? blocks : blocks.filter((_, i) => i !== at);
        }),
      write: (next, previous) =>
        writeBlocks(section, (blocks) =>
          saveFigure(
            blocks,
            { before: opened.before, block: previous, index },
            next
          )
        ),
    }),
    index,
  };
}

/** A new part: a short answer with an empty text. */
export const newPart = () => blankQuestion().parts[0];

/** Whether a part is still as `newPart()` made it, in a group or not (Epo
 * 2026-11-24): what Add part or Add sub-part kept goes back only into one. */
export function isBlankPart(part: QuestionPart): boolean {
  const { group: _group, id: _id, ...held } = part;
  const { id: _new, ...blank } = newPart();
  return sameJson(held, blank);
}

/** The question with part `partId`'s drawn sample, just brought back, held
 * off while it takes the question past QUESTION_CANVASES_MAX, a sample being
 * one of its canvases (Epo 2026-11-24: a kept sample stays in the tab's
 * memory at the cap, on a type switch and on a part left alone alike);
 * `held` is that sample, for the tab to keep. */
export function sampleWithinCap(
  question: Question,
  partId: string
): { held?: DrawnSample; question: Question } {
  const part = question.parts.find((item) => item.id === partId);
  if (
    part?.answer.type !== 'canvas' ||
    !part.answer.sample ||
    questionCanvases(question) <= QUESTION_CANVASES_MAX
  )
    return { question };
  const { sample, ...answer } = part.answer;
  return {
    held: sample,
    question: {
      ...question,
      parts: question.parts.map((item) =>
        item.id === partId ? { ...part, answer } : item
      ),
    },
  };
}

/** The question as a new one beside it (the card's Duplicate): fresh ids for
 * it, its parts and its groups; images and drawn samples keep their assets. */
export function duplicateQuestion(question: Question): Question {
  const groupIds = new Map(
    question.groups?.map((group) => [group.id, crypto.randomUUID()])
  );
  return {
    ...structuredClone(question),
    ...(question.groups && {
      groups: question.groups.map((group) => ({
        ...structuredClone(group),
        id: groupIds.get(group.id) ?? crypto.randomUUID(),
      })),
    }),
    id: crypto.randomUUID(),
    parts: question.parts.map((part) => ({
      ...structuredClone(part),
      id: crypto.randomUUID(),
      ...(part.group && { group: groupIds.get(part.group) }),
    })),
  };
}
