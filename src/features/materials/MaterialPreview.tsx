import { createSlateEditor } from 'platejs';
import { PlateStatic } from 'platejs/static';
import { memo, useMemo } from 'react';
import type { MaterialKind } from '@/api/types';
import { useNoteEditorPrefs } from '@/features/notes/noteEditorPrefs';
import { cn } from '@/lib/cn';
import {
  type MaterialDocument,
  type MaterialValue,
  parseMaterialDocument,
} from './document';
import { MaterialRenderProvider } from './MaterialRenderContext';
import { staticNoteComponents } from './staticNodeComponents';
import { StaticMaterialKit } from './staticPlugins';

/** Universal read-only renderer for the checkpointed material projection.
 * Markdown files convert first (files/MarkdownPreview.tsx); the renderer
 * itself carries no markdown parser. Memoized: a material refetch that brings
 * equal content (structurally shared, so the same object) must not re-render
 * the document. A note's live View passes its parsed `value` instead (the
 * room's, block by block): PlateStatic re-renders a top-level block only when
 * its object changes. */
export const MaterialPreview = memo(function MaterialPreview({
  content,
  isStandalone,
  kind,
  className,
  title,
  value: given,
}: {
  content: MaterialDocument;
  isStandalone?: boolean;
  kind?: MaterialKind;
  className?: string;
  title?: string;
  value?: MaterialValue;
}) {
  const displayWidth = useNoteEditorPrefs((state) => state.displayWidth);
  const editor = useMemo(
    () =>
      createSlateEditor({
        components: staticNoteComponents,
        plugins: StaticMaterialKit,
      }),
    []
  );

  const parsed = useMemo<MaterialValue | null>(
    () =>
      given ? null : (parseMaterialDocument(content)?.value ?? content.value),
    [content, given]
  );
  const value = given ?? parsed ?? content.value;
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
            'note-editor mx-auto min-h-75 w-full px-5 pt-4 pb-36 text-base outline-none sm:px-10',
            (kind !== 'note' || displayWidth === 'half') && 'md:max-w-3xl',
            className
          )}
          editor={editor}
          value={value}
        />
      </MaterialRenderProvider>
    </div>
  );
});
