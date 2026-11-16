import { m } from '@/i18n';
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
 * closed ones drop it. Turned away from blanks, the text keeps its words. */
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
    : { ...part, answer, blocks, itemAwards: undefined, markscheme: undefined };
}

/** A plot has no editor, so it is never added empty. */
export type AddableBlock = Exclude<QuestionBlock['type'], 'plot'>;

export function newQuestionBlock(type: AddableBlock): QuestionBlock {
  switch (type) {
    case 'text':
      return { text: m.question_default_text(), type };
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
          { id: crypto.randomUUID(), term: 'x', type: 'functiongraph' },
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

/** Where an equal block sits now, the one nearest `near` (its place when the
 * dialog opened); -1 when it is gone. Blocks have no ids, and a co-editor may
 * add, move or remove blocks while a figure's dialog is open. */
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
