import type { SourceFile } from '@/api/types';

export const dialogFiles = [
  {
    hasBytes: true,
    id: 'mock-preview-links',
    kind: 'pdf',
    name: 'File link error.pdf',
  },
  {
    hasBytes: true,
    id: 'mock-preview-annotations',
    kind: 'pdf',
    name: 'Annotation load error.pdf',
  },
  {
    hasBytes: false,
    id: 'mock-preview-empty',
    kind: 'txt',
    name: 'No stored bytes.txt',
  },
  {
    hasBytes: true,
    id: 'mock-preview-legacy',
    kind: 'doc',
    name: 'Legacy document.doc',
  },
  {
    hasBytes: true,
    id: 'mock-preview-pdf',
    kind: 'pdf',
    name: 'Broken preview.pdf',
  },
  {
    hasBytes: true,
    id: 'mock-preview-csv',
    kind: 'sheet',
    name: 'Broken preview.csv',
  },
  {
    hasBytes: true,
    id: 'mock-preview-audio',
    kind: 'audio',
    name: 'Broken preview.mp3',
  },
  {
    hasBytes: true,
    id: 'mock-preview-image',
    kind: 'image',
    name: 'Broken preview.png',
  },
  {
    hasBytes: true,
    id: 'mock-preview-docx',
    kind: 'doc',
    name: 'Office session error.docx',
  },
  {
    hasBytes: true,
    id: 'mock-preview-xlsx',
    kind: 'sheet',
    name: 'Office session error.xlsx',
  },
  {
    hasBytes: true,
    id: 'mock-preview-pptx',
    kind: 'slides',
    name: 'Office session error.pptx',
  },
  {
    hasBytes: true,
    id: 'mock-preview-text',
    kind: 'txt',
    name: 'Edit source error.txt',
  },
] satisfies Array<Pick<SourceFile, 'id' | 'name' | 'kind' | 'hasBytes'>>;

export function dialogSourceFile(id: string): SourceFile {
  const fixture = dialogFiles.find((file) => file.id === id);
  if (!fixture) throw new Error(`Unknown mock file preview: ${id}`);
  return {
    ...fixture,
    addedAt: '2026-09-15T00:00:00Z',
    chapterId: null,
    indexed: false,
    position: 0,
    revision: 1,
    sizeBytes: 2048,
    status: 'failed',
    workspaceId: 'ws_bio',
  };
}
