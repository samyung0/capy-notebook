import longDocxURL from '../../bench/editor/fixtures/office/long-handbook.docx?url';
import xlsxURL from '../../e2e/fixtures/files/rich-content/course-guide.xlsx?url';
import docxURL from '../../e2e/fixtures/files/rich-content/exchange-plan.docx?url';
import pptxURL from '../../e2e/fixtures/files/rich-content/lecture.pptx?url';
import longDocxStateURL from './fixtures/long-docx-checkpoint.bin?url';
import docxStateURL from './fixtures/rich-docx-checkpoint.bin?url';
import pptxStateURL from './fixtures/rich-pptx-checkpoint.bin?url';
import xlsxStateURL from './fixtures/rich-xlsx-checkpoint.bin?url';

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
  // The 62-page document of the Office perf spec (bench/editor), seeded by
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
      ] as const)
    : []),
] as const;
