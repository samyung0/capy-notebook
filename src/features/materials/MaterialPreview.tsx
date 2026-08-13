import { MarkdownPlugin } from '@platejs/markdown';
import { createSlateEditor } from 'platejs';
import { PlateStatic } from 'platejs/static';
import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import {
  createMaterialDocument,
  type MaterialDocument,
  type MaterialValue,
  parseMaterialDocument,
} from './document';
import { staticNoteComponents } from './staticNodeComponents';
import { StaticMaterialKit } from './staticPlugins';

/** Universal read-only renderer for the checkpointed material projection. */
export function MaterialPreview({
  content,
  className,
}: {
  content: string | MaterialDocument;
  className?: string;
}) {
  const editor = useMemo(
    () =>
      createSlateEditor({
        components: staticNoteComponents,
        plugins: StaticMaterialKit,
      }),
    []
  );

  const value = useMemo<MaterialValue>(() => {
    const document = parseMaterialDocument(content);
    if (document) return document.value;
    try {
      if (typeof content !== 'string') return content.value;
      const imported = editor
        .getApi(MarkdownPlugin)
        .markdown.deserialize(content) as MaterialValue;
      return createMaterialDocument(imported).value;
    } catch (cause) {
      if (import.meta.env.DEV)
        console.error(
          'MaterialPreview: markdown deserialization failed',
          cause
        );
      return [
        {
          children: [{ text: typeof content === 'string' ? content : '' }],
          type: 'p',
        },
      ];
    }
  }, [content, editor]);

  return (
    <div data-testid="material-preview">
      <PlateStatic
        className={cn(
          'note-editor mx-auto min-h-75 w-full max-w-3xl px-10 pt-4 pb-36 text-base outline-none max-sm:px-5',
          className
        )}
        editor={editor}
        value={value}
      />
    </div>
  );
}
