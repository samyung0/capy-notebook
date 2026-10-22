import { expect, it } from 'vitest';
import { EMBED_CATALOG } from '@/api/embeds.generated';
import {
  createMaterialDocument,
  createMaterialDocumentWithMetrics,
  flashcardsNode,
  MERMAID_SOURCE_MAX,
} from '@/features/materials/document';
import { MERMAID_EDGES_MAX } from '@/features/materials/mermaidError';
import {
  validateQuestions,
  validGraphSvg,
} from '@/features/questions/validation';
import { MATERIAL_DOCUMENT_LIMITS } from '@/lib/const';
import {
  nearLimitCards,
  nearLimitChart,
  nearLimitFlowchart,
  nearLimitGraph,
  nearLimitHtml,
  nearLimitMindmap,
  nearLimitPlot,
  nearLimitQuestions,
} from './nearLimits';
import { figure } from './noteContent/helpers';

const limits = EMBED_CATALOG.limits;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

it('keeps both near-limit Mermaid sources just under the caps', () => {
  for (const source of [nearLimitFlowchart(), nearLimitMindmap()]) {
    expect(source.length).toBeGreaterThan(MERMAID_SOURCE_MAX * 0.9);
    expect(source.length).toBeLessThan(MERMAID_SOURCE_MAX);
  }
  const edges = nearLimitFlowchart().match(/-->/g)?.length ?? 0;
  expect(edges).toBeGreaterThan(MERMAID_EDGES_MAX * 0.95);
  expect(edges).toBeLessThan(MERMAID_EDGES_MAX);
});

it('stores the near-limit figures', () => {
  const graph = nearLimitGraph();
  expect(validGraphSvg('svg' in graph.image ? graph.image.svg : '')).toBe(true);
  createMaterialDocument([
    figure('chart', nearLimitChart()),
    figure('plot', nearLimitPlot()),
    figure('graph', graph),
  ]);
  expect(graph.elements).toHaveLength(limits.QUESTION_GRAPH_ELEMENTS_MAX);
});

it('fills the interactive block to just under its byte cap', () => {
  const size = bytes(nearLimitHtml());
  expect(size).toBeLessThanOrEqual(limits.HTML_EMBED_MAX_BYTES);
  expect(size).toBeGreaterThan(limits.HTML_EMBED_MAX_BYTES - 256);
});

it('builds a valid quiz at the part caps', () => {
  const questions = nearLimitQuestions('t');
  expect(() => validateQuestions(questions)).not.toThrow();
  const parts = questions.flatMap((question) => question.parts);
  expect(parts).toHaveLength(limits.QUIZ_PARTS_MAX);
  expect(parts.filter((part) => part.answer.type === 'open')).toHaveLength(
    limits.QUIZ_OPEN_PARTS_MAX
  );
});

it('fills a flashcard set to just under the document size cap', () => {
  const { document, metrics } = createMaterialDocumentWithMetrics([
    flashcardsNode(nearLimitCards('t'), 't'),
  ]);
  const size = bytes(JSON.stringify(document));
  expect(size).toBeLessThan(MATERIAL_DOCUMENT_LIMITS.maxContentBytes);
  expect(size).toBeGreaterThan(MATERIAL_DOCUMENT_LIMITS.maxContentBytes * 0.9);
  expect(metrics.nodeCount).toBeLessThan(MATERIAL_DOCUMENT_LIMITS.maxNodes);
});
