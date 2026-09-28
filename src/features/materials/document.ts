import type { Question, QuestionBlock } from '@/api/types';
import {
  questionBlockSchema,
  validateQuestion,
  validateQuestions,
} from '@/features/questions/validation';
import { MATERIAL_SCHEMA_VERSION } from '@/lib/const';
import { uid } from '@/lib/id';
import {
  type FlashcardContent,
  parseFlashcardsFenceBody,
  parseQuizFenceBody,
  type QuizBlock,
} from './blocks';
import type { MermaidTheme } from './mermaidThemes';

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

export interface QuizQuestionElement extends MaterialElement {
  children: [MaterialText];
  id: string;
  question: Question;
  type: 'quiz_question';
}

export interface QuizElement extends MaterialElement {
  children: QuizQuestionElement[] | [MaterialText];
  id: string;
  type: 'quiz';
}

export interface QuestionFigureElement extends MaterialElement {
  block: Extract<QuestionBlock, { type: 'chart' | 'graph' }>;
  children: [MaterialText];
  id: string;
  type: 'chart' | 'graph';
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
  /** Unset draws in DEFAULT_MERMAID_THEME. */
  theme?: MermaidTheme;
  type: 'mermaid';
}

export type MaterialRefKind = 'quiz' | 'flashcards';

/** A note's void reference to an embedded quiz or flashcard set. The material
 * row holds the content. `pending` carries a fence body that has not been
 * turned into a row yet (markdown import); it resolves in the editor. */
export interface MaterialRefElement extends MaterialElement {
  children: [MaterialText];
  id: string;
  materialId: string;
  pending?: string;
  refKind: MaterialRefKind;
  /** The client creating the row for a pending reference. */
  resolvingBy?: string;
  type: 'material_ref';
}

export type CustomMaterialElement =
  | QuestionFigureElement
  | QuizElement
  | QuizQuestionElement
  | FlashcardsElement
  | FlashcardElement
  | FlashcardFaceElement
  | MermaidElement
  | MermaidCaptionElement
  | MaterialRefElement;

export const MATERIAL_REF_TYPE = 'material_ref';
const MATERIAL_REF_KINDS = new Set<string>(['quiz', 'flashcards']);

const CUSTOM_TYPES = new Set([
  'chart',
  'graph',
  'quiz_prompt',
  'quiz_option',
  'quiz_explanation',
  'quiz',
  'quiz_question',
  'flashcards',
  'flashcard',
  'flashcard_front',
  'flashcard_back',
  'mermaid',
  'mermaid_caption',
  MATERIAL_REF_TYPE,
]);
const MEDIA_TYPES = new Set(['img', 'image', 'audio', 'file']);
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
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
    case 'chart':
    case 'graph': {
      if (
        !hasId(element) ||
        element.children.length !== 1 ||
        !isTextNode(element.children[0]) ||
        element.children[0].text !== ''
      )
        return false;
      const result = questionBlockSchema.safeParse(element.block);
      return (
        result.success &&
        result.data.type === element.type &&
        (result.data.type !== 'graph' || 'svg' in result.data.image)
      );
    }
    case 'quiz': {
      if (!hasId(element)) return false;
      if (
        element.children.length === 1 &&
        isTextNode(element.children[0]) &&
        element.children[0].text === ''
      )
        return true;
      try {
        if (
          !element.children.every(
            (child) => isElementNode(child) && child.type === 'quiz_question'
          )
        )
          return false;
        validateQuestions(
          element.children.map(
            (child) => (child as QuizQuestionElement).question
          )
        );
        return true;
      } catch {
        return false;
      }
    }
    case 'quiz_question': {
      if (
        !hasId(element) ||
        element.children.length !== 1 ||
        !isTextNode(element.children[0]) ||
        element.children[0].text !== ''
      )
        return false;
      try {
        return validateQuestion(element.question).id === element.id;
      } catch {
        return false;
      }
    }
    case 'quiz_prompt':
    case 'quiz_option':
    case 'quiz_explanation':
      return false;
    case 'flashcard':
      return (
        hasId(element) &&
        element.children.length === 2 &&
        isElementNode(element.children[0]) &&
        element.children[0].type === 'flashcard_front' &&
        isElementNode(element.children[1]) &&
        element.children[1].type === 'flashcard_back'
      );
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
    case MATERIAL_REF_TYPE: {
      const ref = element as MaterialRefElement;
      const resolved =
        typeof ref.materialId === 'string' && ref.materialId.trim() !== '';
      const pending =
        ref.materialId === '' &&
        typeof ref.pending === 'string' &&
        ref.pending !== '';
      return (
        hasId(element) &&
        (resolved || pending) &&
        MATERIAL_REF_KINDS.has(ref.refKind) &&
        element.children.length === 1 &&
        isTextNode(element.children[0]) &&
        element.children[0].text === ''
      );
    }
    default:
      return true;
  }
}

