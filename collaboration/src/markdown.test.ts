import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { convertAgentMarkdown } from './markdown.js';

describe('markdownToDocument', () => {
  beforeAll(() => {
    execFileSync(
      'node',
      [
        fileURLToPath(
          new URL('../scripts/build-markdown.mjs', import.meta.url)
        ),
      ],
      { stdio: 'inherit' }
    );
  }, 60_000);

  it('converts through the bundled editor import', async () => {
    const { document, embedded } = await convertAgentMarkdown(
      '## Mini check\n\n```quiz\nquestions:\n  - {id: q1}\n```\n\n```mermaid\nflowchart LR\n  A --> B\n```'
    );
    expect(embedded).toEqual([{ kind: 'quiz', questions: [{ id: 'q1' }] }]);
    expect(document.schemaVersion).toBe(1);
    expect(document.value).toMatchObject([
      { type: 'h2' },
      { refKind: 'quiz', type: 'material_ref' },
      { type: 'mermaid' },
    ]);
  });
});
