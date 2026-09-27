import xlsxURL from '../../e2e/fixtures/files/rich-content/course-guide.xlsx?url';
import docxURL from '../../e2e/fixtures/files/rich-content/exchange-plan.docx?url';
import pptxURL from '../../e2e/fixtures/files/rich-content/lecture.pptx?url';
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
] as const;
