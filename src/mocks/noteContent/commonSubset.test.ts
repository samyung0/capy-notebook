import { expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createMaterialDocumentWithMetrics,
  type MaterialElement,
  type MaterialNode,
} from '@/features/materials/document';
import {
  blocksValue,
  canonical,
  stateFromValue,
} from '@/features/notes/blocksuite/layout';
import { buildCommonSubsetValue } from './commonSubset';
import { buildBiologyLoadTestValue } from './loadTest';

function weigh(value: Parameters<typeof createMaterialDocumentWithMetrics>[0]) {
  const { document, metrics } = createMaterialDocumentWithMetrics(value);
  return {
    bytes: new TextEncoder().encode(JSON.stringify(document)).byteLength,
    nodes: metrics.nodeCount,
  };
}

function types(nodes: MaterialNode[], into = new Set<string>()) {
  for (const node of nodes)
    if ('children' in node) {
      const element = node as MaterialElement;
      into.add(element.type);
      types(element.children, into);
    }
  return into;
}

it('matches the load-test note in size and converts to blocks and back', () => {
  const load = weigh(buildBiologyLoadTestValue());
  const value = buildCommonSubsetValue('mat_common', 'Common', load);
  const own = weigh(value);
  expect(own.bytes).toBeLessThanOrEqual(load.bytes);
  expect(own.bytes).toBeGreaterThan(load.bytes * 0.99);
  expect(own.nodes).toBeLessThanOrEqual(load.nodes);
  expect(own.nodes).toBeGreaterThan(load.nodes * 0.97);

  expect([...types(value)].sort()).toEqual([
    'a',
    'blockquote',
    'callout',
    'code_block',
    'code_line',
    'h1',
    'h2',
    'h3',
    'img',
    'inline_equation',
    'material_ref',
    'p',
    'table',
    'td',
    'th',
    'tr',
  ]);

  const doc = new Y.Doc();
  Y.applyUpdate(doc, stateFromValue(value));
  expect(blocksValue(doc)).toEqual(canonical(value));
});
