import { encodeUrlIfNeeded, validateUrl } from '@platejs/link';
import { ListStyleType, toggleList } from '@platejs/list';
import {
  AtSign,
  Baseline,
  Bold,
  Code2,
  Columns2,
  Columns3,
  Highlighter,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  MessageSquarePlus,
  PaintBucket,
  Redo2,
  Sigma,
  Sparkles,
  Strikethrough,
  Underline,
  Undo2,
} from 'lucide-react';
import { KEYS } from 'platejs';
import { useEditorRef, useEditorSelector } from 'platejs/react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
import { openAiMenu } from '@/features/notes/ai/aiMenuState';
import { useCollaborationActions } from '@/features/notes/Collaboration';
import {
  importDocxDocument,
  importJsonDocument,
  importMarkdownDocument,
} from '@/features/notes/documentAdapters';
import { useEditorRuntime } from '@/features/notes/EditorRuntime';
import { EDITOR_COMMANDS } from '@/features/notes/editorCommands';
import {
  canCreateExternalEditorAssets,
  isEditorCommandAllowed,
} from '@/features/notes/editorMode';
import { toggleEditorBlock } from '@/features/notes/editorTransforms';
import {
  cloneLinkSelection,
  type LinkSelection,
  upsertLinkAtSelection,
} from '@/features/notes/linkEditor';
import { useNoteEditorPrefs } from '@/features/notes/noteEditorPrefs';
import { getHiddenToolbarGroupIndexes } from '@/features/notes/responsiveToolbar';
import { AlignMenu } from '@/features/notes/toolbar/ToolbarAlignMenu';
import { ToolbarAllBlocksMenu } from '@/features/notes/toolbar/ToolbarAllBlocksMenu';
import { BlockTypeMenu } from '@/features/notes/toolbar/ToolbarBlockTypeMenu';
import {
  EDITOR_SHORTCUTS,
  ToolbarButton,
} from '@/features/notes/toolbar/ToolbarButton';
import { ExportMenu } from '@/features/notes/toolbar/ToolbarExportMenu';
import { FontColorControl } from '@/features/notes/toolbar/ToolbarFontColorControl';
import { FontSizeControl } from '@/features/notes/toolbar/ToolbarFontSizeControl';
import {
  type ImportKind,
  ImportMenu,
} from '@/features/notes/toolbar/ToolbarImportMenu';
import { MediaUploadMenu } from '@/features/notes/toolbar/ToolbarMediaUploadMenu';
import { TableMenu } from '@/features/notes/toolbar/ToolbarTableMenu';
import { WidgetSettingsDialog } from '@/features/notes/toolbar/ToolbarWidgetSettingsDialog';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { VoiceButton } from '../ai/VoiceButton';

// TODO: what is this
// Plate's plugin transforms are intentionally richer than its base editor type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEditor = any;

function ToolbarGroup({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex h-full shrink-0 items-center gap-0 after:mx-1.5 after:h-7 after:w-px after:bg-divider last:after:hidden',
        className
      )}
      data-toolbar-group
    >
      {children}
    </div>
  );
}

function updateResponsiveToolbar(container: HTMLDivElement) {
  const elements = Array.from(
    container.querySelectorAll<HTMLElement>(':scope > [data-toolbar-group]')
  );
  elements.forEach((element) => {
    element.hidden = false;
  });
  const groups = elements.map((element) => ({
    width: element.getBoundingClientRect().width,
  }));
  const hiddenIndexes = getHiddenToolbarGroupIndexes(
    groups,
    Math.max(0, container.clientWidth - 2)
  );

  elements.forEach((element, index) => {
    element.hidden = hiddenIndexes.has(index);
  });
}

