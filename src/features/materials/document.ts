import type {
  ChoiceQuestion,
  CognitiveLevel,
  OrderingQuestion,
  Question,
  QuestionType,
} from '@/api/types';
import { uid } from '@/lib/id';
import {
  type FlashcardContent,
  parseFlashcardsFenceBody,
  parseQuizFenceBody,
  type QuizBlock,
} from './blocks';

export const MATERIAL_SCHEMA_VERSION = 1 as const;

export const MATERIAL_DOCUMENT_LIMITS = {
  maxContentBytes: 2 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 10_000,
} as const;

export interface MaterialDocumentMetrics {
  maxDepth: number;
  nodeCount: number;
}

export interface MaterialText {
  text: string;
  [mark: string]: unknown;
}

export interface MaterialElement {
  children: MaterialNode[];
  type: string;
  [property: string]: unknown;
}

export type MaterialNode = MaterialElement | MaterialText;
export type MaterialValue = MaterialElement[];

export interface MaterialDocument {
  schemaVersion: typeof MATERIAL_SCHEMA_VERSION;
  value: MaterialValue;
}

export interface QuizPromptElement extends MaterialElement {
  children: MaterialText[];
  type: 'quiz_prompt';
}

export interface QuizOptionElement extends MaterialElement {
  children: MaterialText[];
  id: string;
  type: 'quiz_option';
}

export interface QuizExplanationElement extends MaterialElement {
  children: MaterialText[];
  type: 'quiz_explanation';
}

export interface QuizQuestionElement extends MaterialElement {
  acceptedAnswers?: string[];
  children: (QuizPromptElement | QuizOptionElement | QuizExplanationElement)[];
  correctBoolean?: boolean;
  correctOptionIds?: string[];
  id: string;
  level: CognitiveLevel;
  pairs?: { left: string; right: string }[];
  questionType: QuestionType;
  type: 'quiz_question';
}

export interface QuizElement extends MaterialElement {
  children: QuizQuestionElement[];
  id: string;
  timeLimitMin?: number;
  type: 'quiz';
}

export interface FlashcardFaceElement extends MaterialElement {
  children: MaterialText[];
  type: 'flashcard_front' | 'flashcard_back';
}

export interface FlashcardElement extends MaterialElement {
  children: [FlashcardFaceElement, FlashcardFaceElement];
  id: string;
  type: 'flashcard';
}

export interface FlashcardsElement extends MaterialElement {
  children: FlashcardElement[];
  id: string;
  type: 'flashcards';
}

export interface MermaidCaptionElement extends MaterialElement {
  children: MaterialText[];
  type: 'mermaid_caption';
}

export interface MermaidElement extends MaterialElement {
  children: [MermaidCaptionElement];
  id: string;
  source: string;
  type: 'mermaid';
}

export type CustomMaterialElement =
  | QuizElement
  | QuizQuestionElement
  | QuizPromptElement
  | QuizOptionElement
  | QuizExplanationElement
  | FlashcardsElement
  | FlashcardElement
  | FlashcardFaceElement
  | MermaidElement
  | MermaidCaptionElement;

