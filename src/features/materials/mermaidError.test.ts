import { describe, expect, it } from 'vitest';
import { mermaidFailure } from './mermaidError';

// Messages as mermaid 11 throws them (captured 2026-10-09).
const parseError = (line: number) =>
  new Error(`Parse error on line ${line}:\n...\nExpecting 'SQE', got 'EOF'`);

describe('mermaidFailure', () => {
  it('reads the line from jison and langium messages', () => {
    const code = 'flowchart LR\n  A --> B\n  B -=> C\n  C --> D';
    expect(mermaidFailure(parseError(3), code)).toEqual({ line: 3 });
    expect(
      mermaidFailure(
        new Error(
          'Parsing failed:  Parse error on line 3, column 10: Expecting token'
        ),
        'pie title Pets\n  "Dogs" : 386\n  "Cats" 85'
      )
    ).toEqual({ line: 3 });
  });

  it('clamps an error at the end of the source onto its last line', () => {
    expect(
      mermaidFailure(parseError(3), 'flowchart LR\n  A[Unclosed node\n')
    ).toEqual({ line: 2 });
  });

  it('counts blank lines trimmed off the top before rendering', () => {
    expect(
      mermaidFailure(parseError(2), '\n\nflowchart LR\n  A[Unclosed')
    ).toEqual({ line: 4 });
  });

  it('names no line when the failure has none', () => {
    expect(
      mermaidFailure(
        new Error('No diagram type detected matching given configuration'),
        'flowchar LR'
      )
    ).toEqual({ line: null });
  });
});