function validateMediaElement(element: MaterialElement): boolean {
  if (element.type === 'video') {
    return (
      element.provider === 'youtube' &&
      typeof element.videoId === 'string' &&
      YOUTUBE_VIDEO_ID.test(element.videoId) &&
      element.assetId == null &&
      element.url == null &&
      element.src == null
    );
  }
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
  if (
    !(
      value.schemaVersion === MATERIAL_SCHEMA_VERSION &&
      Array.isArray(value.value) &&
      value.value.length > 0 &&
      value.value.every((node) => isElementNode(node) && isMaterialNode(node))
    )
  )
    return false;
  const parts = new Set<string>();
  const uniqueParts = (node: MaterialNode): boolean => {
    if ('text' in node) return true;
    if (node.type === 'quiz_question') {
      for (const part of (node as QuizQuestionElement).question.parts) {
        if (parts.has(part.id)) return false;
        parts.add(part.id);
      }
    }
    return node.children.every(uniqueParts);
  };
  return (value.value as MaterialValue).every(uniqueParts);
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

export function emptyMaterialDocument(): MaterialDocument {
  return createMaterialDocument([{ children: [{ text: '' }], type: 'p' }]);
}

export function serializeMaterialDocument(document: MaterialDocument): string {
  return JSON.stringify(assertMaterialDocument(document));
}

function textElement<T extends string>(type: T, text: string): MaterialElement {
  return { children: [{ text }], type };
}

export function quizQuestionNode(question: Question): QuizQuestionElement {
  return {
    children: [{ text: '' }],
    id: question.id,
    question: validateQuestion(question),
    type: 'quiz_question',
  };
}

export function quizNode(data: QuizBlock, id = uid('quiz')): QuizElement {
  validateQuestions(data.questions);
  return {
    children: data.questions.length
      ? data.questions.map(quizQuestionNode)
      : [{ text: '' }],
    id,
    type: 'quiz',
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

/** Reference block for an embedded material. Without a material id the fence
 * body is kept as `pending` until the editor creates the row. */
export function materialRefNode(
  materialId: string,
  refKind: MaterialRefKind,
  pending?: string
): MaterialRefElement {
  return {
    children: [{ text: '' }],
    id: uid('block'),
    materialId,
    ...(materialId ? {} : { pending }),
    refKind,
    type: MATERIAL_REF_TYPE,
  };
}

export function isMaterialRefElement(
  value: unknown
): value is MaterialRefElement {
  return isElementNode(value) && value.type === MATERIAL_REF_TYPE;
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

export function quizQuestionElementToQuestion(
  element: QuizQuestionElement
): Question {
  const question = validateQuestion(element.question);
  if (question.id !== element.id)
    throw new Error('Question identity does not match its document node.');
  return question;
}

export function quizElementToBlock(element: QuizElement): QuizBlock {
  return {
    questions: element.children
      .filter(
        (node): node is QuizQuestionElement =>
          'type' in node && node.type === 'quiz_question'
      )
      .map(quizQuestionElementToQuestion),
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
