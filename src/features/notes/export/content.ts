import type { QuestionBlock, QuestionPart } from '@/api/types';
import type {
  MaterialElement,
  MaterialNode,
  MaterialText,
  MaterialValue,
  QuizQuestionElement,
} from '@/features/materials/document';
import {
  fullPartLabel,
  isLonePart,
  questionItems,
} from '@/features/questions/groups';
import { parseMarkedText } from '@/features/questions/parseMarkedText';
import { parseMathText } from '@/features/questions/parseMathText';

export interface ExportLabels {
  answer: string;
  answerKey: string;
  back: string;
  callouts: Record<string, string>;
  card: string;
  choices: string;
  column: string;
  false: string;
  front: string;
  interactive: string;
  marks: string;
  markscheme: string;
  question: string;
  /** The heading of a long answer's sample answer, after the scheme. */
  sample: string;
  solution: string;
  true: string;
  video: string;
}

export const isText = (node: MaterialNode): node is MaterialText =>
  typeof node.text === 'string';
export const plain = (node: MaterialNode): string =>
  isText(node) ? node.text : node.children.map(plain).join('');
export const element = (
  type: string,
  children: MaterialNode[],
  props: Record<string, unknown> = {}
): MaterialElement => ({ children, type, ...props });
/** A question string's text and formulas; `marks` also reads the bold,
 * italic and underline markers of text blocks and table cells. */
export const textNodes = (text: string, marks = false): MaterialNode[] =>
  (marks ? parseMarkedText(text) : parseMathText(text)).map(
    ({ type, value, ...rest }) =>
      type === 'text'
        ? { text: value, ...rest }
        : element('inline_equation', [{ text: '' }], {
            displayMode: type === 'display',
            texExpression: value,
          })
  );
export const paragraph = (text: string, props: Record<string, unknown> = {}) =>
  element('p', textNodes(text), props);
const markedParagraph = (text: string) => element('p', textNodes(text, true));
const heading = (text: string) => element('h3', [{ text }]);

export function questionBlocks(blocks: QuestionBlock[]): MaterialValue {
  return blocks.flatMap((block): MaterialValue => {
    switch (block.type) {
      case 'text':
        return [markedParagraph(block.text)];
      case 'chart':
      case 'plot':
      case 'graph':
        return [element(block.type, [{ text: '' }], { block })];
      case 'image':
        return [
          element('img', [{ text: '' }], {
            caption: [{ text: block.attribution || block.description || '' }],
            height: block.height,
            name: block.description ?? '',
            ...block.image,
            width: block.width,
          }),
        ];
      // A drawn canvas prints its picture; an empty one prints nothing.
      case 'canvas':
        return 'board' in block
          ? [
              element('img', [{ text: '' }], {
                assetId: block.image,
                caption: [{ text: '' }],
                name: '',
              }),
            ]
          : [];
      case 'table':
        return [
          element(
            'table',
            block.rows.map((row, i) =>
              element(
                'tr',
                row.map((cell) =>
                  element(block.header && i === 0 ? 'th' : 'td', [
                    markedParagraph(cell),
                  ])
                )
              )
            )
          ),
        ];
    }
    throw new Error('Unsupported question block.');
  });
}

function answerLines(part: QuestionPart, labels: ExportLabels): string[] {
  const a = part.answer;
  switch (a.type) {
    case 'mcq':
      return a.correct.map(
        (index) => `${String.fromCharCode(65 + index)}. ${a.options[index]}`
      );
    case 'boolean':
      return [a.correct ? labels.true : labels.false];
    case 'short':
      return a.accepted.map((answer) => answer + (a.unit ? ` ${a.unit}` : ''));
    // Its sample answer has its own section (Epo 2026-11-15).
    case 'open':
      return [];
    case 'canvas':
      return [];
    case 'matching':
      return a.pairs.map((pair) => `${pair.left} → ${a.options[pair.right]}`);
    case 'ordering':
      return a.items.map((item, index) => `${index + 1}. ${item}`);
    case 'gaps':
      return a.accepted.map(
        (accepted, index) => `(${index + 1}) ${accepted.join(' / ')}`
      );
  }
}

