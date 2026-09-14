import type { WorkbookViewerHandle } from '@betteroffice/xlsx/viewer';
import { strFromU8, unzipSync } from 'fflate';
import { uniqueCitation } from './citations';

const RELEVANT_PART =
  /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml)$/;
const WORKSHEET_PART = /^xl\/worksheets\/[^/]+\.xml$/;
const CELL_ADDRESS = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/;

export type CellCitation = {
  sheet: number;
  row: number;
  col: number;
  address: string;
};

/** Enumerate actual cell addresses from the current file; resolve displayed
 * values through the read-only viewer, without loading the editing engine. */
export function xlsxCitation(
  bytes: Uint8Array,
  handle: WorkbookViewerHandle,
  quote: string
): CellCitation | null {
  try {
    let xmlBytes = 0;
    const files = unzipSync(bytes, {
      filter: (entry) => {
        if (!RELEVANT_PART.test(entry.name)) return false;
        xmlBytes += entry.originalSize;
        // ponytail: bounded best-effort matching; large workbooks still open normally.
        if (xmlBytes > 20 * 1024 * 1024) throw new Error('citation XML limit');
        return true;
      },
    });
    const xml = (name: string) => {
      if (!files[name]) throw new Error('missing worksheet');
      const document = new DOMParser().parseFromString(
        strFromU8(files[name]),
        'application/xml'
      );
      if (document.getElementsByTagName('parsererror').length)
        throw new Error('invalid worksheet');
      return document;
    };
    const relationships = new Map(
      Array.from(
        xml('xl/_rels/workbook.xml.rels').getElementsByTagNameNS(
          '*',
          'Relationship'
        )
      )
        .filter((item) => item.getAttribute('TargetMode') !== 'External')
        .map((item) => [item.getAttribute('Id'), item.getAttribute('Target')])
    );
    const sheets = Array.from(
      xml('xl/workbook.xml').getElementsByTagNameNS('*', 'sheet')
    );
    const candidates: Array<CellCitation & { text: string }> = [];
    for (const [sheet, node] of sheets.entries()) {
      const id = node.getAttributeNS(
        'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
        'id'
      );
      const target = relationships.get(id);
      if (!target) return null;
      const part = target.startsWith('/xl/') ? target.slice(1) : `xl/${target}`;
      if (!WORKSHEET_PART.test(part)) return null;
      for (const cell of Array.from(
        xml(part).getElementsByTagNameNS('*', 'c')
      )) {
        if (candidates.length >= 20_000) return null;
        const address = cell.getAttribute('r') ?? '';
        const match = CELL_ADDRESS.exec(address);
        if (!match) return null;
        const row = Number(match[2]) - 1;
        const col =
          [...match[1]].reduce(
            (value, char) => value * 26 + char.charCodeAt(0) - 64,
            0
          ) - 1;
        if (row >= 1_048_576 || col >= 16_384) return null;
        candidates.push({
          address,
          col,
          row,
          sheet,
          text: handle.cellText(sheet, row, col),
        });
      }
    }
    return uniqueCitation(candidates, quote);
  } catch {
    return null;
  }
}