const CUSTOM_TYPES = new Set([
  'quiz',
  'quiz_question',
  'quiz_prompt',
  'quiz_option',
  'quiz_explanation',
  'flashcards',
  'flashcard',
  'flashcard_front',
  'flashcard_back',
  'mermaid',
  'mermaid_caption',
]);
const MEDIA_TYPES = new Set(['img', 'image', 'audio', 'video', 'file']);
const QUESTION_TYPES = new Set<QuestionType>([
  'mcq',
  'multi',
  'boolean',
  'fill',
  'short',
  'matching',
  'ordering',
]);
const COGNITIVE_LEVELS = new Set<CognitiveLevel>([
  'recall',
  'application',
  'analysis',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTextNode(value: unknown): value is MaterialText {
  return (
    isRecord(value) && typeof value.text === 'string' && !('children' in value)
  );
}

/** Shallow shape check only. Deep validation lives in `isMaterialNode`, which
 * owns the recursion so every node is visited exactly once. (A previous
 * version recursed here *and* in `isMaterialNode`, making validation cost grow
 * exponentially with nesting depth.) The "every element contains a text
 * descendant" invariant is implied by recursion: children must be non-empty
 * and each valid child is either a text leaf or an element that (inductively)
 * contains one. */
function isElementNode(value: unknown): value is MaterialElement {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    Array.isArray(value.children) &&
    value.children.length > 0
  );
}

function hasId(value: MaterialElement): boolean {
  return typeof value.id === 'string' && value.id.length > 0;
}

function validateCustomElement(element: MaterialElement): boolean {
  switch (element.type) {
    case 'quiz':
      return (
        hasId(element) &&
        (element.timeLimitMin == null ||
          (typeof element.timeLimitMin === 'number' &&
            element.timeLimitMin > 0)) &&
        element.children.length > 0 &&
        element.children.every(
          (child) => isElementNode(child) && child.type === 'quiz_question'
        )
      );
    case 'quiz_question': {
      const question = element as QuizQuestionElement;
      return (
        hasId(element) &&
        QUESTION_TYPES.has(question.questionType) &&
        COGNITIVE_LEVELS.has(question.level) &&
        element.children.every(
          (child) =>
            isElementNode(child) &&
            ['quiz_prompt', 'quiz_option', 'quiz_explanation'].includes(
              child.type
            )
        ) &&
        element.children.some(
          (child) => isElementNode(child) && child.type === 'quiz_prompt'
        )
      );
    }
    case 'quiz_option':
      return hasId(element) && element.children.every(isTextNode);
    case 'flashcard':
      return (
        hasId(element) &&
        element.children.length === 2 &&
        isElementNode(element.children[0]) &&
        element.children[0].type === 'flashcard_front' &&
        isElementNode(element.children[1]) &&
        element.children[1].type === 'flashcard_back'
      );
    case 'quiz_prompt':
    case 'quiz_explanation':
    case 'flashcard_front':
    case 'flashcard_back':
    case 'mermaid_caption':
      return element.children.every(isTextNode);
    case 'flashcards':
      return (
        hasId(element) &&
        element.children.length > 0 &&
        element.children.every(
          (child) => isElementNode(child) && child.type === 'flashcard'
        )
      );
    case 'mermaid':
      return (
        hasId(element) &&
        typeof element.source === 'string' &&
        element.children.length === 1 &&
        isElementNode(element.children[0]) &&
        element.children[0].type === 'mermaid_caption'
      );
    default:
      return true;
  }
}

function validateMediaElement(element: MaterialElement): boolean {
  if (!MEDIA_TYPES.has(element.type)) return true;
  return (
    typeof element.assetId === 'string' &&
    element.assetId.length > 0 &&
    element.url == null &&
    element.src == null
  );
}

export function isMaterialNode(value: unknown): value is MaterialNode {
  if (isTextNode(value)) return true;
  if (!isElementNode(value)) return false;
  if (!value.children.every(isMaterialNode)) return false;
  if (!validateMediaElement(value)) return false;
  return !CUSTOM_TYPES.has(value.type) || validateCustomElement(value);
}

export function isMaterialDocument(value: unknown): value is MaterialDocument {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === MATERIAL_SCHEMA_VERSION &&
    Array.isArray(value.value) &&
    value.value.length > 0 &&
    value.value.every((node) => isElementNode(node) && isMaterialNode(node))
  );
}

function parseMaterialDocumentInput(input: unknown): MaterialDocument | null {
  let candidate = input;
  if (typeof input === 'string') {
    try {
      candidate = JSON.parse(input);
    } catch {
      return null;
    }
  }
  return isMaterialDocument(candidate) ? candidate : null;
}

