import { encodeUrlIfNeeded, validateUrl } from '@platejs/link';
import {
  ListStyleType,
  someList,
  someTodoList,
  toggleList,
} from '@platejs/list';
import { KEYS } from 'platejs';
import { useEditorRef, useEditorSelector } from 'platejs/react';
import { useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
import { Toolbar, ToolbarGroup } from '@/components/ui/Toolbar';
import { openAiMenu } from '@/features/notes/ai/aiMenuState';
import { useCollaborationActions } from '@/features/notes/Collaboration';
import {
  importDocxDocument,
  importJsonDocument,
  importMarkdownDocument,
} from '@/features/notes/documentAdapters';
import { EditorIcon } from '@/features/notes/EditorIcon';
import { useEditorRuntime } from '@/features/notes/EditorRuntime';
import { EDITOR_COMMANDS } from '@/features/notes/editorCommands';
import { isEditorCommandAllowed } from '@/features/notes/editorMode';
import { toggleEditorBlock } from '@/features/notes/editorTransforms';
import {
  cloneLinkSelection,
  type LinkSelection,
  upsertLinkAtSelection,
} from '@/features/notes/linkEditor';
import { useNoteEditorPrefs } from '@/features/notes/noteEditorPrefs';
import { AlignMenu } from '@/features/notes/toolbar/ToolbarAlignMenu';
import { ToolbarAllBlocksMenu } from '@/features/notes/toolbar/ToolbarAllBlocksMenu';
import { BlockTypeMenu } from '@/features/notes/toolbar/ToolbarBlockTypeMenu';
import {
  EDITOR_SHORTCUTS,
  MarkToolbarButton,
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
import { editorAiEnabled } from '@/lib/features';

// TODO: what is this
// Plate's plugin transforms are intentionally richer than its base editor type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEditor = any;

export function NoteToolbar({ className }: { className?: string }) {
  const editor = useEditorRef() as AnyEditor;
  const { allowExternalAssets, canEdit } = useEditorRuntime();
  const canCreateAssets = allowExternalAssets;
  const enabled = useNoteEditorPrefs((state) => state.enabled);
  const collaboration = useCollaborationActions();
  const canUndo = useEditorSelector((ed) => ed.history.undos.length > 0, []);
  const canRedo = useEditorSelector((ed) => ed.history.redos.length > 0, []);
  const inLink = useEditorSelector(
    (ed) => ed.api.some({ match: { type: KEYS.link } }),
    []
  );
  const numberedList = useEditorSelector(
    (ed) => someList(ed, ListStyleType.Decimal),
    []
  );
  const bulletedList = useEditorSelector(
    (ed) => someList(ed, ListStyleType.Disc),
    []
  );
  const taskList = useEditorSelector((ed) => someTodoList(ed), []);
  const columnCount = useEditorSelector(
    (ed) =>
      ed.api.above({ match: { type: KEYS.columnGroup } })?.[0].children.length,
    []
  );

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
          isEditorCommandAllowed(command, allowExternalAssets)
      ),
    [allowExternalAssets, enabled]
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

  return (
    <>
      <Toolbar
        aria-label={m.editor_doc_formatting()}
        className={cn('sticky top-0 z-20', className)}
        role="toolbar"
      >
        <div className="scroll-fade-x flex h-full min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {enabled.general && (
            <ToolbarGroup className="gap-1">
              {canEdit && collaboration && (
                <ToolbarButton
                  disabled={collaboration.mutationPending}
                  label={m.editor_comment()}
                  onClick={collaboration.openComment}
                >
                  <EditorIcon name="commentAdd" />
                </ToolbarButton>
              )}
              <ToolbarAllBlocksMenu
                allBlockCommands={allBlockCommands}
                canEdit={canEdit}
                collaboration={collaboration}
                editor={editor}
              />
              <BlockTypeMenu onBlock={block} />
            </ToolbarGroup>
          )}
          {enabled.history && (
            <ToolbarGroup>
              <ToolbarButton
                disabled={!canUndo}
                label={m.editor_undo()}
                onClick={() => editor.tf.undo()}
                shortcut={EDITOR_SHORTCUTS.undo}
              >
                <EditorIcon name="undo" />
              </ToolbarButton>
              <ToolbarButton
                disabled={!canRedo}
                label={m.editor_redo()}
                onClick={() => editor.tf.redo()}
                shortcut={EDITOR_SHORTCUTS.redo}
              >
                <EditorIcon name="redo" />
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
                icon={<EditorIcon name="textColor" />}
                label={m.editor_text_color()}
                markKey={KEYS.color}
              />
              <FontColorControl
                fallbackColor="transparent"
                icon={<EditorIcon name="paintBucket" />}
                label={m.editor_bg_color()}
                markKey={KEYS.backgroundColor}
              />
            </ToolbarGroup>
          )}
          {enabled.textDecorations && (
            <ToolbarGroup>
              <MarkToolbarButton
                label={m.editor_bold()}
                markKey={KEYS.bold}
                shortcut={EDITOR_SHORTCUTS.bold}
              >
                <EditorIcon name="bold" />
              </MarkToolbarButton>
              <MarkToolbarButton
                label={m.editor_italic()}
                markKey={KEYS.italic}
                shortcut={EDITOR_SHORTCUTS.italic}
              >
                <EditorIcon name="italic" />
              </MarkToolbarButton>
              <MarkToolbarButton
                label={m.editor_underline()}
                markKey={KEYS.underline}
                shortcut={EDITOR_SHORTCUTS.underline}
              >
                <EditorIcon name="underline" />
              </MarkToolbarButton>
              <MarkToolbarButton
                label={m.editor_strikethrough()}
                markKey={KEYS.strikethrough}
                shortcut={EDITOR_SHORTCUTS.strikethrough}
              >
                <EditorIcon name="strikethrough" />
              </MarkToolbarButton>
              <MarkToolbarButton
                label={m.editor_highlight()}
                markKey={KEYS.highlight}
                shortcut={EDITOR_SHORTCUTS.highlight}
              >
                <EditorIcon name="highlighter" />
              </MarkToolbarButton>
            </ToolbarGroup>
          )}
          {enabled.inlineElements && (
            <ToolbarGroup>
              {inlineEquationCommand && (
                <ToolbarButton
                  label={inlineEquationCommand.label}
                  onClick={() => inlineEquationCommand.run(editor)}
                >
                  <EditorIcon name="sigma" />
                </ToolbarButton>
              )}
              <MarkToolbarButton
                label={m.editor_inline_code()}
                markKey={KEYS.code}
                shortcut={EDITOR_SHORTCUTS.code}
              >
                <EditorIcon name="code" />
              </MarkToolbarButton>
              <ToolbarButton
                active={inLink}
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
                <EditorIcon name="link" />
              </ToolbarButton>
              {mentionCommand && (
                <ToolbarButton
                  label={mentionCommand.label}
                  onClick={() => mentionCommand.run(editor)}
                >
                  <EditorIcon name="at" />
                </ToolbarButton>
              )}
            </ToolbarGroup>
          )}
          {enabled.blockDecorations && (
            <ToolbarGroup>
              <AlignMenu editor={editor} />
              <ToolbarButton
                active={numberedList}
                label={m.editor_numbered_list()}
                onClick={() =>
                  toggleList(editor, { listStyleType: ListStyleType.Decimal })
                }
              >
                <EditorIcon name="listOrdered" />
              </ToolbarButton>
              <ToolbarButton
                active={bulletedList}
                label={m.editor_bulleted_list()}
                onClick={() =>
                  toggleList(editor, { listStyleType: ListStyleType.Disc })
                }
              >
                <EditorIcon name="list" />
              </ToolbarButton>
              <ToolbarButton
                active={taskList}
                label={m.editor_task_list()}
                onClick={() =>
                  toggleList(editor, { listStyleType: KEYS.listTodo })
                }
              >
                <EditorIcon name="todo" />
              </ToolbarButton>
            </ToolbarGroup>
          )}
          {enabled.blockElements && (
            <ToolbarGroup>
              <TableMenu />
              {twoColumnCommand && (
                <ToolbarButton
                  active={columnCount === 2}
                  label={twoColumnCommand.label}
                  onClick={() => twoColumnCommand.run(editor)}
                >
                  <EditorIcon name="columns2" />
                </ToolbarButton>
              )}
              {threeColumnCommand && (
                <ToolbarButton
                  active={columnCount === 3}
                  label={threeColumnCommand.label}
                  onClick={() => threeColumnCommand.run(editor)}
                >
                  <EditorIcon name="columns3" />
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
                <EditorIcon name="indentDecrease" />
              </ToolbarButton>
              <ToolbarButton
                label={m.editor_indent()}
                onClick={() => editor.tf.indent()}
              >
                <EditorIcon name="indentIncrease" />
              </ToolbarButton>
            </ToolbarGroup>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center pl-2">
          {editorAiEnabled(allowExternalAssets) && (
            <ToolbarButton
              label={m.editor_ai_commands()}
              onClick={() => openAiMenu(editor)}
              shortcut={EDITOR_SHORTCUTS.ai}
            >
              <EditorIcon name="sparkles" />
            </ToolbarButton>
          )}
          <WidgetSettingsDialog />
        </div>
      </Toolbar>
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
                size="lg"
                type="button"
                variant="ghost-hover"
              >
                {m.action_cancel()}
              </Button>
              <Button
                disabled={!linkUrl.trim()}
                size="lg"
                type="submit"
                variant="accent"
              >
                {editingLink ? m.action_save() : m.action_apply()}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
