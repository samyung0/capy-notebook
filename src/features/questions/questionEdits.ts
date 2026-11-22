import { QUESTION_MARKS_MAX } from '@/api/limits.generated';
import { m } from '@/i18n';
import type { FigureBinding } from './figureBinding';
import { localFigureBinding } from './localFigureBinding';
import type { BlockSection } from './QuestionView';
import {
  blankQuestion,
  GAP_MARKER,
  gapNumbers,
  gapText,
  modelMarked,
  type Question,
  type QuestionAnswer,
  type QuestionBlock,
  type QuestionPart,
} from './types';

/** A part turned into blanks: one answer list for each blank its text has,
 * or a sample sentence holding one when it has none. */
function gapsAnswer(part: QuestionPart): QuestionPart {
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
      accepted: Array.from({ length: blanks || 1 }, () => [
        m.question_default_answer(),
      ]),
      type: 'gaps',
    },
    blocks,
    itemAwards: undefined,
    marks: Math.min(part.marks, QUESTION_MARKS_MAX),
    markscheme: undefined,
  };
}

/** A gaps part's text turned away from blanks: the author's text stays, each
 * numbered blank a plain line; the untouched sample sentence goes. */
function withoutGaps(blocks: QuestionBlock[]): QuestionBlock[] {
  const sample = m.question_ui_gaps_sample({ blank: gapText(1) });
  return blocks.flatMap((block): QuestionBlock[] => {
    if (block.type !== 'text') return [block];
    if (block.text === sample) return [];
    return [{ ...block, text: block.text.replace(GAP_MARKER, '______') }];
  });
}

/** Open and drawing answers carry a marking scheme worth the part's marks;
 * closed ones drop it, and with it marks merged items took past the cap.
 * Turned away from blanks, the text keeps its words. */
export function withAnswer(
  part: QuestionPart,
  answer: QuestionAnswer
): QuestionPart {
  if (answer.type === 'gaps')
    return part.answer.type === 'gaps'
      ? { ...part, answer, itemAwards: undefined, markscheme: undefined }
      : gapsAnswer(part);
  const blocks =
    part.answer.type === 'gaps' ? withoutGaps(part.blocks) : part.blocks;
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

/** A plot has no editor, so it is never added empty. */
export type AddableBlock = Exclude<QuestionBlock['type'], 'plot'>;

export function newQuestionBlock(type: AddableBlock): QuestionBlock {
  switch (type) {
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
   * went) at `index`; its entry key, or none when the section went. */
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
