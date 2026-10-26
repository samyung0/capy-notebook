import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { m } from '@/i18n';
import type { RowProps } from '../schema';
import { ChatTable } from './ChatTable';
import { CitationContext } from './Cite';

const CELL = /<td[^>]*>.*?<\/td>/g;
const CITED_LAST_CELL =
  /^<td[^>]*>No ATP<sup[^>]*>.*>2<\/button><\/sup><\/td>$/;
const ROW_LINE = /Row \d/;
// Passage 7 shows as source 1 and passage 9 as source 2.
const SHOWN: Record<number, number> = { 7: 1, 9: 2 };

const row = (props: RowProps) => ({
  partial: false,
  props,
  type: 'element',
  typeName: 'Row',
});

describe('ChatTable', () => {
  it("puts a row's citations at the end of its last cell (Q358)", () => {
    const html = renderToStaticMarkup(
      <CitationContext.Provider value={{ numberOf: (n) => SHOWN[n] }}>
        <ChatTable
          props={{
            columns: ['Mechanism', 'Energy'],
            passages: [7, 9],
            rows: [
              row({ cells: ['Diffusion', 'No ATP'], passages: [9] }),
              row({ cells: ['Active transport', 'ATP'] }),
            ],
          }}
        />
      </CitationContext.Provider>
    );
    const cells = (rowIndex: number) =>
      html.split('<tr')[rowIndex + 2].match(CELL) ?? [];

    const [first, last] = cells(0);
    expect(first).not.toContain('<sup');
    expect(last).toMatch(CITED_LAST_CELL);
    expect(cells(1).join('')).not.toContain('<sup');
    expect(html).not.toMatch(ROW_LINE);
    // The table's own sources stay under it.
    expect(html.split('</table>')[1]).toContain(m.chat_sources());
  });
});
