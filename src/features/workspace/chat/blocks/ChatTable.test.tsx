import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CitationContext } from './Cite';
import { Prose } from './text';

const CELL = /<td[^>]*>.*?<\/td>/g;
const CITED_LAST_CELL =
  /^<td[^>]*>No ATP<sup[^>]*>.*>2<\/button><\/sup><\/td>$/;
// Passage 7 shows as source 1 and passage 9 as source 2.
const SHOWN: Record<number, number> = { 7: 1, 9: 2 };

describe('Markdown tables', () => {
  it("draw in the chat's table look, without Streamdown's frame or buttons", () => {
    const md = renderToStaticMarkup(
      <Prose text={'| Tool | Result |\n|---|---|\n| `list_sources` | ok |'} />
    );

    expect(md).not.toContain('data-streamdown="table-wrapper"');
    expect(md).not.toContain('<button');
    expect(md).toContain('<thead><tr');
  });

  it("put a row's citations at the end of its last cell (Q358)", () => {
    const html = renderToStaticMarkup(
      <CitationContext.Provider value={{ numberOf: (n) => SHOWN[n] }}>
        <Prose
          text={
            '| Mechanism | Energy |\n|---|---|\n| Diffusion | No ATP [#9] |\n| Active transport | ATP |'
          }
        />
      </CitationContext.Provider>
    );
    const cells = (rowIndex: number) =>
      html.split('<tr')[rowIndex + 2].match(CELL) ?? [];

    const [first, last] = cells(0);
    expect(first).not.toContain('<sup');
    expect(last).toMatch(CITED_LAST_CELL);
    expect(cells(1).join('')).not.toContain('<sup');
  });
});
