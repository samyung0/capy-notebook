/**
 * Writes the bench's notes as Plate values for `layout-cost`
 * (run-layout-cost.sh): the near-limit load-test note, the common-subset note
 * at its size (the values the editor bench seeds), and a small note, the
 * load-test note's first 40 blocks.
 * Usage: tsx bench/collaboration/scripts/layout-values.ts <out.json>
 */
import { writeFileSync } from 'node:fs';
import { createMaterialDocumentWithMetrics } from '@/features/materials/document';
import { buildCommonSubsetValue } from '@/mocks/noteContent/commonSubset';
import { buildBiologyLoadTestValue } from '@/mocks/noteContent/loadTest';
import { PERF_COMMON_NOTE } from '@/mocks/perfSeed';

const out = process.argv[2];
if (!out) throw new Error('usage: layout-values.ts <out.json>');

// As db.ts seeds them: normalized, the common note at the load note's size.
const load = createMaterialDocumentWithMetrics(buildBiologyLoadTestValue());
const common = createMaterialDocumentWithMetrics(
  buildCommonSubsetValue(PERF_COMMON_NOTE.id, PERF_COMMON_NOTE.readyText, {
    bytes: new TextEncoder().encode(JSON.stringify(load.document)).byteLength,
    nodes: load.metrics.nodeCount,
  })
);
const small = createMaterialDocumentWithMetrics(buildBiologyLoadTestValue().slice(0, 40));
writeFileSync(
  out,
  JSON.stringify({
    'common-subset': common.document.value,
    'load-test': load.document.value,
    small: small.document.value,
  })
);