export function parseMaterialDocumentWithMetrics(
  input: unknown
): { document: MaterialDocument; metrics: MaterialDocumentMetrics } | null {
  const candidate = parseMaterialDocumentInput(input);
  if (!candidate) return null;
  const normalized = normalizeMaterialValueWithMetrics(candidate.value);
  return {
    document: {
      ...candidate,
      value: normalized.value,
    },
    metrics: normalized.metrics,
  };
}

export function parseMaterialDocument(input: unknown): MaterialDocument | null {
  const candidate = parseMaterialDocumentInput(input);
  if (!candidate) return null;
  return {
    ...candidate,
    value: normalizeMaterialValue(candidate.value),
  };
}

export function assertMaterialDocument(input: unknown): MaterialDocument {
  const document = parseMaterialDocument(input);
  if (!document) throw new Error('Invalid or unsupported material document');
  return document;
}

export function createMaterialDocumentWithMetrics(value: MaterialValue): {
  document: MaterialDocument;
  metrics: MaterialDocumentMetrics;
} {
  const normalized = normalizeMaterialValueWithMetrics(value);
  const document: MaterialDocument = {
    schemaVersion: MATERIAL_SCHEMA_VERSION,
    value: normalized.value,
  };
  if (!isMaterialDocument(document))
    throw new Error('Invalid or unsupported material document');
  return { document, metrics: normalized.metrics };
}

export function createMaterialDocument(value: MaterialValue): MaterialDocument {
  const document: MaterialDocument = {
    schemaVersion: MATERIAL_SCHEMA_VERSION,
    value: normalizeMaterialValue(value),
  };
  if (!isMaterialDocument(document))
    throw new Error('Invalid or unsupported material document');
  return document;
}

/** Ensure every Plate element has a stable id and top-level ids are unique.
 * Runtime comment marks are decorations backed by relational discussions, so
 * they are deliberately omitted from persisted material snapshots. Every node
 * is copied because Slate mutates `editor.children` in place. */
function normalizeMaterialValueInternal(
  value: MaterialValue,
  metrics?: MaterialDocumentMetrics
): MaterialValue {
  const topLevelIds = new Set<string>();

  const normalizeNode = (node: MaterialNode, depth: number): MaterialNode => {
    if (metrics) {
      metrics.nodeCount += 1;
      metrics.maxDepth = Math.max(metrics.maxDepth, depth);
    }

    if ('text' in node) {
      const normalized: MaterialText = {
        text: typeof node.text === 'string' ? node.text : '',
      };
      for (const [key, mark] of Object.entries(node)) {
        if (key === 'text' || key === 'comment' || key.startsWith('comment_')) {
          continue;
        }
        normalized[key] = mark;
      }
      return normalized;
    }

    const currentId =
      typeof node.id === 'string' && node.id.trim() ? node.id : undefined;
    const id =
      depth === 0 && currentId && topLevelIds.has(currentId)
        ? uid('block')
        : (currentId ?? uid('block'));
    if (depth === 0) topLevelIds.add(id);

    return {
      ...node,
      children: node.children.map((child) => normalizeNode(child, depth + 1)),
      id,
    };
  };

  return value.map((node) => normalizeNode(node, 0) as MaterialElement);
}

export function normalizeMaterialValueWithMetrics(value: MaterialValue): {
  value: MaterialValue;
  metrics: MaterialDocumentMetrics;
} {
  const metrics: MaterialDocumentMetrics = {
    maxDepth: 0,
    nodeCount: 0,
  };
  return {
    metrics,
    value: normalizeMaterialValueInternal(value, metrics),
  };
}

export function normalizeMaterialValue(value: MaterialValue): MaterialValue {
  return normalizeMaterialValueInternal(value);
}

/** Read-only node count and depth. Unlike the normalize walk this allocates
 * nothing, so it is cheap enough to run against live editor content on a
 * throttled cadence for the document-stats footer. */
