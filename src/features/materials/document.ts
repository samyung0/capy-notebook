import { EMBED_CATALOG } from '@/api/embeds.generated';
import type { Question, QuestionBlock } from '@/api/types';
import { repairFigureBlock } from '@/features/questions/repair';
import {
  descriptionFits,
  liveFigureSchema,
  questionBlockSchema,
  validateQuestion,
  validateQuestions,
} from '@/features/questions/validation';
import { MATERIAL_SCHEMA_VERSION } from '@/lib/const';
import { uid } from '@/lib/id';
import {
  type FlashcardContent,
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
  block: Extract<QuestionBlock, { type: 'chart' | 'plot' | 'graph' }>;
  children: [MaterialText];
  id: string;
  type: 'chart' | 'plot' | 'graph';
  /** Percentage of the block, set by the resize handles. */
  width?: string;
}

export interface FlashcardFaceElement extends MaterialElement {
  children: MaterialText[];
  type: 'flashcard_front' | 'flashcard_back';
}

export interface FlashcardElement extends MaterialElement {
  children: [FlashcardFaceElement, FlashcardFaceElement];
  id: string;
  image?: { assetId: string };
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
  /** Percentage of the block, set by the resize handles; unset fills it. */
  width?: string;
}

/** An interactive HTML block: one self-contained snippet, run only in a
 * sandboxed frame on a separate site (HtmlEmbed.tsx). Top-level void. */
export interface HtmlEmbedElement extends MaterialElement {
  caption?: string;
  children: [MaterialText];
  html: string;
  id: string;
  type: 'html_embed';
}

export const HTML_EMBED_TYPE = 'html_embed';
export const HTML_EMBED_MAX_BYTES = EMBED_CATALOG.limits.HTML_EMBED_MAX_BYTES;
export const HTML_EMBED_MAX_COUNT = EMBED_CATALOG.limits.HTML_EMBED_MAX_COUNT;
/** An HTML embed's caption, and the inline Mermaid caption's input bound. */
export const BLOCK_CAPTION_MAX = EMBED_CATALOG.limits.BLOCK_CAPTION_MAX;
/** Any block's indent (lists, indented paragraphs): the editor stops at it
 * and every validator refuses more (Epo 2026-10-18). */
export const LIST_INDENT_MAX = EMBED_CATALOG.limits.LIST_INDENT_MAX;
/** A Mermaid source in UTF-16 units (a string's length), mermaid's own
 * maxTextSize; every layer refuses more (Epo 2026-10-22). */
export const MERMAID_SOURCE_MAX = EMBED_CATALOG.limits.MERMAID_SOURCE_MAX;

export function htmlBytes(html: string): number {
  return new TextEncoder().encode(html).length;
}

export type MaterialRefKind = 'quiz' | 'flashcards';

/** A note's void reference to an embedded quiz or flashcard set. The material
 * row holds the content. `pending` carries a markdown fence body not turned
 * into a row yet: imported markdown before the editor creates its rows
 * (pendingRefs.ts) and a markdown file's preview. It never enters a note's
 * document, which every reader gets: the body holds the answer keys
 * (live-items REVIEW5). */
