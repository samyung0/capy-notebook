import type { SourceFile } from '@/api/types';
import longXlsxURL from '../../bench/editor/fixtures/office/large-gradebook.xlsx?url';
import longDocxURL from '../../bench/editor/fixtures/office/long-handbook.docx?url';
import rowsXlsxURL from '../../bench/editor/fixtures/office/rows-50k.xlsx?url';
import longPptxURL from '../../bench/parsers/fixtures/docs/jp_llm2.pptx?url';
import xlsxURL from '../../e2e/fixtures/files/rich-content/course-guide.xlsx?url';
import docxURL from '../../e2e/fixtures/files/rich-content/exchange-plan.docx?url';
import pptxURL from '../../e2e/fixtures/files/rich-content/lecture.pptx?url';
import longDocxStateURL from './fixtures/long-docx-checkpoint.bin?url';
import longPptxStateURL from './fixtures/long-pptx-checkpoint.bin?url';
import longXlsxStateURL from './fixtures/long-xlsx-checkpoint.bin?url';
import docxStateURL from './fixtures/rich-docx-checkpoint.bin?url';
import pptxStateURL from './fixtures/rich-pptx-checkpoint.bin?url';
import xlsxStateURL from './fixtures/rich-xlsx-checkpoint.bin?url';
import rowsXlsxStateURL from './fixtures/rows-xlsx-checkpoint.bin?url';

export const biologyOfficeFixtures = [
  {
    format: 'docx',
    id: 'bio-office-docx',
    kind: 'doc',
    name: 'exchange-plan.docx',
    sizeBytes: 65_718,
    sourceURL: docxURL,
    stateURL: docxStateURL,
  },
  {
    format: 'xlsx',
    id: 'bio-office-xlsx',
    kind: 'sheet',
    name: 'course-guide.xlsx',
    sizeBytes: 145_425,
    sourceURL: xlsxURL,
    stateURL: xlsxStateURL,
  },
  {
    format: 'pptx',
    id: 'bio-office-pptx',
    kind: 'slides',
    name: 'lecture.pptx',
    sizeBytes: 311_193,
    sourceURL: pptxURL,
    stateURL: pptxStateURL,
  },
  // The large files of the Office perf spec (bench/editor), seeded by
  // VITE_LOAD_TEST_SEED like the editor perf notes.
  ...(import.meta.env.VITE_LOAD_TEST_SEED === 'true'
    ? ([
        {
          format: 'docx',
          id: 'bio-office-docx-long',
          kind: 'doc',
          name: 'long-handbook.docx',
          sizeBytes: 41_117,
          sourceURL: longDocxURL,
          stateURL: longDocxStateURL,
        },
        {
          format: 'xlsx',
          id: 'bio-office-xlsx-long',
          kind: 'sheet',
          name: 'large-gradebook.xlsx',
          sizeBytes: 1_362_647,
          sourceURL: longXlsxURL,
          stateURL: longXlsxStateURL,
        },
        // One sheet of 50,000 rows, scrolled by the spec.
        {
          format: 'xlsx',
          id: 'bio-office-xlsx-rows',
          kind: 'sheet',
          name: 'rows-50k.xlsx',
          sizeBytes: 3_282_402,
          sourceURL: rowsXlsxURL,
          stateURL: rowsXlsxStateURL,
        },
        {
          format: 'pptx',
          id: 'bio-office-pptx-long',
          kind: 'slides',
          name: 'jp_llm2.pptx',
          sizeBytes: 24_390_706,
          sourceURL: longPptxURL,
          stateURL: longPptxStateURL,
        },
      ] as const)
    : []),
] as const;

/** A standalone DOCX (no workspace) over the exchange plan's bytes, so the
 * Files page shows an Office file that opens read-only outside a workspace. */
export const standaloneOfficeFixtures = [
  {
    ...biologyOfficeFixtures[0],
    id: 'standalone-office-docx',
    name: 'Internship application.docx',
  },
] as const;

/** The mock worker's legacy Office conversion, as the server completes one
 * (`CompleteLegacyConvert`): the file takes its new format's name and a
 * revision. A fixture stands in for the converted bytes; its link is
 * returned. */
export function convertMockLegacyFile(
  file: Pick<SourceFile, 'name' | 'revision' | 'sizeBytes'>,
  convertTo: 'docx' | 'xlsx' | 'pptx'
): string {
  const fixture = biologyOfficeFixtures.find(
    ({ format }) => format === convertTo
  );
  if (!fixture) throw new Error(`No ${convertTo} fixture`);
  file.name = file.name.replace(/[^.]+$/, convertTo);
  file.revision += 1;
  file.sizeBytes = fixture.sizeBytes;
  return fixture.sourceURL;
}

/** The worker's one ingest event after that swap (`_publish_converted` in
 * pipeline/ingest/worker.py): waiting for the parse the gateway queued, or
 * with parsing off stored as it is. */
export function mockConvertedEvent(name: string, parseMode: string) {
  return parseMode === 'none'
    ? {
        indexed: false,
        message: `${name}: stored without parsing (not indexed for retrieval).`,
        pct: 100,
        stage: 'done',
        status: 'ready' as const,
      }
    : { message: '', pct: 5, stage: 'queued', status: 'pending' as const };
}