export function countMaterialMetrics(
  value: MaterialValue
): MaterialDocumentMetrics {
  const metrics: MaterialDocumentMetrics = { maxDepth: 0, nodeCount: 0 };
  const visit = (node: MaterialNode, depth: number) => {
    metrics.nodeCount += 1;
    if (depth > metrics.maxDepth) metrics.maxDepth = depth;
    if ('text' in node) return;
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const node of value) visit(node, 0);
  return metrics;
}

export function emptyMaterialDocument(): MaterialDocument {
  return createMaterialDocument([{ children: [{ text: '' }], type: 'p' }]);
}

export function serializeMaterialDocument(document: MaterialDocument): string {
  return JSON.stringify(assertMaterialDocument(document));
}

function textElement<T extends string>(type: T, text: string): MaterialElement {
  return { children: [{ text }], type };
}

function optionId(questionId: string, index: number): string {
  return `${questionId}:option:${index + 1}`;
}

function questionOptions(question: Question): {
  options: QuizOptionElement[];
  correctOptionIds?: string[];
} {
  if (question.type === 'mcq' || question.type === 'multi') {
    const choice = question as ChoiceQuestion;
    const options = choice.options.map((option, index) => ({
      ...(textElement('quiz_option', option.value) as QuizOptionElement),
      explanation: option.explanation,
      id: optionId(question.id, index),
    }));
    return {
      correctOptionIds: choice.correct
        .map((index) => options[index]?.id)
        .filter((id): id is string => Boolean(id)),
      options,
    };
  }
  if (question.type === 'boolean') {
    const options = ['True', 'False'].map((text, index) => ({
      ...(textElement('quiz_option', text) as QuizOptionElement),
      id: optionId(question.id, index),
    }));
    return {
      correctOptionIds: [options[question.correct ? 0 : 1].id],
      options,
    };
  }
  if (question.type === 'fill' || question.type === 'short') {
    return {
      options: question.accepted.map((answer, index) => ({
        ...(textElement('quiz_option', answer.value) as QuizOptionElement),
        id: optionId(question.id, index),
        role: 'accepted-answer',
      })),
    };
  }
  if (question.type === 'matching') {
    return {
      options: question.pairs.map((pair, index) => ({
        ...(textElement(
          'quiz_option',
          `${pair.left} → ${pair.right}`
        ) as QuizOptionElement),
        id: optionId(question.id, index),
        role: 'matching-pair',
      })),
    };
  }
  const ordering = question as OrderingQuestion;
  return {
    options: ordering.items.map((item, index) => ({
      ...(textElement('quiz_option', item.value) as QuizOptionElement),
      id: optionId(question.id, index),
      role: 'ordering-item',
    })),
  };
}

export function quizQuestionNode(question: Question): QuizQuestionElement {
  const { options, correctOptionIds } = questionOptions(question);
  const children: QuizQuestionElement['children'] = [
    textElement('quiz_prompt', question.prompt) as QuizPromptElement,
    ...options,
  ];
  if (question.explanation) {
    children.push(
      textElement(
        'quiz_explanation',
        question.explanation
      ) as QuizExplanationElement
    );
  }

  const node: QuizQuestionElement = {
    children,
    id: question.id || uid('question'),
    level: question.level,
    questionType: question.type,
    type: 'quiz_question',
  };
  if (correctOptionIds?.length) node.correctOptionIds = correctOptionIds;
  if (question.type === 'boolean') node.correctBoolean = question.correct;
  if (question.type === 'fill' || question.type === 'short') {
    node.acceptedAnswers = question.accepted.map((answer) => answer.value);
  }
  if (question.type === 'matching') node.pairs = question.pairs;
  return node;
}

export function quizNode(data: QuizBlock, id = uid('quiz')): QuizElement {
  const questions = data.questions.map(quizQuestionNode);
  if (!questions.length) {
    questions.push(
      quizQuestionNode({
        correct: [0],
        id: uid('question'),
        level: 'recall',
        options: [{ value: '' }],
        prompt: '',
        type: 'mcq',
      })
    );
  }
  return {
    id,
    type: 'quiz',
    ...(data.timeLimitMin == null ? {} : { timeLimitMin: data.timeLimitMin }),
    children: questions,
  };
}

