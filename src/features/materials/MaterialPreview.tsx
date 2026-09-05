import { MarkdownPlugin } from '@platejs/markdown';
import { createSlateEditor } from 'platejs';
import { PlateStatic } from 'platejs/static';
import { useMemo } from 'react';
import type { MaterialKind } from '@/api/types';
import { cn } from '@/lib/cn';
import {
  createMaterialDocument,
  type MaterialDocument,
  type MaterialValue,
  parseMaterialDocument,
} from './document';
import { MaterialRenderProvider } from './MaterialRenderContext';
import { staticNoteComponents } from './staticNodeComponents';
import { StaticMaterialKit } from './staticPlugins';

/** Universal read-only renderer for the checkpointed material projection. */
export function MaterialPreview({
  content,
  isStandalone,
  kind,
  className,
  title,
}: {
  content: string | MaterialDocument;
  isStandalone?: boolean;
  kind?: MaterialKind;
  className?: string;
  title?: string;
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
  const renderContext = useMemo(
    () =>
      kind && title ? { isStandalone: !!isStandalone, kind, title } : null,
    [isStandalone, kind, title]
  );

  return (
    <div data-testid="material-preview">
      <MaterialRenderProvider value={renderContext}>
        <PlateStatic
          className={cn(
            'note-editor mx-auto min-h-75 w-full max-w-3xl px-10 pt-4 pb-36 text-base outline-none max-sm:px-5',
            className
          )}
          editor={editor}
          value={value}
        />
      </MaterialRenderProvider>
    </div>
  );
}
