import type { FileKind } from '@/api/types';
import { m } from '@/i18n';

export function fileKindLabel(kind: FileKind): string {
  switch (kind) {
    case 'pdf':
      return m.file_kind_pdf();
    case 'doc':
      return m.file_kind_doc();
    case 'md':
      return m.file_kind_md();
    case 'image':
      return m.file_kind_image();
    case 'txt':
      return m.file_kind_txt();
    case 'sheet':
      return m.file_kind_sheet();
    case 'slides':
      return m.file_kind_slides();
    case 'audio':
      return m.file_kind_audio();
    case 'json':
      return m.file_kind_json();
    default:
      return m.file_kind_unknown();
  }
}