function choices(part: QuestionPart, labels: ExportLabels): MaterialValue {
  const a = part.answer;
  if (a.type === 'mcq')
    return a.options.map((option, i) =>
      paragraph(`${String.fromCharCode(65 + i)}. ${option}`)
    );
  if (a.type === 'boolean')
    return [paragraph(`☐ ${labels.true}    ☐ ${labels.false}`)];
  if (a.type === 'matching')
    return [
      ...a.pairs.map((pair, i) => paragraph(`${i + 1}. ${pair.left}`)),
      paragraph(labels.choices, { exportBold: true }),
      ...a.options.map((option, i) =>
        paragraph(`${String.fromCharCode(65 + i)}. ${option}`)
      ),
    ];
  // The stored ordering is the answer. Present an alphabetic pool separately.
  if (a.type === 'ordering')
    return [...a.items]
      .sort()
      .map((item) => paragraph(item, { indent: 1, listStyleType: 'disc' }));
  if (a.type === 'gaps')
    return a.accepted.map((_, i) =>
      paragraph(`(${i + 1}) ______________________________`)
    );
  return [paragraph(`${labels.answer}: ______________________________`)];
}

/** One readable study handout representation for both serializers. */
export function flattenStudyBlocks(
  value: MaterialValue,
  labels: ExportLabels
): MaterialValue {
  return value.flatMap((node): MaterialValue => {
    if (node.type === 'material_ref')
      throw new Error(
        'An embedded study material is unavailable or still being created.'
      );
    if (node.type === 'quiz') {
      const questions = node.children
        .filter(
          (child): child is QuizQuestionElement =>
            'type' in child && child.type === 'quiz_question'
        )
        .map((child) => child.question);
      const prompts = questions.flatMap((question, i) => [
        heading(`${labels.question} ${i + 1}`),
        ...questionBlocks(question.stem),
        ...questionItems(question).flatMap((item) => {
          const part = (row: { label: string; part: QuestionPart }) => [
            paragraph(`${row.label} ${labels.marks}: ${row.part.marks}`),
            ...questionBlocks(row.part.blocks),
            ...choices(row.part, labels),
          ];
          return item.kind === 'part'
            ? part(item)
            : // A group has text and figures, no marks of its own.
              [
                paragraph(item.label),
                ...questionBlocks(item.group.blocks),
                ...item.parts.flatMap(part),
              ];
        }),
      ]);
      const key = questions.flatMap((question, i) =>
        question.parts.flatMap((part) => [
          paragraph(
            `${i + 1}${isLonePart(question) ? '' : ` ${fullPartLabel(question, part.id)}`}. ${labels.answer}`,
            { exportBold: true }
          ),
          ...answerLines(part, labels).map((text) => paragraph(text)),
          paragraph(`${labels.marks}: ${part.marks}`),
          ...(part.markscheme
            ? [
                paragraph(labels.markscheme, { exportBold: true }),
                ...part.markscheme.map((item) =>
                  paragraph(`${item.text} [${item.marks}]`, {
                    indent: 1,
                    listStyleType: 'disc',
                  })
                ),
              ]
            : []),
          // A drawn sample has no text to export.
          ...(part.answer.type === 'open' && part.answer.accepted[0]
            ? [
                paragraph(labels.sample, { exportBold: true }),
                markedParagraph(part.answer.accepted[0]),
              ]
            : []),
          ...(part.solution.length
            ? [
                paragraph(labels.solution, { exportBold: true }),
                ...questionBlocks(part.solution),
              ]
            : []),
        ])
      );
      return [...prompts, heading(labels.answerKey), ...key];
    }
    if (node.type === 'flashcards')
      return node.children.flatMap((card, i) => {
        if (isText(card) || card.children.length !== 2)
          throw new Error('Invalid flashcard.');
        return [
          heading(`${labels.card} ${i + 1}`),
          paragraph(`${labels.front}: ${plain(card.children[0])}`),
          paragraph(`${labels.back}: ${plain(card.children[1])}`),
        ];
      });
    return [
      {
        ...node,
        children: node.children.flatMap<MaterialNode>((child) =>
          isText(child) ? [child] : flattenStudyBlocks([child], labels)
        ),
      },
    ];
  });
}
