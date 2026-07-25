/** Deterministic large-document fixtures for the editor performance harness
 * (e2e/perf). Seeded into the mock db only when VITE_PERF_SEED=true so normal
 * dev sessions stay clean. Kept free of runtime imports: the perf specs also
 * import this module for the ids, and type-only imports are erased by both
 * Vite and Playwright's transpiler. */

export const PERF_WORKSPACE_ID = 'ws_bio';
export const PERF_LARGE_NOTE = {
  id: 'mat_perf_large',
  readyText: 'Section 1',
  title: 'Perf probe — near-limit note',
} as const;
export const PERF_SMALL_NOTE = {
  id: 'mat_perf_small',
  readyText: 'Baseline note for typing latency.',
  title: 'Perf probe — baseline note',
} as const;

interface PerfNode {
  children?: PerfNode[];
  id?: string;
  text?: string;
  type?: string;
  [key: string]: unknown;
}

export interface PerfDocument {
  schemaVersion: 1;
  value: PerfNode[];
}

let counter = 0;
const id = () => `perf_${++counter}`;

// Plain words only: no autoformat triggers (quotes, arrows, fractions) and no
// slash-command trigger, so typing-adjacent plugins stay in their idle path.
const WORDS =
  'mitochondria synthesize adenosine molecules across the inner membrane while enzymes regulate gradient flow during aerobic respiration cycles'.split(
    ' '
  );

function sentence(seed: number, words: number): string {
  const parts: string[] = [];
  for (let i = 0; i < words; i += 1)
    parts.push(WORDS[(seed + i * 7) % WORDS.length]);
  return parts.join(' ');
}

function paragraph(seed: number): PerfNode {
  // Multiple leaves with marks: closer to real documents than one text run.
  return {
    children: [
      { text: sentence(seed, 12) + ' ' },
      { bold: true, text: sentence(seed + 3, 4) },
      { text: ' ' + sentence(seed + 5, 8) + '.' },
    ],
    id: id(),
    type: 'p',
  };
}

function heading(index: number): PerfNode {
  return { children: [{ text: `Section ${index}` }], id: id(), type: 'h2' };
}

function listItem(seed: number): PerfNode {
  return {
    children: [{ text: sentence(seed, 9) }],
    id: id(),
    indent: 1,
    listStyleType: 'disc',
    type: 'p',
  };
}

function codeBlock(seed: number, lines: number): PerfNode {
  return {
    children: Array.from({ length: lines }, (_, i) => ({
      children: [{ text: `const value${i} = compute(${seed + i});` }],
      id: id(),
      type: 'code_line',
    })),
    id: id(),
    lang: 'javascript',
    type: 'code_block',
  };
}

function table(rows: number, cols: number): PerfNode {
  return {
    children: Array.from({ length: rows }, (_, r) => ({
      children: Array.from({ length: cols }, (_, c) => ({
        children: [
          {
            children: [{ text: sentence(r * cols + c, 3) }],
            id: id(),
            type: 'p',
          },
        ],
        id: id(),
        type: r === 0 ? 'th' : 'td',
      })),
      id: id(),
      type: 'tr',
    })),
    id: id(),
    type: 'table',
  };
}

function countNodes(node: PerfNode): number {
  if (!node.children) return 1;
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}

export function countPerfNodes(document: PerfDocument): number {
  return document.value.reduce((sum, node) => sum + countNodes(node), 0);
}

/** A realistic mixed document close to (but under) the 10k node limit. */
export function buildLargePerfDocument(targetNodes = 8000): PerfDocument {
  counter = 0;
  const value: PerfNode[] = [];
  let nodes = 0;
  let block = 0;
  const push = (node: PerfNode) => {
    value.push(node);
    nodes += countNodes(node);
  };

  while (nodes < targetNodes) {
    if (block % 40 === 0) push(heading(block / 40 + 1));
    else if (block % 40 === 10) push(codeBlock(block, 6));
    else if (block % 40 === 25) push(table(4, 3));
    else if (block % 8 < 3) push(listItem(block));
    else push(paragraph(block));
    block += 1;
  }

  return { schemaVersion: 1, value };
}

export function buildSmallPerfDocument(): PerfDocument {
  counter = 0;
  return {
    schemaVersion: 1,
    value: [
      { children: [{ text: PERF_SMALL_NOTE.readyText }], id: id(), type: 'p' },
    ],
  };
}