export function quizNodeFromFence(code: string, id?: string): QuizElement {
  return quizNode(parseQuizFenceBody(code), id);
}

export function flashcardsNode(
  cards: FlashcardContent[],
  id = uid('flashcards')
): FlashcardsElement {
  const cardNodes = cards.map<FlashcardElement>((card) => ({
    children: [
      textElement('flashcard_front', card.front) as FlashcardFaceElement,
      textElement('flashcard_back', card.back) as FlashcardFaceElement,
    ],
    id: card.id || uid('card'),
    type: 'flashcard',
  }));
  if (!cardNodes.length) {
    cardNodes.push({
      children: [
        textElement('flashcard_front', '') as FlashcardFaceElement,
        textElement('flashcard_back', '') as FlashcardFaceElement,
      ],
      id: uid('card'),
      type: 'flashcard',
    });
  }
  return { children: cardNodes, id, type: 'flashcards' };
}

export function flashcardsNodeFromFence(
  code: string,
  id?: string
): FlashcardsElement {
  return flashcardsNode(parseFlashcardsFenceBody(code).cards, id);
}

export function mermaidNode(
  source: string,
  caption = '',
  id = uid('mermaid')
): MermaidElement {
  return {
    children: [
      textElement('mermaid_caption', caption) as MermaidCaptionElement,
    ],
    id,
    source,
    type: 'mermaid',
  };
}

function nodeText(node: MaterialNode): string {
  if ('text' in node) return typeof node.text === 'string' ? node.text : '';
  return node.children.map(nodeText).join('');
}

export function quizElementToBlock(element: QuizElement): QuizBlock {
  const questions: Question[] = element.children.map((question) => {
    const prompt =
      question.children
        .find((child) => child.type === 'quiz_prompt')
        ?.children.map(nodeText)
        .join('') ?? '';
    const explanation = question.children
      .find((child) => child.type === 'quiz_explanation')
      ?.children.map(nodeText)
      .join('');
    const options = question.children.filter(
      (child): child is QuizOptionElement => child.type === 'quiz_option'
    );
    const base = {
      id: question.id,
      level: question.level,
      prompt,
      ...(explanation ? { explanation } : {}),
    };
    switch (question.questionType) {
      case 'boolean':
        return {
          ...base,
          correct: question.correctBoolean ?? true,
          type: 'boolean',
        };
      case 'fill':
      case 'short':
        return {
          ...base,
          accepted: (question.acceptedAnswers ?? options.map(nodeText)).map(
            (value) => ({ value })
          ),
          type: question.questionType,
        };
      case 'matching':
        return { ...base, pairs: question.pairs ?? [], type: 'matching' };
      case 'ordering':
        return {
          ...base,
          items: options.map((option) => ({ value: nodeText(option) })),
          type: 'ordering',
        };
      default:
        return {
          ...base,
          correct: (question.correctOptionIds ?? [])
            .map((id) => options.findIndex((option) => option.id === id))
            .filter((index) => index >= 0),
          options: options.map((option) => ({
            value: nodeText(option),
            ...(typeof option.explanation === 'string'
              ? { explanation: option.explanation }
              : {}),
          })),
          type: question.questionType === 'multi' ? 'multi' : 'mcq',
        };
    }
  });
  return {
    questions,
    ...(element.timeLimitMin == null
      ? {}
      : { timeLimitMin: element.timeLimitMin }),
  };
}

export function flashcardsElementToCards(
  element: FlashcardsElement
): FlashcardContent[] {
  return element.children.map((card) => ({
    back: nodeText(card.children[1] ?? { text: '' }),
    front: nodeText(card.children[0] ?? { text: '' }),
    id: card.id,
  }));
}

export function isCustomMaterialElement(
  value: unknown
): value is CustomMaterialElement {
  return (
    isElementNode(value) &&
    CUSTOM_TYPES.has(value.type) &&
    isMaterialNode(value)
  );
}
