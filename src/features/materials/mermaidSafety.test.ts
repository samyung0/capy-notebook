import { describe, expect, it } from 'vitest';
import { withoutImageFunctions } from './mermaidSafety';

/** A style line (always line 3 here) that loads an image is blanked; the
 * rest of the diagram is kept. */
const afterBlanking = (style: string) =>
  withoutImageFunctions(`flowchart LR\n  A --> B\n${style}\n  B --> C`);
const BLANKED = 'flowchart LR\n  A --> B\n\n  B --> C';

describe('withoutImageFunctions', () => {
  it('keeps ordinary diagrams as written', () => {
    for (const code of [
      [
        'flowchart LR',
        '  A["Use curl (or wget)\\nthen parse"] --> B(Round)',
        '  style A fill:#f9f,stroke:#333,stroke-width:4px;',
        '  classDef hot fill:#f96,color:#fff',
        '  linkStyle 0 stroke:#ff3,stroke-width:4px',
        '  B:::hot --> C{"#quot;Quoted#quot; #9829;"}',
      ].join('\n'),
      '---\ntitle: Cells\nconfig:\n  theme: forest\n---\n%%{init: {"flowchart": {"curve": "basis"}}}%%\nflowchart TD\n  A --> B',
      'sequenceDiagram\n  Alice->>Bob: hurl (or curl) the URL\\nline two',
      // A space between the name and the bracket is not a CSS fetch, so prose
      // keeps its line.
      'flowchart LR\n  A["read the URL (a link) first"] --> B',
    ])
      expect(withoutImageFunctions(code)).toBe(code);
  });

  it('blanks style, class and theme lines that load an image', () => {
    for (const style of [
      '  style A fill:url(https://outside.test/a.png)',
      '  classDef c background-image:URL(https://outside.test/a.png)',
      '  linkStyle 0 stroke:#f00,mask-image:url(https://outside.test/a.png)',
      '  style A mask-image:image-set("https://outside.test/a.png" 1x)',
      '  style A mask:-webkit-image-set("https://outside.test/a.png" 1x)',
      '  A["<span style=\'background:url(//outside.test/a)\'>a</span>"]',
      '%%{init: {"themeCSS": ".node{background:url(https://o.test)}"}}%%',
    ])
      expect(afterBlanking(style)).toBe(BLANKED);
  });

  it('reads CSS, JSON and YAML escapes and HTML and mermaid entities', () => {
    for (const spelled of [
      '\\75 rl(',
      'u\\rl(',
      'u\\72 l(',
      '\\000075rl(',
      'u&#114;l(',
      'url&#x28;',
      'url&#40',
      'url&lpar;',
      'url#lpar;',
      '#117;rl(',
      'url#40;',
      'ﬂ°°117¶ßrl(',
      'url&bsol;28 ',
      '\\\\75 rl(',
      'url;(',
      'url%%{init: {}}%%(',
    ])
      expect(
        afterBlanking(`  style A background:${spelled}https://o.test/a)`)
      ).toBe(BLANKED);
    expect(
      afterBlanking(
        '%%{init: {"themeVariables": {"primaryColor": "\\u0075rl(o.test)"}}}%%'
      )
    ).toBe(BLANKED);
    expect(afterBlanking('  img: "\\x75rl(https://o.test/a.png)"')).toBe(
      BLANKED
    );
  });

  it('refuses an image function spelled across lines', () => {
    expect(() =>
      withoutImageFunctions(
        '---\nconfig:\n  themeVariables:\n    x: "u\\\n      rl(https://o.test)"\n---\nflowchart LR\n  A'
      )
    ).toThrow();
    expect(() =>
      withoutImageFunctions(
        'flowchart LR\n  style A fill:url%%{init:\n}%%(https://o.test)'
      )
    ).toThrow();
  });
});
