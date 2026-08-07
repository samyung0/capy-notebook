import type { FileKind } from '@/api/types';

export const FILE_KIND_MAPPING: Record<FileKind, string> = {
  audio: 'Audio',
  doc: 'Word',
  image: 'Image',
  json: 'Json',
  md: 'Markdown',
  pdf: 'Pdf',
  sheet: 'Spreadsheet',
  slides: 'Slides',
  txt: 'Text',
  unknown: 'Unknown',
};
