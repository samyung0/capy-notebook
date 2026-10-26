import { BaseCodeBlockPlugin } from '@platejs/code-block';
import { common, createLowlight } from 'lowlight';
import { createSlateEditor, type SlateEditor } from 'platejs';
import { ElementStatic, pipeDecorate } from 'platejs/static';
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
import { UnsupportedBlockPlugin } from './UnsupportedBlock';

const lowlight = createLowlight(common);
/** The kit with its render-only parts, which the markdown converter leaves
 * out: code highlighting and the unsupported-block notice. */
const renderPlugins = [
  ...StaticMaterialKit.map((plugin) =>
    plugin.key === BaseCodeBlockPlugin.key
      ? BaseCodeBlockPlugin.configure({ options: { lowlight } })
      : plugin
  ),
  UnsupportedBlockPlugin,
];

/** Universal read-only renderer for the checkpointed material projection.
 * Markdown files convert first (files/MarkdownPreview.tsx); the renderer
 * itself carries no markdown parser. Memoized: a material refetch that brings
 * equal content (structurally shared, so the same object) must not re-render
 * the document. A note's live View passes its parsed `value` instead (the
 * room's, block by block): a top-level block re-renders only when its object
 * changes. */
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
        plugins: renderPlugins,
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
        <KeyedStatic
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

/**
 * PlateStatic's document root with its top-level blocks keyed by block id
 * (live-items REVIEW5 M1). PlateStatic keys them by index, so a block added or
 * removed above a reader handed every block below another block's element:
 * they re-rendered, embeds remounted (a quiz lost its answers and rejoined its
 * room, frames reloaded) and the browser's scroll anchoring lost its place.
 * Keyed by id, a block keeps its element and its DOM wherever it moves, and
 * one that did not change is not rendered again. No range is computed per
 * block (REVIEW5 N3): the top level has no decorations to intersect, so only
 * the decorate plugins (code highlighting) run. The static kit has no plugin
 * that renders around the document.
 */
function KeyedStatic({
  className,
  editor,
  value,
}: {
  className: string;
  editor: SlateEditor;
  value: MaterialValue;
}) {
  editor.children = value;
  const decorate = pipeDecorate(editor);
  const seen = new Set<unknown>();
  return (
    <div
      className={cn('slate-editor', className)}
      data-slate-editor
      data-slate-node="value"
    >
      {value.map((block, index) => {
        const path = [index];
        // A repeated or missing id (never written by the editor) keys by place.
        const key =
          typeof block.id === 'string' && !seen.has(block.id)
            ? block.id
            : `#${index}`;
        seen.add(block.id);
        return (
          <ElementStatic
            decorate={decorate}
            decorations={decorate ? decorate([block, path]) : NONE}
            editor={editor}
            element={block}
            key={key}
            path={path}
          />
        );
      })}
    </div>
  );
}

const NONE: [] = [];
