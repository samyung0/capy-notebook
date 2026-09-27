import { QUESTION_COUNT_MAX } from './questionLimits.generated.js';
import { questionBlockSchema, validateQuestion } from './questions.js';
// IMPORTANT: Keep this validator in sync with
// server/internal/materialdoc/document.go. The sidecar runs it before writing
// authoritative Yjs state so Go can always project that state.

export const MATERIAL_DOCUMENT_DEPTH_CEILING = 1024;
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

type MaterialNode = Record<string, unknown>;

export class MaterialDocumentValidationError extends Error {
  constructor(message: string) {
    super(`invalid material document: ${message}`);
    this.name = 'MaterialDocumentValidationError';
  }
}

function fail(message: string): never {
  throw new MaterialDocumentValidationError(message);
}

function isRecord(value: unknown): value is MaterialNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(node: MaterialNode, key: string): boolean {
  return Object.hasOwn(node, key);
}

function children(node: MaterialNode): MaterialNode[] {
  const raw = node.children;
  return Array.isArray(raw) ? raw.filter(isRecord) : [];
}

function requireId(node: MaterialNode) {
  if (typeof node.id !== 'string' || node.id.trim() === '') {
    fail('id is required');
  }
}

function rejectOpaque(node: MaterialNode) {
  for (const key of ['questions', 'cards', 'code']) {
    if (hasOwn(node, key)) fail(`opaque ${key} property is not canonical`);
  }
}

function hasTextDescendant(node: MaterialNode): boolean {
  if (typeof node.text === 'string') return true;
  return children(node).some(hasTextDescendant);
}

function validateTextElement(node: MaterialNode) {
  for (const [index, child] of children(node).entries()) {
    if (typeof child.text !== 'string') {
      fail(`children[${index}] must be a text leaf`);
    }
  }
}

function validateQuiz(node: MaterialNode) {
  rejectOpaque(node);
  requireId(node);
  const list = children(node);
  const empty =
    list.length === 1 &&
    Object.keys(list[0]).length === 1 &&
    list[0].text === '';
  const ids = new Set<string>();
  for (const [index, question] of (empty ? [] : list).entries()) {
    if (question.type !== 'quiz_question') {
      fail(`children[${index}] must be a quiz_question`);
    }
    const id = question.id as string;
    if (ids.has(id)) fail(`duplicate question id ${JSON.stringify(id)}`);
    ids.add(id);
  }
  if (hasOwn(node, 'timeLimitMin'))
    fail('quiz time limits are no longer supported');
}

function validateQuizQuestion(node: MaterialNode) {
  rejectOpaque(node);
  requireId(node);
  try {
    validateQuestion(node.question);
  } catch (error) {
    fail(error instanceof Error ? error.message : 'invalid question');
  }
  if (!isRecord(node.question) || node.id !== node.question.id)
    fail('question id must match wrapper id');
  for (const key of [
    'questionType',
    'level',
    'points',
    'rubrics',
    'pairs',
    'acceptedAnswers',
    'hints',
    'correctOptionIds',
    'correctBoolean',
  ]) {
    if (hasOwn(node, key)) fail(`obsolete quiz property ${key}`);
  }
  const leaf = children(node);
  if (
    leaf.length !== 1 ||
    Object.keys(leaf[0]).length !== 1 ||
    leaf[0].text !== ''
  )
    fail('quiz_question requires one void text child');
}

function validateFlashcards(node: MaterialNode) {
  rejectOpaque(node);
  requireId(node);
  const ids = new Set<string>();
  for (const [index, card] of children(node).entries()) {
    if (card.type !== 'flashcard')
      fail(`children[${index}] must be a flashcard`);
    const id = card.id as string;
    if (ids.has(id)) fail(`duplicate card id ${JSON.stringify(id)}`);
    ids.add(id);
  }
}

