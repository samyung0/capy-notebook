import { useMemo } from 'react';
import { createMaterialDocument } from '@/features/materials/document';
import { MaterialPreview } from '@/features/materials/MaterialPreview';
import { markdownToDocument } from '@/features/notes/markdownConvert';

/** An uploaded markdown file, converted with the editor's markdown import and
 * shown with the note renderer. Text that fails to convert shows as written. */
export default function MarkdownPreview({ text }: { text: string }) {
  const document = useMemo(() => {
    try {
      return markdownToDocument(text);
    } catch {
      return createMaterialDocument([{ children: [{ text }], type: 'p' }]);
    }
  }, [text]);
  return <MaterialPreview className="mx-auto max-w-175" content={document} />;
}