export function NoteToolbar({ className }: { className?: string }) {
  const editor = useEditorRef() as AnyEditor;
  const toolbarGroupsRef = useRef<HTMLDivElement>(null);
  const { mode, allowExternalAssets, canComment } = useEditorRuntime();
  const canCreateAssets = canCreateExternalEditorAssets(
    mode,
    allowExternalAssets
  );
  const enabled = useNoteEditorPrefs((state) => state.enabled);
  const collaboration = useCollaborationActions();
  const canUndo = useEditorSelector((ed) => ed.history.undos.length > 0, []);
  const canRedo = useEditorSelector((ed) => ed.history.redos.length > 0, []);

  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkText, setLinkText] = useState('');
  const [linkError, setLinkError] = useState('');
  const [editingLink, setEditingLink] = useState(false);
  const linkSelectionRef = useRef<LinkSelection | null>(null);
  const allBlockCommands = useMemo(
    () =>
      EDITOR_COMMANDS.filter(
        (command) =>
          enabled[command.group] &&
          isEditorCommandAllowed(mode, command, allowExternalAssets)
      ),
    [allowExternalAssets, enabled, mode]
  );
  const twoColumnCommand = allBlockCommands.find(
    (command) => command.id === 'columns'
  );
  const threeColumnCommand = allBlockCommands.find(
    (command) => command.id === 'columns-equal-3'
  );
  const inlineEquationCommand = allBlockCommands.find(
    (command) => command.id === 'inline-equation'
  );
  const mentionCommand = allBlockCommands.find(
    (command) => command.id === 'mention'
  );

  useLayoutEffect(() => {
    const container = toolbarGroupsRef.current;
    if (!container) return;

    const update = () => updateResponsiveToolbar(container);
    const resizeObserver = new ResizeObserver(update);
    const mutationObserver = new MutationObserver(update);

    update();
    resizeObserver.observe(container);
    mutationObserver.observe(container, { childList: true, subtree: true });

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, []);

  const mark = (key: string) => {
    editor.tf.focus();
    editor.tf.toggleMark(key);
  };
  const block = (type: string) => {
    editor.tf.focus();
    toggleEditorBlock(editor, type);
  };
  async function importFile(file: File, kind: ImportKind) {
    const document =
      kind === 'docx'
        ? await importDocxDocument(editor, await file.arrayBuffer())
        : kind === 'json'
          ? importJsonDocument(editor, await file.text())
          : importMarkdownDocument(editor, await file.text());
    editor.tf.insertNodes(document.value);
  }

  function applyLink() {
    const url = encodeUrlIfNeeded(linkUrl.trim());
    if (!url) return;
    if (!validateUrl(editor, url)) {
      setLinkError(m.editor_link_invalid());
      return;
    }

    const selection = linkSelectionRef.current;
    if (!selection) {
      setLinkError(m.editor_link_selection_lost());
      return;
    }

    if (!upsertLinkAtSelection(editor, selection, { text: linkText, url })) {
      setLinkError(m.editor_link_select_text());
      return;
    }

    setLinkOpen(false);
    setLinkUrl('');
    setLinkText('');
    setLinkError('');
    linkSelectionRef.current = null;
  }

  if (mode === 'comment') {
    return (
      <div
        aria-label={m.editor_comment_tools()}
        className={cn(
          'sticky top-0 z-20 flex h-10 items-center border-divider border-b bg-surface/95 px-2 backdrop-blur-sm',
          className
        )}
        role="toolbar"
      >
        {canComment && collaboration && (
          <ToolbarGroup>
            <ToolbarButton
              disabled={collaboration.mutationPending}
              label={m.editor_comment()}
              onClick={collaboration.openComment}
            >
              <MessageSquarePlus />
            </ToolbarButton>
          </ToolbarGroup>
        )}
      </div>
    );
  }

  return (
    <>
      <div
        aria-label={m.editor_doc_formatting()}
        className={cn(
          'sticky top-0 z-20 flex h-10 items-center border-divider border-b bg-surface/95 px-2 backdrop-blur-sm',
          className
        )}
        role="toolbar"
      >
        {/* Outside the responsive container on purpose. The all-blocks menu is
         * the only way to reach a command whose own group has been dropped, so
         * it cannot live in a box that hides and clips its children — it sits
         * ahead of that box and takes its width off the top. */}
        {enabled.general && (
          <ToolbarGroup className="gap-1">
            {canComment && collaboration && (
              <ToolbarButton
                disabled={collaboration.mutationPending}
                label={m.editor_comment()}
                onClick={collaboration.openComment}
              >
                <MessageSquarePlus />
              </ToolbarButton>
            )}
            <ToolbarAllBlocksMenu
              allBlockCommands={allBlockCommands}
              canComment={canComment}
              collaboration={collaboration}
              editor={editor}
            />
            <BlockTypeMenu onBlock={block} />
          </ToolbarGroup>
        )}
        <div
          className="flex h-full min-w-0 flex-1 items-center overflow-hidden"
          ref={toolbarGroupsRef}
        >
          {enabled.history && (
            <ToolbarGroup>
              <ToolbarButton
                disabled={!canUndo}
                label={m.editor_undo()}
                onClick={() => editor.tf.undo()}
                shortcut={EDITOR_SHORTCUTS.undo}
              >
                <Undo2 />
              </ToolbarButton>
              <ToolbarButton
                disabled={!canRedo}
                label={m.editor_redo()}
                onClick={() => editor.tf.redo()}
                shortcut={EDITOR_SHORTCUTS.redo}
              >
                <Redo2 />
              </ToolbarButton>
            </ToolbarGroup>
          )}
          {enabled.fileOperations && (
            <ToolbarGroup className="gap-1">
              {canCreateAssets && <MediaUploadMenu editor={editor} />}
              {canCreateAssets && <ImportMenu importFile={importFile} />}
              <ExportMenu editor={editor} />
            </ToolbarGroup>
          )}
          {enabled.fontStyles && (
            <ToolbarGroup>
              <FontSizeControl />
              <FontColorControl
                fallbackColor="var(--color-fg)"
                icon={<Baseline />}
                label={m.editor_text_color()}
                markKey={KEYS.color}
              />
              <FontColorControl
                fallbackColor="transparent"
                icon={<PaintBucket />}
                label={m.editor_bg_color()}
                markKey={KEYS.backgroundColor}
              />
            </ToolbarGroup>
          )}
          {enabled.textDecorations && (
            <ToolbarGroup>
              <ToolbarButton
                label={m.editor_bold()}
                onClick={() => mark(KEYS.bold)}
                shortcut={EDITOR_SHORTCUTS.bold}
              >
                <Bold />
              </ToolbarButton>
              <ToolbarButton
                label={m.editor_italic()}
                onClick={() => mark(KEYS.italic)}
                shortcut={EDITOR_SHORTCUTS.italic}
              >
                <Italic />
              </ToolbarButton>
              <ToolbarButton
                label={m.editor_underline()}
                onClick={() => mark(KEYS.underline)}
                shortcut={EDITOR_SHORTCUTS.underline}
              >
                <Underline />
              </ToolbarButton>
              <ToolbarButton
                label={m.editor_strikethrough()}
                onClick={() => mark(KEYS.strikethrough)}
                shortcut={EDITOR_SHORTCUTS.strikethrough}
              >
                <Strikethrough />
              </ToolbarButton>
              <ToolbarButton
                label={m.editor_highlight()}
                onClick={() => mark(KEYS.highlight)}
                shortcut={EDITOR_SHORTCUTS.highlight}
              >
                <Highlighter />
              </ToolbarButton>
            </ToolbarGroup>
          )}
          {enabled.inlineElements && (
            <ToolbarGroup>
              {inlineEquationCommand && (
                <ToolbarButton
                  label={inlineEquationCommand.label}
                  onClick={() => inlineEquationCommand.run(editor)}
                >
                  <Sigma />
                </ToolbarButton>
              )}
              <ToolbarButton
                label={m.editor_inline_code()}
                onClick={() => mark(KEYS.code)}
                shortcut={EDITOR_SHORTCUTS.code}
              >
                <Code2 />
              </ToolbarButton>
              <ToolbarButton
                label={m.editor_link()}
                onClick={() => {
                  const selection = cloneLinkSelection(editor.selection);
                  const entry = editor.api.above({
                    at: selection ?? undefined,
                    match: { type: editor.getType(KEYS.link) },
                  });
                  linkSelectionRef.current = selection;
                  setLinkUrl(entry ? String(entry[0].url ?? '') : '');
                  setLinkText(
                    entry
                      ? editor.api.string(entry[1])
                      : selection
                        ? editor.api.string(selection)
                        : ''
                  );
                  setEditingLink(Boolean(entry));
                  setLinkError('');
                  setLinkOpen(true);
                }}
              >
                <Link />
              </ToolbarButton>
              {mentionCommand && (
                <ToolbarButton
                  label={mentionCommand.label}
                  onClick={() => mentionCommand.run(editor)}
                >
                  <AtSign />
                </ToolbarButton>
              )}
            </ToolbarGroup>
          )}
          {enabled.blockDecorations && (
            <ToolbarGroup>
              <AlignMenu editor={editor} />
              <ToolbarButton
                label={m.editor_numbered_list()}
                onClick={() =>
                  toggleList(editor, { listStyleType: ListStyleType.Decimal })
                }
              >
                <ListOrdered />
              </ToolbarButton>
              <ToolbarButton
                label={m.editor_bulleted_list()}
                onClick={() =>
                  toggleList(editor, { listStyleType: ListStyleType.Disc })
                }
              >
                <List />
              </ToolbarButton>
              <ToolbarButton
                label={m.editor_task_list()}
                onClick={() =>
                  toggleList(editor, { listStyleType: KEYS.listTodo })
                }
              >
                <ListChecks />
              </ToolbarButton>
            </ToolbarGroup>
          )}
          {enabled.blockElements && (
            <ToolbarGroup>
              <TableMenu />
              {twoColumnCommand && (
                <ToolbarButton
                  label={twoColumnCommand.label}
                  onClick={() => twoColumnCommand.run(editor)}
                >
                  <Columns2 />
                </ToolbarButton>
              )}
              {threeColumnCommand && (
                <ToolbarButton
                  label={threeColumnCommand.label}
                  onClick={() => threeColumnCommand.run(editor)}
                >
                  <Columns3 />
                </ToolbarButton>
              )}
            </ToolbarGroup>
          )}
          {enabled.indentation && (
            <ToolbarGroup>
              <ToolbarButton
                label={m.editor_outdent()}
                onClick={() => editor.tf.outdent()}
              >
                <IndentDecrease />
              </ToolbarButton>
              <ToolbarButton
                label={m.editor_indent()}
                onClick={() => editor.tf.indent()}
              >
                <IndentIncrease />
              </ToolbarButton>
            </ToolbarGroup>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center pl-2">
          {mode === 'edit' && allowExternalAssets && <VoiceButton />}
          {allowExternalAssets && (
            <ToolbarButton
              label={m.editor_ai_commands()}
              onClick={() => openAiMenu(editor)}
              shortcut={EDITOR_SHORTCUTS.ai}
            >
              <Sparkles />
            </ToolbarButton>
          )}
          <WidgetSettingsDialog />
        </div>
      </div>
      <Dialog
        onOpenChange={(open) => {
          setLinkOpen(open);
          if (!open) {
            setLinkUrl('');
            setLinkText('');
            setLinkError('');
            setEditingLink(false);
            linkSelectionRef.current = null;
          }
        }}
        open={linkOpen}
      >
        <DialogContent
          className="max-w-md"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            editor.tf.focus();
          }}
        >
          <DialogTitle>
            {editingLink ? m.editor_link_edit() : m.editor_insert_link()}
          </DialogTitle>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              applyLink();
            }}
          >
            <label className="flex flex-col gap-1.5">
              <InputTitle>{m.editor_link_url()}</InputTitle>
              <Input
                aria-invalid={Boolean(linkError)}
                autoFocus
                onChange={(event) => {
                  setLinkUrl(event.target.value);
                  setLinkError('');
                }}
                placeholder="https://example.com"
                value={linkUrl}
              />
              <InputError>{linkError}</InputError>
            </label>
            <label className="flex flex-col gap-1.5">
              <InputTitle>{m.editor_link_text()}</InputTitle>
              <Input
                onChange={(event) => setLinkText(event.target.value)}
                placeholder={m.editor_link_text_placeholder()}
                value={linkText}
              />
            </label>
            <DialogFooter>
              <Button
                onClick={() => setLinkOpen(false)}
                type="button"
                variant="ghost-hover"
              >
                {m.action_cancel()}
              </Button>
              <Button disabled={!linkUrl.trim()} type="submit" variant="accent">
                {editingLink ? m.action_save() : m.action_apply()}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