function validateFlashcard(node: MaterialNode) {
  rejectOpaque(node);
  requireId(node);
  const cardChildren = children(node);
  if (cardChildren.length !== 2)
    fail('flashcard requires front and back children');
  if (
    cardChildren[0]?.type !== 'flashcard_front' ||
    cardChildren[1]?.type !== 'flashcard_back'
  ) {
    fail('flashcard children must be front then back');
  }
}

function validateDiagram(node: MaterialNode) {
  rejectOpaque(node);
  requireId(node);
  if (typeof node.source !== 'string') fail('source must be a string');
  const diagramChildren = children(node);
  if (
    diagramChildren.length !== 1 ||
    diagramChildren[0]?.type !== 'mermaid_caption'
  ) {
    fail('diagram requires one mermaid_caption child');
  }
}

function validateNode(node: MaterialNode, depth: number) {
  if (depth > MATERIAL_DOCUMENT_DEPTH_CEILING) {
    fail('document nesting is too deep to decode');
  }
  for (const key of Object.keys(node)) {
    if (key === 'suggestion' || key.startsWith('suggestion_')) {
      fail(
        `obsolete suggestion property ${JSON.stringify(key)} is not allowed`
      );
    }
  }
  if (hasOwn(node, 'text')) {
    if (typeof node.text !== 'string') fail('text leaf must contain a string');
    if (hasOwn(node, 'children')) fail('text leaf cannot contain children');
    return;
  }
  if (typeof node.type !== 'string' || node.type.trim() === '') {
    fail('element type is required');
  }
  if (!Array.isArray(node.children) || node.children.length === 0) {
    fail('element children must be a non-empty array');
  }
  for (const [index, child] of node.children.entries()) {
    if (!isRecord(child)) fail(`children[${index}] must be an object`);
    validateNode(child, depth + 1);
  }
  if (!hasTextDescendant(node)) fail('element must contain a text descendant');

  switch (node.type) {
    case 'quiz':
      validateQuiz(node);
      break;
    case 'chart':
    case 'graph': {
      if (depth !== 0) fail('chart and graph embeds must be top-level blocks');
      requireId(node);
      const leaf = children(node);
      if (
        leaf.length !== 1 ||
        Object.keys(leaf[0]).length !== 1 ||
        leaf[0].text !== ''
      )
        fail('chart and graph embeds require one empty text leaf');
      const block = node.block;
      if (!isRecord(block) || block.type !== node.type)
        fail('embed block type must match node type');
      if (
        Object.keys(node).some(
          (key) => !['id', 'type', 'block', 'children'].includes(key)
        )
      )
        fail('unexpected embed field');
      try {
        const parsed = questionBlockSchema.parse(block);
        if (parsed.type === 'graph' && 'url' in parsed.image)
          fail('note graphs require inline SVG');
      } catch (error) {
        fail(error instanceof Error ? error.message : 'invalid embed');
      }
      break;
    }
    case 'quiz_question':
      validateQuizQuestion(node);
      break;
    case 'flashcard_front':
    case 'flashcard_back':
    case 'mermaid_caption':
      validateTextElement(node);
      break;
    case 'quiz_prompt':
    case 'quiz_option':
    case 'quiz_explanation':
      fail('obsolete quiz child node');
      break;
    case 'flashcards':
      validateFlashcards(node);
      break;
    case 'flashcard':
      validateFlashcard(node);
      break;
    case 'mermaid':
    case 'diagram':
    case 'mindmap':
      validateDiagram(node);
      break;
    case MATERIAL_REF_TYPE:
      validateMaterialRef(node);
      break;
    case 'video':
      if (node.provider !== 'youtube') fail('video provider must be youtube');
      if (
        typeof node.videoId !== 'string' ||
        !YOUTUBE_VIDEO_ID.test(node.videoId)
      ) {
        fail('videoId must be a valid YouTube video ID');
      }
      for (const key of ['assetId', 'url', 'src']) {
        if (hasOwn(node, key)) fail(`YouTube video cannot contain ${key}`);
      }
      break;
    default:
      break;
  }
}

