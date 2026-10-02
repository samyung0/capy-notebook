import type { Question, QuestionBlock, QuestionPart } from '@/api/types';
import type {
  MaterialElement,
  MaterialNode,
  MaterialText,
  MaterialValue,
  QuizQuestionElement,
} from '@/features/materials/document';
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
  hints: string;
  marks: string;
  markscheme: string;
  question: string;
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
export const textNodes = (text: string): MaterialNode[] =>
  parseMathText(text).map((token) =>
    token.type === 'text'
      ? { text: token.value }
      : element('inline_equation', [{ text: '' }], {
          displayMode: token.type === 'display',
          texExpression: token.value,
        })
  );
export const paragraph = (text: string, props: Record<string, unknown> = {}) =>
  element('p', textNodes(text), props);
const heading = (text: string) => element('h3', [{ text }]);

export function questionBlocks(blocks: QuestionBlock[]): MaterialValue {
  return blocks.flatMap((block): MaterialValue => {
    switch (block.type) {
      case 'text':
        return [paragraph((block.label ? `${block.label} ` : '') + block.text)];
      case 'chart':
      case 'graph':
        return [element(block.type, [{ text: '' }], { block })];
      case 'image':
        return [
          element('img', [{ text: '' }], {
            caption: [{ text: block.attribution || block.description }],
            height: block.height,
            name: block.description,
            ...block.image,
            width: block.width,
          }),
        ];
      case 'table':
        return [
          element(
            'table',
            block.rows.map((row, i) =>
              element(
                'tr',
                row.map((cell) =>
                  element(block.header && i === 0 ? 'th' : 'td', [
                    paragraph(cell),
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
    case 'multi':
      return a.correct.map(
        (index) => `${String.fromCharCode(65 + index)}. ${a.options[index]}`
      );
    case 'boolean':
      return [a.correct ? labels.true : labels.false];
    case 'short':
      return a.accepted.map((answer) => answer + (a.unit ? ` ${a.unit}` : ''));
    case 'open':
      return a.accepted;
    case 'matching':
      return a.pairs.map((pair) => `${pair.left} → ${a.options[pair.right]}`);
    case 'ordering':
      return a.items.map((item, index) => `${index + 1}. ${item}`);
  }
}

function choices(part: QuestionPart, labels: ExportLabels): MaterialValue {
  const a = part.answer;
  if (a.type === 'mcq' || a.type === 'multi')
    return a.options.map((option, i) =>
      paragraph(
        `${a.type === 'multi' ? '☐' : `${String.fromCharCode(65 + i)}.`} ${option}`
      )
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
  return [paragraph(`${labels.answer}: ______________________________`)];
}

function partLabel(question: Question, index: number) {
  return question.labels === 'letters'
    ? `(${String.fromCharCode(97 + index)})`
    : `${index + 1}.`;
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
        ...question.parts.flatMap((part, j) => [
          paragraph(
            `${partLabel(question, j)} ${labels.marks}: ${part.markscheme.length}`
          ),
          ...questionBlocks(part.blocks),
          ...choices(part, labels),
        ]),
      ]);
      const key = questions.flatMap((question, i) =>
        question.parts.flatMap((part, j) => [
          paragraph(
            `${i + 1}${question.parts.length > 1 ? ` ${partLabel(question, j)}` : ''}. ${labels.answer}`,
            { exportBold: true }
          ),
          ...answerLines(part, labels).map((text) => paragraph(text)),
          paragraph(
            `${labels.markscheme} · ${labels.marks}: ${part.markscheme.length}`
          ),
          ...part.markscheme.map((text) =>
            paragraph(text, { indent: 1, listStyleType: 'disc' })
          ),
          ...(part.solution.length
            ? [
                paragraph(labels.solution, { exportBold: true }),
                ...questionBlocks(part.solution),
              ]
            : []),
          ...(part.answer.type === 'open' && part.answer.hints.length
            ? [
                paragraph(labels.hints),
                ...part.answer.hints.map((text) => paragraph(text)),
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