export interface MaterialRefElement extends MaterialElement {
  children: [MaterialText];
  id: string;
  materialId: string;
  pending?: string;
  refKind: MaterialRefKind;
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
  | MaterialRefElement
  | HtmlEmbedElement;

export const MATERIAL_REF_TYPE = 'material_ref';

type CatalogElement = (typeof EMBED_CATALOG.elements)[number];
/** Every element type a document may hold, from the embed catalog
 * (src/api/embeds.generated.ts, openwiki/embeds.md). */
const ELEMENTS = new Map<string, CatalogElement>(
  EMBED_CATALOG.elements.map((element) => [element.type, element])
);
/** Whether the embed catalog lists an element type. */
export function isKnownElementType(type: string): boolean {
  return ELEMENTS.has(type);
}
const MATERIAL_REF_KINDS = new Set<string>(
  EMBED_CATALOG.materialKinds
    .filter((kind) => 'item' in kind && kind.item)
    .map((kind) => kind.kind)
);
/** The one width a resizable block stores: what MediaFrame's resize handles
 * write, a whole percentage from MEDIA_WIDTH_MIN to MEDIA_WIDTH_MAX. Go and
 * the collaboration server refuse any other, so an imported document carrying
 * one fails here instead of getting the note's room refused. */
const MEDIA_WIDTH = /^(?:[2-9][0-9]|100)%$/;
/** A resizable block's width when it is one MEDIA_WIDTH takes, for renderers:
 * the width reaches a style, so any other draws as no width. */
export function mediaWidth(width: unknown): string | undefined {
  return typeof width === 'string' && MEDIA_WIDTH.test(width)
    ? width
    : undefined;
}
/** A column's width as the editor writes it: the layout presets, or Plate's
 * column normalizer writing `${n}%` of a float (`49.9995%`,
 * `33.333333333333336%`). A plain decimal percentage above 0 and at most 100,
 * as JavaScript writes a number. Go and the collaboration server refuse any
 * other, and renderers draw none, since the width reaches a style. */
const COLUMN_WIDTH = /^(?:100|[1-9][0-9]?(?:\.[0-9]*[1-9])?|0\.[0-9]*[1-9])%$/;
export function isColumnWidth(width: unknown): width is string {
  return typeof width === 'string' && COLUMN_WIDTH.test(width);
}
/** A table's column size or left margin as Plate's table resizing writes it:
 * a finite number of px, 0 or more. A column size may be empty (null) where
 * Plate sets one past the end of the list. Go and the collaboration server
 * refuse any other, and renderers draw none, since sizes reach a style. */
export function isTableSize(size: unknown): size is number {
  return typeof size === 'number' && Number.isFinite(size) && size >= 0;
}
/** A block's indent: a number (Plate's indent and list plugins, a pasted
 * list's `aria-level`), at most LIST_INDENT_MAX. Plate turns it into a class
 * and a margin, so renderers draw no other. */
export function isIndent(indent: unknown): indent is number {
  return typeof indent === 'number' && indent <= LIST_INDENT_MAX;
}
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `nodes` with each block indent past LIST_INDENT_MAX set to it: the cheap
 * repair an import makes on entry (Epo 2026-10-19), so a Word or Markdown
 * list nested deeper still imports. Every direct write is refused instead. */
export function clampIndents<T>(nodes: T[]): T[] {
  return nodes.map((node) => {
    if (!isRecord(node)) return node;
    const clamped: Record<string, unknown> = { ...node };
    if (Array.isArray(node.children))
      clamped.children = clampIndents(node.children);
    if (typeof node.indent === 'number' && node.indent > LIST_INDENT_MAX)
      clamped.indent = LIST_INDENT_MAX;
    return clamped as T;
  });
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

function catalogKeys(
  element: CatalogElement,
  key: 'assets' | 'fields' | 'forbidden' | 'required'
): readonly string[] | undefined {
  return (element as { [name in typeof key]?: readonly string[] })[key];
}

/** The embed catalog's key rules every element shares, after its own checks:
 * top-level placement, required keys, keys it never carries (null counts as
 * absent), its closed field set and a resizable block's width. A reference
 * imported from a fence carries its body in `pending` until its row exists
 * (pendingRefs.ts, markdownConvert.ts): the store refuses one, the editor's
 * import does not. */
function followsCatalog(
  element: MaterialElement,
  catalog: CatalogElement,
  depth: number
): boolean {
  if ('topLevel' in catalog && catalog.topLevel && depth !== 0) return false;
  if (catalogKeys(catalog, 'required')?.some((key) => element[key] == null))
    return false;
  if (
    catalogKeys(catalog, 'forbidden')?.some(
      (key) =>
        element[key] != null &&
        !(key === 'pending' && element.type === MATERIAL_REF_TYPE)
    )
  )
    return false;
  const fields = catalogKeys(catalog, 'fields');
  if (fields && Object.keys(element).some((key) => !fields.includes(key)))
    return false;
  return !(
    'resizable' in catalog &&
    catalog.resizable &&
    element.width !== undefined &&
    (typeof element.width !== 'string' || !MEDIA_WIDTH.test(element.width))
  );
}

/** One element's own values; the catalog's key rules follow. A `live` read
 * (a stored or room document) takes a figure as a room holds it, repaired
 * (`liveFigureSchema`, Epo 2026-10-18); a write takes it strictly. */
function validateCustomElement(
  element: MaterialElement,
  live: boolean
): boolean {
  switch (element.type) {
    case 'chart':
    case 'plot':
    case 'graph': {
      if (
        !hasId(element) ||
        element.children.length !== 1 ||
        !isTextNode(element.children[0]) ||
        element.children[0].text !== ''
      )
        return false;
      const result = (live ? liveFigureSchema : questionBlockSchema).safeParse(
        element.block
      );
      return (
        result.success &&
        result.data.type === element.type &&
        (result.data.type !== 'graph' || 'svg' in result.data.image) &&
        descriptionFits(result.data)
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
    case 'column':
      return element.width === undefined || isColumnWidth(element.width);
    case 'table':
      return (
        (element.colSizes === undefined ||
          (Array.isArray(element.colSizes) &&
            element.colSizes.every(
              (size) => size == null || isTableSize(size)
            ))) &&
        (element.marginLeft === undefined || isTableSize(element.marginLeft))
      );
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
        element.source.length <= MERMAID_SOURCE_MAX &&
        element.children.length === 1 &&
        isElementNode(element.children[0]) &&
        element.children[0].type === 'mermaid_caption'
      );
    case HTML_EMBED_TYPE:
      return (
        hasId(element) &&
        typeof element.html === 'string' &&
        htmlBytes(element.html) <= HTML_EMBED_MAX_BYTES &&
        (element.caption === undefined ||
          typeof element.caption === 'string') &&
        element.children.length === 1 &&
        isTextNode(element.children[0]) &&
        element.children[0].text === ''
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

/** A YouTube video names its video; an image or audio block (an element whose
 * asset is its own `assetId`) names a non-empty asset. */
function validateMediaElement(
  element: MaterialElement,
  catalog: CatalogElement
): boolean {
  if (element.type === 'video')
    return (
      element.provider === 'youtube' &&
      typeof element.videoId === 'string' &&
      YOUTUBE_VIDEO_ID.test(element.videoId)
    );
  return (
    !catalogKeys(catalog, 'assets')?.includes('assetId') ||
    (typeof element.assetId === 'string' && element.assetId.length > 0)
  );
}

export function isMaterialNode(
  value: unknown,
  depth = 0,
  live = false
): value is MaterialNode {
  if (isTextNode(value)) return true;
  if (!isElementNode(value)) return false;
  if (!value.children.every((child) => isMaterialNode(child, depth + 1, live)))
    return false;
  if (value.indent != null && !isIndent(value.indent)) return false;
  const catalog = ELEMENTS.get(value.type);
  // A stored document holding a type the catalog does not list stays
  // readable; building one to write refuses it (createMaterialDocument).
  if (!catalog) return true;
  return (
    validateMediaElement(value, catalog) &&
    validateCustomElement(value, live) &&
    followsCatalog(value, catalog, depth)
  );
}

/** The first element type in `value` the catalog does not list. */
function unknownElementType(nodes: MaterialNode[]): string | undefined {
  for (const node of nodes) {
    if ('text' in node) continue;
    if (!ELEMENTS.has(node.type)) return node.type;
    const nested = unknownElementType(node.children);
    if (nested) return nested;
  }
}

/** Whether `value` is a material document; `live` reads one stored or held
 * by a room, whose figures may be what a merge leaves (`liveFigureSchema`). */
export function isMaterialDocument(
  value: unknown,
  live = false
): value is MaterialDocument {
  if (!isRecord(value)) return false;
  if (
    !(
      value.schemaVersion === MATERIAL_SCHEMA_VERSION &&
      Array.isArray(value.value) &&
      value.value.length > 0 &&
      value.value.every(
        (node) => isElementNode(node) && isMaterialNode(node, 0, live)
      )
    )
  )
    return false;
  if (
    (value.value as MaterialValue).filter(
      (node) => node.type === HTML_EMBED_TYPE
    ).length > HTML_EMBED_MAX_COUNT
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

/** A document with its live figures' merges repaired as readers draw them
 * (`repairFigureBlock`, Epo 2026-10-17): reads take one, writes
 * (`createMaterialDocument`) refuse it. Figures are top-level blocks whose
 * `block` the catalog shares as a map. */
function withRepairedFigures(candidate: unknown): unknown {
  if (!isRecord(candidate) || !Array.isArray(candidate.value)) return candidate;
  let changed = false;
  const value = candidate.value.map((node: unknown) => {
    if (!isRecord(node) || typeof node.type !== 'string') return node;
    const catalog = ELEMENTS.get(node.type);
    if (!(catalog && 'sharedMap' in catalog)) return node;
    const block = repairFigureBlock(node.block);
    if (block === node.block) return node;
    changed = true;
    return { ...node, block };
  });
  return changed ? { ...candidate, value } : candidate;
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
  candidate = withRepairedFigures(candidate);
  return isMaterialDocument(candidate, true) ? candidate : null;
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

/** A document built to be written: valid, and holding only element types the
 * embed catalog lists, as every server refuses any other. */
function assertWritable(document: MaterialDocument) {
  const unknown = unknownElementType(document.value);
  if (unknown) throw new Error(`Unknown element type ${unknown}`);
  if (!isMaterialDocument(document))
    throw new Error('Invalid or unsupported material document');
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
  assertWritable(document);
  return { document, metrics: normalized.metrics };
}

export function createMaterialDocument(value: MaterialValue): MaterialDocument {
  const document: MaterialDocument = {
    schemaVersion: MATERIAL_SCHEMA_VERSION,
    value: normalizeMaterialValue(value),
  };
  assertWritable(document);
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

/** One top-level block normalized as `normalizeMaterialValue` would (a live
 * note View rebuilds only the blocks its room changed). */
export function normalizeMaterialBlock(
  block: MaterialElement
): MaterialElement {
  return normalizeMaterialValueInternal([block])[0];
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
    ...(card.image ? { image: { assetId: card.image.assetId } } : {}),
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

export function htmlEmbedNode(
  html: string,
  caption?: string,
  id = uid('block')
): HtmlEmbedElement {
  return {
    ...(caption ? { caption } : {}),
    children: [{ text: '' }],
    html,
    id,
    type: HTML_EMBED_TYPE,
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
    ...(card.image ? { image: { assetId: card.image.assetId } } : {}),
  }));
}