/** The void block a note stores for an embedded quiz or flashcard set. */
export const MATERIAL_REF_TYPE = 'material_ref';
const REF_KINDS = new Set(['quiz', 'flashcards']);

function validateMaterialRef(node: MaterialNode) {
  requireId(node);
  // A fence imported as markdown is a pending reference until the editor
  // creates its row: no material id yet, the fence body in `pending`.
  if (typeof node.materialId !== 'string') fail('materialId is required');
  if (
    node.materialId.trim() === '' &&
    (typeof node.pending !== 'string' || node.pending === '')
  ) {
    fail('materialId is required');
  }
  if (typeof node.refKind !== 'string' || !REF_KINDS.has(node.refKind)) {
    fail('refKind must be quiz or flashcards');
  }
  const leaves = children(node);
  if (leaves.length !== 1 || leaves[0].text !== '') {
    fail('material reference carries one empty text leaf');
  }
}

/** Notes keep study blocks in their own rows: no inline quiz/flashcards, and a
 * reference only as a top-level block. Other kinds carry no references. */
function validateNoteReferences(nodes: MaterialNode[]) {
  for (const inline of ['quiz', 'flashcards']) {
    if (containsType(nodes, inline)) {
      fail(`note cannot contain an inline ${inline} block`);
    }
  }
  for (const [index, node] of nodes.entries()) {
    if (containsType(children(node), MATERIAL_REF_TYPE)) {
      fail(`value[${index}]: material reference must be a top-level block`);
    }
  }
}

function containsType(nodes: MaterialNode[], type: string): boolean {
  return nodes.some(
    (node) => node.type === type || containsType(children(node), type)
  );
}

export function assertCanonicalMaterialValue(value: unknown[], kind: string) {
  if (value.length === 0) fail('value must be a non-empty array');
  const nodes: MaterialNode[] = [];
  for (const [index, valueNode] of value.entries()) {
    if (!isRecord(valueNode)) fail(`value[${index}] must be an object`);
    validateNode(valueNode, 0);
    nodes.push(valueNode);
  }

  const questions: MaterialNode[] = [];
  const collect = (node: MaterialNode) => {
    if (node.type === 'quiz_question' && isRecord(node.question))
      questions.push(node.question);
    for (const child of children(node)) collect(child);
  };
  nodes.forEach(collect);
  if (questions.length > QUESTION_COUNT_MAX) fail('too many questions');
  const questionIds = new Set<unknown>();
  const partIds = new Set<unknown>();
  for (const question of questions) {
    if (questionIds.has(question.id)) fail('duplicate question id');
    questionIds.add(question.id);
    for (const part of question.parts as MaterialNode[]) {
      if (partIds.has(part.id)) fail('duplicate part id');
      partIds.add(part.id);
    }
  }

  const topLevelIds = new Set<string>();
  for (const [index, node] of nodes.entries()) {
    if (typeof node.id !== 'string' || node.id.trim() === '') {
      fail(`value[${index}].id is required`);
    }
    const id = node.id.trim();
    if (topLevelIds.has(id)) {
      fail(`value[${index}].id ${JSON.stringify(id)} is duplicated`);
    }
    topLevelIds.add(id);
  }

  let requiredTypes: string[] = [];
  switch (kind) {
    case 'quiz':
      requiredTypes = ['quiz'];
      break;
    case 'flashcards':
      requiredTypes = ['flashcards'];
      break;
    case 'mindmap':
    case 'diagram':
      requiredTypes = ['mermaid', 'diagram', 'mindmap'];
      break;
    case 'note':
      validateNoteReferences(nodes);
      return;
    default:
      return;
  }
  if (!requiredTypes.some((type) => containsType(nodes, type))) {
    fail(`${kind} element is required`);
  }
  if (containsType(nodes, MATERIAL_REF_TYPE)) {
    fail(`${kind} cannot contain a material reference`);
  }
}
