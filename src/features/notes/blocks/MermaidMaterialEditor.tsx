import { NodeApi, type TElement } from 'platejs';
import { useEditorRef, useEditorSelector } from 'platejs/react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import type { MermaidElement } from '@/features/materials/document';
import { MediaFrame } from '@/features/materials/MediaFrame';
import { MermaidPreview } from '@/features/materials/MediaPreview';
import { Mermaid, mermaidFailureMessage } from '@/features/materials/Mermaid';
import { MermaidCodeEditor } from '@/features/materials/MermaidCodeEditor';
import type { MermaidFailure } from '@/features/materials/mermaidError';
import {
  type MermaidTheme,
  mermaidTheme,
} from '@/features/materials/mermaidThemes';
import { MERMAID_CAPTION_CLASS } from '@/features/notes/nodeStyles';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { MermaidThemeMenu } from './elements';
import { setMermaidCaption } from './mermaidBlock';

interface Draft {
  caption: string;
  source: string;
  theme: MermaidTheme;
}

/** Typing settles this long before the preview redraws. */
const PREVIEW_DELAY_MS = 250;

/**
 * Edit mode of a standalone mindmap or diagram: source on the left, the live
 * preview on the right (one at a time on phones, behind a Preview toggle).
 * Changes stay in a draft until Save writes them into the room through the
 * mounted editor, the same transforms the note block's dialog uses; Cancel
 * drops them. Live per-keystroke editing is planned in todo-office.md.
 */
export function MermaidMaterialEditor({ title }: { title: string }) {
  const editor = useEditorRef();
  const node = useEditorSelector(
    (current) =>
      current.children.find(
        (child): child is TElement => child.type === 'mermaid'
      ),
    []
  );
  const stored: Draft | null = node
    ? {
        caption: NodeApi.string(node),
        source: (node as unknown as MermaidElement).source,
        theme: mermaidTheme((node as unknown as MermaidElement).theme),
      }
    : null;
  // Null follows the room; a draft holds until Save or Cancel.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [failure, setFailure] = useState<MermaidFailure | null>(null);
  const shown = draft ?? stored;
  const [previewCode, setPreviewCode] = useState(shown?.source ?? '');
  // The full-screen view shows the last source that drew; none drew yet
  // (a broken diagram opened in Edit), nothing opens.
  const [drawnCode, setDrawnCode] = useState<string | null>(null);
  const source = shown?.source ?? '';
  useEffect(() => {
    const timer = setTimeout(() => setPreviewCode(source), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [source]);

  if (!(shown && stored)) return null;
  const dirty =
    draft !== null &&
    (draft.source !== stored.source ||
      draft.theme !== stored.theme ||
      draft.caption !== stored.caption);
  const change = (patch: Partial<Draft>) => setDraft({ ...shown, ...patch });
  const save = () => {
    if (!(draft && node)) return;
    // By index: path lookups by node need the rendered editor, absent here.
    const at = [editor.children.indexOf(node)];
    if (at[0] === -1) return;
    editor.tf.setNodes({ source: draft.source, theme: draft.theme }, { at });
    if (draft.caption !== stored.caption)
      setMermaidCaption(editor, at, draft.caption);
    setDraft(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-12 items-center gap-2 border-divider border-b px-4 py-2">
        <MermaidThemeMenu
          compactOnPhones
          onTheme={(theme) => change({ theme })}
          theme={shown.theme}
        />
        <ToolbarButton
          active={showPreview}
          className="w-auto! gap-1.5 px-2 text-sm md:hidden"
          label={showPreview ? m.mermaid_show_code() : m.mermaid_show_preview()}
          onClick={() => setShowPreview((value) => !value)}
        >
          <Icon name={showPreview ? 'code' : 'view'} />
          <span className="translate-y-px">
            {showPreview ? m.mermaid_show_code() : m.mermaid_show_preview()}
          </span>
        </ToolbarButton>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {/* A blamed line is marked in the source instead. */}
          {failure && failure.line == null && (
            <p className="min-w-0 truncate font-semibold text-sm text-solid-error">
              {mermaidFailureMessage(failure)}
            </p>
          )}
          <Button
            disabled={!dirty}
            onClick={() => setDraft(null)}
            size="sm"
            variant="ghost-hover"
          >
            {m.action_cancel()}
          </Button>
          <Button
            disabled={!(dirty && shown.source.trim())}
            onClick={save}
            size="sm"
            variant="accent"
          >
            {m.action_save()}
          </Button>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] md:grid-cols-2">
        <MermaidCodeEditor
          className={cn(
            'overflow-auto md:block md:border-divider md:border-r',
            showPreview && 'hidden'
          )}
          errorLine={failure?.line ?? null}
          label={m.editor_mermaid_source()}
          onChange={(next) => change({ source: next })}
          value={shown.source}
        />
        <div
          className={cn(
            'min-h-0 flex-col gap-3 overflow-auto px-4 py-5 md:flex md:px-6',
            showPreview ? 'flex' : 'hidden'
          )}
        >
          <MediaFrame
            fill
            onOpen={drawnCode === null ? undefined : () => setPreviewing(true)}
          >
            <Mermaid
              code={previewCode}
              onError={(next) => {
                setFailure(next);
                if (!next) setDrawnCode(previewCode);
              }}
              theme={shown.theme}
            />
          </MediaFrame>
          <input
            aria-label={m.editor_caption_add()}
            className={cn(
              MERMAID_CAPTION_CLASS,
              'mt-0 block w-full bg-transparent outline-none placeholder:text-placeholder'
            )}
            onChange={(event) => change({ caption: event.target.value })}
            placeholder={m.editor_caption_placeholder()}
            value={shown.caption}
          />
        </div>
      </div>
      <MermaidPreview
        caption={shown.caption}
        code={drawnCode ?? ''}
        onOpenChange={setPreviewing}
        open={previewing}
        theme={shown.theme}
        title={title}
      />
    </div>
  );
}
