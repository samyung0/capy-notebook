import { describe, expect, it } from 'vitest';
import { parseMermaidPreview } from './mermaidModel';

describe('parseMermaidPreview', () => {
  it('reads a mindmap root and its first level only', () => {
    expect(
      parseMermaidPreview(
        'mindmap\n  root((Respiration))\n    Glycolysis\n      Cytoplasm\n    [Link reaction]\n    ETC:::warm\n'
      )
    ).toEqual({
      children: ['Glycolysis', 'Link reaction', 'ETC'],
      root: 'Respiration',
      type: 'mindmap',
    });
  });

  it('reads flowchart nodes, shapes, chains, labels and direction', () => {
    expect(
      parseMermaidPreview(
        [
          '%% comment',
          'flowchart LR',
          '  S[Sample] --> D{pH < 7?}',
          '  D -->|yes| A(Acid) & B["Base (OH⁻)"]',
          '  B -- slow --> S; classDef x fill:#fff',
        ].join('\n')
      )
    ).toEqual({
      direction: 'LR',
      edges: [
        { from: 'S', label: undefined, to: 'D' },
        { from: 'D', label: 'yes', to: 'A' },
        { from: 'D', label: 'yes', to: 'B' },
        { from: 'B', label: 'slow', to: 'S' },
      ],
      nodes: [
        { id: 'S', label: 'Sample', shape: 'rect' },
        { id: 'D', label: 'pH < 7?', shape: 'diamond' },
        { id: 'A', label: 'Acid', shape: 'round' },
        { id: 'B', label: 'Base (OH⁻)', shape: 'rect' },
      ],
      type: 'flowchart',
    });
    expect(parseMermaidPreview('graph TD\n  A-->B\n  A --- C')).toMatchObject({
      direction: 'TD',
      edges: [
        { from: 'A', to: 'B' },
        { from: 'A', to: 'C' },
      ],
    });
  });

  it('reads sequence participants, aliases and messages', () => {
    expect(
      parseMermaidPreview(
        'sequenceDiagram\n  participant S as Student\n  S->>App: upload\n  App-->>+Server: parse\n  Note over App: waits\n  Server--)S: ready'
      )
    ).toEqual({
      actors: ['Student', 'App', 'Server'],
      messages: [
        { from: 0, text: 'upload', to: 1 },
        { from: 1, text: 'parse', to: 2 },
        { from: 2, text: 'ready', to: 0 },
      ],
      type: 'sequence',
    });
  });

  it('reads state names in order with the front matter title', () => {
    expect(
      parseMermaidPreview(
        '---\ntitle: Cell cycle\n---\nstateDiagram-v2\n  [*] --> G1\n  G1 --> S : replication\n  S --> G2\n  state "Mitosis" as M\n  G2 --> M\n  M --> G1\n  note right of M\n    splits\n  end note'
      )
    ).toEqual({
      states: ['G1', 'S', 'G2', 'Mitosis'],
      title: 'Cell cycle',
      type: 'state',
    });
  });

  it('reads pie slices', () => {
    expect(
      parseMermaidPreview(
        'pie showData title Diet\n  "Carbohydrate" : 45\n  "Fat" : 30.5\n  "None" : 0'
      )
    ).toEqual({
      slices: [
        { label: 'Carbohydrate', value: 45 },
        { label: 'Fat', value: 30.5 },
      ],
      type: 'pie',
    });
  });

  it('reads timeline periods with their first event', () => {
    expect(
      parseMermaidPreview(
        'timeline\n  title Cell biology\n  section Early\n  1665 : Hooke sees cells : cork\n       : more cork\n  1838 : Cell theory\n  2003'
      )
    ).toEqual({
      events: [
        { period: '1665', text: 'Hooke sees cells' },
        { period: '1838', text: 'Cell theory' },
        { period: '2003', text: '' },
      ],
      type: 'timeline',
    });
  });

  it('returns null for unsupported types and source it cannot read', () => {
    expect(parseMermaidPreview('classDiagram\n  Animal <|-- Duck')).toBeNull();
    expect(parseMermaidPreview('erDiagram\n  A ||--o{ B : has')).toBeNull();
    expect(parseMermaidPreview('flowchart LR\n  A[Unclosed node')).toBeNull();
    expect(parseMermaidPreview('pie\n  Fat 30')).toBeNull();
    expect(parseMermaidPreview('---\ntitle: open front matter')).toBeNull();
    expect(parseMermaidPreview('')).toBeNull();
  });
});
