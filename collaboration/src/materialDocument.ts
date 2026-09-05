// IMPORTANT: Keep this validator in sync with
// server/internal/materialdoc/document.go. The sidecar runs it before writing
// authoritative Yjs state so Go can always project that state.

export const MATERIAL_DOCUMENT_DEPTH_CEILING = 1024;
const QUESTION_TYPES = new Set([
  'mcq',
  'multi',
  'boolean',
  'short',
  'open',
  'matching',
  'ordering',
]);
const COGNITIVE_LEVELS = new Set(['recall', 'application', 'analysis']);
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
export const MAX_QUIZ_TIME_LIMIT_MIN = 180;

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

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function validateQuiz(node: MaterialNode) {
  rejectOpaque(node);
  requireId(node);
  const ids = new Set<string>();
  for (const [index, question] of children(node).entries()) {
    if (question.type !== 'quiz_question') {
      fail(`children[${index}] must be a quiz_question`);
    }
    const id = question.id as string;
    if (ids.has(id)) fail(`duplicate question id ${JSON.stringify(id)}`);
    ids.add(id);
  }
  if (
    hasOwn(node, 'timeLimitMin') &&
    (!Number.isSafeInteger(node.timeLimitMin) ||
      Number(node.timeLimitMin) < 1 ||
      Number(node.timeLimitMin) > MAX_QUIZ_TIME_LIMIT_MIN)
  ) {
    fail(
      `timeLimitMin must be an integer from 1 to ${MAX_QUIZ_TIME_LIMIT_MIN}`
    );
  }
}

function validateQuizQuestion(node: MaterialNode) {
  rejectOpaque(node);
  requireId(node);
  if (
    typeof node.questionType !== 'string' ||
    !QUESTION_TYPES.has(node.questionType)
  ) {
    fail('questionType is invalid');
  }
  if (typeof node.level !== 'string' || !COGNITIVE_LEVELS.has(node.level)) {
    fail('level is invalid');
  }

  let prompts = 0;
  const optionIds = new Set<string>();
  for (const [index, child] of children(node).entries()) {
    switch (child.type) {
      case 'quiz_prompt':
        prompts += 1;
        break;
      case 'quiz_option': {
        const id = child.id as string;
        if (optionIds.has(id))
          fail(`duplicate option id ${JSON.stringify(id)}`);
        optionIds.add(id);
        break;
      }
      case 'quiz_explanation':
        break;
      default:
        fail(`children[${index}] has invalid quiz child type`);
    }
  }
  if (prompts === 0) fail('quiz_question requires a quiz_prompt');

  if (hasOwn(node, 'correctOptionIds')) {
    if (!isStringArray(node.correctOptionIds)) {
      fail('correctOptionIds must be a string array');
    }
    for (const id of node.correctOptionIds) {
      if (!optionIds.has(id)) {
        fail(
          `correctOptionIds references unknown option ${JSON.stringify(id)}`
        );
      }
    }
  }
  if (
    hasOwn(node, 'correctBoolean') &&
    typeof node.correctBoolean !== 'boolean'
  ) {
    fail('correctBoolean must be a boolean');
  }
  for (const key of ['acceptedAnswers', 'hints', 'rubrics'] as const) {
    if (hasOwn(node, key) && !isStringArray(node[key])) {
      fail(`${key} must be a string array`);
    }
  }
  if (
    hasOwn(node, 'points') &&
    (typeof node.points !== 'number' ||
      !Number.isFinite(node.points) ||
      node.points <= 0)
  ) {
    fail('points must be a positive number');
  }
  if (hasOwn(node, 'pairs')) {
    if (!Array.isArray(node.pairs)) fail('pairs must be an array');
    for (const [index, pair] of node.pairs.entries()) {
      if (!isRecord(pair)) fail(`pairs[${index}] must be an object`);
      if (typeof pair.left !== 'string')
        fail(`pairs[${index}].left must be a string`);
      if (typeof pair.right !== 'string')
        fail(`pairs[${index}].right must be a string`);
    }
  }
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
    case 'quiz_question':
      validateQuizQuestion(node);
      break;
    case 'quiz_prompt':
    case 'quiz_explanation':
    case 'flashcard_front':
    case 'flashcard_back':
    case 'mermaid_caption':
      validateTextElement(node);
      break;
    case 'quiz_option':
      requireId(node);
      validateTextElement(node);
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
    default:
      return;
  }
  if (!requiredTypes.some((type) => containsType(nodes, type))) {
    fail(`${kind} element is required`);
  }
}
