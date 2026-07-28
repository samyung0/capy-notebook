import { toUnitLess } from '@platejs/basic-styles';
import { FontSizePlugin } from '@platejs/basic-styles/react';
import { encodeUrlIfNeeded, validateUrl } from '@platejs/link';
import { ListStyleType, toggleList } from '@platejs/list';
import { TablePlugin, useTableMergeState } from '@platejs/table/react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpFromLine,
  Baseline,
  Bold,
  Braces,
  ChevronDown,
  Code2,
  Combine,
  FileAudio,
  FileText,
  FileVideo,
  Grid3X3,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Image,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  MessageSquarePlus,
  Minus,
  PaintBucket,
  Pilcrow,
  Plus,
  Quote,
  Redo2,
  Settings2,
  Sparkles,
  Strikethrough,
  Table2,
  Trash2,
  Underline,
  Undo2,
  Ungroup,
  X,
} from 'lucide-react';
import type { SlatePlugin } from 'platejs';
import { KEYS } from 'platejs';
import {
  useEditorPlugin,
  useEditorRef,
  useEditorSelector,
} from 'platejs/react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  ColorPicker,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Input,
  InputError,
  InputTitle,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Switch,
} from '@/components/ui';
import { userToast } from '@/components/ui/userToast';
import { cn } from '@/lib/cn';
import { openAiMenu } from './ai/aiMenuState';
import { useNoteBlockDialogs } from './blocks/dialogContext';
import { useCollaborationActions } from './Collaboration';
import {
  downloadEditorFile,
  downloadEditorText,
  exportDocxDocument,
  exportMarkdownDocument,
  importDocxDocument,
  importJsonDocument,
  importMarkdownDocument,
} from './documentAdapters';
import { useEditorRuntime } from './EditorRuntime';
import { EDITOR_COMMANDS, type EditorCommandGroup } from './editorCommands';
import {
  canCreateExternalEditorAssets,
  isEditorCommandAllowed,
} from './editorMode';
import { clearEditorFormatting, toggleEditorBlock } from './editorTransforms';
import {
  cloneLinkSelection,
  type LinkSelection,
  upsertLinkAtSelection,
} from './linkEditor';
import { insertMediaPlaceholder } from './MediaNodes';
import {
  useNoteEditorPrefs,
  WIDGET_GROUPS,
  type WidgetGroupId,
} from './noteEditorPrefs';
import { MaterialKit } from './plugins';
import { getHiddenToolbarGroupIndexes } from './responsiveToolbar';
import { ToolbarButton } from './ToolBarButton';

// TODO: what is this
// Plate's plugin transforms are intentionally richer than its base editor type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = any;

function ToolbarGroup({
  children,
  className,
  persistent = false,
}: {
  children: React.ReactNode;
  className?: string;
  persistent?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex h-full shrink-0 items-center gap-0 after:mx-1.5 after:h-7 after:w-px after:bg-divider last:after:hidden',
        className
      )}
      data-toolbar-group
      data-toolbar-persistent={persistent || undefined}
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
    persistent: element.hasAttribute('data-toolbar-persistent'),
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

const ALL_BLOCK_GROUPS: readonly { id: EditorCommandGroup; label: string }[] = [
  { id: 'basic', label: 'Basic blocks' },
  { id: 'lists', label: 'Lists' },
  { id: 'media', label: 'Media' },
  { id: 'advanced', label: 'Advanced blocks' },
  { id: 'inline', label: 'Inline' },
];

export function NoteToolbar({
  right,
  className,
}: {
  right?: React.ReactNode;
  className?: string;
}) {
  const editor = useEditorRef() as AnyEditor;
  const toolbarGroupsRef = useRef<HTMLDivElement>(null);
  const { mode, allowExternalAssets, canComment } = useEditorRuntime();
  const canCreateAssets = canCreateExternalEditorAssets(
    mode,
    allowExternalAssets
  );
  const enabled = useNoteEditorPrefs((state) => state.enabled);
  const dialogs = useNoteBlockDialogs();
  const collaboration = useCollaborationActions();
  const canUndo = useEditorSelector((ed) => ed.history.undos.length > 0, []);
  const canRedo = useEditorSelector((ed) => ed.history.redos.length > 0, []);

  const [moreOpen, setMoreOpen] = useState(false);
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
          (!command.widget || enabled[command.widget]) &&
          isEditorCommandAllowed(mode, command, allowExternalAssets)
      ),
    [allowExternalAssets, enabled, mode]
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
  const clearFormatting = () => {
    editor.tf.focus();
    clearEditorFormatting(editor);
  };
  const block = (type: string) => {
    editor.tf.focus();
    toggleEditorBlock(editor, type);
  };
  const runAllBlockCommand = (command: (typeof EDITOR_COMMANDS)[number]) => {
    setMoreOpen(false);
    command.run(editor, dialogs);
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
      setLinkError("Hey, that's not a valid link.");
      return;
    }

    const selection = linkSelectionRef.current;
    if (!selection) {
      setLinkError(
        'The text selection is no longer available. Select the text and try again.'
      );
      return;
    }

    if (!upsertLinkAtSelection(editor, selection, { text: linkText, url })) {
      setLinkError('Hey, select some text so I can place the link.');
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
      <div
        aria-label="Document formatting"
        className={cn(
          'sticky top-0 z-20 flex h-10 items-center border-divider border-b bg-surface/95 px-2 backdrop-blur-sm',
          className
        )}
        role="toolbar"
      >
        <div
          className="flex h-full min-w-0 flex-1 items-center overflow-hidden"
          ref={toolbarGroupsRef}
        >
          <ToolbarGroup>
            <ToolbarButton
              disabled={!canUndo}
              label="Undo"
              onClick={() => editor.tf.undo()}
            >
              <Undo2 />
            </ToolbarButton>
            <ToolbarButton
              disabled={!canRedo}
              label="Redo"
              onClick={() => editor.tf.redo()}
            >
              <Redo2 />
            </ToolbarButton>
            {allowExternalAssets && (
              <ToolbarButton
                className="size-fit gap-1.5 px-2 py-1"
                label="AI commands (Ctrl/Cmd+J)"
                onClick={() => openAiMenu(editor)}
              >
                <Sparkles />
              </ToolbarButton>
            )}
          </ToolbarGroup>
          <ToolbarGroup className="gap-1">
            {canCreateAssets && <ImportMenu importFile={importFile} />}
            <ExportMenu editor={editor} />
          </ToolbarGroup>
          <ToolbarGroup className="gap-1" persistent>
            <Popover onOpenChange={setMoreOpen} open={moreOpen}>
              <PopoverTrigger asChild>
                <span>
                  <ToolbarButton
                    className="w-fit"
                    label="All blocks"
                    onClick={() => setMoreOpen(true)}
                  >
                    <Plus />
                    <ChevronDown className="size-3! text-fg-secondary" />
                  </ToolbarButton>
                </span>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="max-h-[min(80vh,38rem)] w-72 overflow-y-auto rounded-card border border-line bg-surface p-1 shadow-pop"
                data-all-blocks-menu
              >
                {ALL_BLOCK_GROUPS.map((group) => {
                  const commands = allBlockCommands.filter(
                    (command) => command.group === group.id
                  );
                  if (
                    !commands.length &&
                    !(group.id === 'media' && canComment && collaboration)
                  ) {
                    return null;
                  }

                  return (
                    <section
                      aria-labelledby={`all-blocks-${group.id}`}
                      key={group.id}
                    >
                      <h3
                        className="px-2 pt-2 pb-1 font-semibold text-fg-muted text-xs tracking-wide first:pt-1"
                        id={`all-blocks-${group.id}`}
                      >
                        {group.label}
                      </h3>
                      {commands.map((command) => {
                        const Icon = command.icon;
                        return (
                          <MenuRow
                            icon={<Icon />}
                            key={command.id}
                            label={command.label}
                            onClick={() => runAllBlockCommand(command)}
                            shortcut={command.shortcut}
                          />
                        );
                      })}
                      {group.id === 'media' && canComment && collaboration && (
                        <MenuRow
                          className="mt-1 border-divider border-t pt-2"
                          icon={<MessageSquarePlus />}
                          label="Comment"
                          onClick={() => {
                            setMoreOpen(false);
                            collaboration.openComment();
                          }}
                          shortcut="Ctrl/Cmd+Shift+M"
                        />
                      )}
                    </section>
                  );
                })}
                <div className="mt-1 border-divider border-t pt-1">
                  <MenuRow label="Subscript" onClick={() => mark(KEYS.sub)} />
                  <MenuRow label="Superscript" onClick={() => mark(KEYS.sup)} />
                  <MenuRow label="Clear formatting" onClick={clearFormatting} />
                </div>
              </PopoverContent>
            </Popover>
            <BlockTypeMenu onBlock={block} />
          </ToolbarGroup>
          {enabled.fontStyles && (
            <ToolbarGroup>
              <FontSizeControl />
              <FontColorControl
                fallbackColor="var(--color-fg)"
                icon={<Baseline />}
                label="Text color"
                markKey={KEYS.color}
              />
              <FontColorControl
                fallbackColor="transparent"
                icon={<PaintBucket />}
                label="Background color"
                markKey={KEYS.backgroundColor}
              />
            </ToolbarGroup>
          )}
          <ToolbarGroup>
            <ToolbarButton label="Bold" onClick={() => mark(KEYS.bold)}>
              <Bold />
            </ToolbarButton>
            <ToolbarButton label="Italic" onClick={() => mark(KEYS.italic)}>
              <Italic />
            </ToolbarButton>
            <ToolbarButton
              label="Underline"
              onClick={() => mark(KEYS.underline)}
            >
              <Underline />
            </ToolbarButton>
            <ToolbarButton
              label="Strikethrough"
              onClick={() => mark(KEYS.strikethrough)}
            >
              <Strikethrough />
            </ToolbarButton>
            <ToolbarButton label="Inline code" onClick={() => mark(KEYS.code)}>
              <Code2 />
            </ToolbarButton>
            <ToolbarButton
              label="Highlight"
              onClick={() => mark(KEYS.highlight)}
            >
              <Highlighter />
            </ToolbarButton>
          </ToolbarGroup>
          <ToolbarGroup>
            {enabled.fontStyles && <AlignMenu editor={editor} />}
            <ToolbarButton
              label="Numbered list"
              onClick={() =>
                toggleList(editor, { listStyleType: ListStyleType.Decimal })
              }
            >
              <ListOrdered />
            </ToolbarButton>
            <ToolbarButton
              label="Bulleted list"
              onClick={() =>
                toggleList(editor, { listStyleType: ListStyleType.Disc })
              }
            >
              <List />
            </ToolbarButton>
            <ToolbarButton
              label="Task list"
              onClick={() =>
                toggleList(editor, { listStyleType: KEYS.listTodo })
              }
            >
              <ListChecks />
            </ToolbarButton>
          </ToolbarGroup>
          <ToolbarGroup>
            <ToolbarButton
              label="Link"
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
            {enabled.table && <TableMenu />}
          </ToolbarGroup>
          {canCreateAssets && enabled.media && (
            <ToolbarGroup>
              <ToolbarButton
                label="Upload image"
                onClick={() => insertMediaPlaceholder(editor, 'img')}
              >
                <Image />
              </ToolbarButton>
              <ToolbarButton
                label="Upload video"
                onClick={() => insertMediaPlaceholder(editor, 'video')}
              >
                <FileVideo />
              </ToolbarButton>
              <ToolbarButton
                label="Upload audio"
                onClick={() => insertMediaPlaceholder(editor, 'audio')}
              >
                <FileAudio />
              </ToolbarButton>
              <ToolbarButton
                label="Upload file"
                onClick={() => insertMediaPlaceholder(editor, 'file')}
              >
                <FileText />
              </ToolbarButton>
            </ToolbarGroup>
          )}
          {canComment && collaboration && (
            <ToolbarGroup>
              <ToolbarButton
                label="Comment"
                onClick={collaboration.openComment}
              >
                <MessageSquarePlus />
              </ToolbarButton>
            </ToolbarGroup>
          )}
          <ToolbarGroup>
            <ToolbarButton label="Outdent" onClick={() => editor.tf.outdent()}>
              <IndentDecrease />
            </ToolbarButton>
            <ToolbarButton label="Indent" onClick={() => editor.tf.indent()}>
              <IndentIncrease />
            </ToolbarButton>
          </ToolbarGroup>
        </div>
        <div className="ml-auto flex shrink-0 items-center pl-2">
          {right}
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
          <DialogTitle>{editingLink ? 'Edit link' : 'Insert link'}</DialogTitle>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              applyLink();
            }}
          >
            <label className="flex flex-col gap-1.5">
              <InputTitle>Link URL</InputTitle>
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
              <InputTitle>Displayed text</InputTitle>
              <Input
                onChange={(event) => setLinkText(event.target.value)}
                placeholder="Use the URL as text"
                value={linkText}
              />
            </label>
            <DialogFooter>
              <Button
                onClick={() => setLinkOpen(false)}
                type="button"
                variant="ghost-hover"
              >
                Cancel
              </Button>
              <Button disabled={!linkUrl.trim()} type="submit" variant="accent">
                {editingLink ? 'Save' : 'Apply'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

const DEFAULT_FONT_SIZE = 16;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 96;
const FONT_SIZE_PRESETS = [
  8, 9, 10, 12, 14, 16, 18, 24, 30, 36, 48, 60, 72, 96,
] as const;
// const BLOCK_FONT_SIZES: Record<string, number> = {
//   [KEYS.h1]: 36,
//   [KEYS.h2]: 24,
//   [KEYS.h3]: 20,
//   [KEYS.h4]: 18,
//   [KEYS.h5]: 18,
//   [KEYS.h6]: 16,
// };

function clampFontSize(size: number) {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));
}

function FontSizeControl() {
  const [open, setOpen] = useState(false);
  const { editor, tf } = useEditorPlugin(FontSizePlugin);
  const cursorFontSize = useEditorSelector((currentEditor) => {
    const markedSize = currentEditor.api.marks()?.[KEYS.fontSize];

    if (markedSize != null) {
      const parsedSize = Number.parseFloat(toUnitLess(String(markedSize)));
      if (Number.isFinite(parsedSize)) return clampFontSize(parsedSize);
    }

    const [block] = editor.api.block() ?? [];
    const domNode = block && editor.api.toDOMNode(block);
    if (domNode) {
      const size = Number.parseFloat(window.getComputedStyle(domNode).fontSize);
      if (Number.isFinite(size)) return clampFontSize(size);
    }

    return DEFAULT_FONT_SIZE;
  }, []);

  const setFontSize = (size: number, closePopover = false) => {
    tf.fontSize.addMark(`${clampFontSize(size)}px`);
    if (closePopover) setOpen(false);
    editor.tf.focus();
  };

  return (
    <div
      aria-label="Font size"
      className="mr-1 flex items-center overflow-hidden"
      role="group"
    >
      <ToolbarButton
        className="rounded-r-none bg-surface-hover-bg p-0 text-surface-dark-fg hover:bg-surface-dark"
        disabled={cursorFontSize <= MIN_FONT_SIZE}
        label="Decrease font size"
        onClick={() => setFontSize(cursorFontSize - 1)}
      >
        <Minus />
      </ToolbarButton>
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <button
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-label={`Font size: ${cursorFontSize}`}
            className={cn(
              "h-8 w-10 shrink-0 text-center font-semibold text-sm outline-none",
              "bg-surface-hover-bg text-surface-dark-fg hover:bg-surface-dark focus-visible:ring-2 focus-visible:ring-focus",
            )}
            data-plate-prevent-deselect
            onMouseDown={(event) => event.preventDefault()}
            title="Choose font size"
            type="button"
          >
            {cursorFontSize}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="center"
          className="max-h-64 w-14 gap-0 overflow-y-auto border border-line bg-surface p-1 shadow-pop"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            editor.tf.focus();
          }}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div aria-label="Font sizes" role="listbox">
            {FONT_SIZE_PRESETS.map((size) => (
              <button
                aria-selected={size === cursorFontSize}
                className={cn(
                  "flex h-8 w-full items-center justify-center rounded-button text-sm outline-none",
                  "hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-focus",
                  size === cursorFontSize &&
                    "bg-tint-accent-1 text-tint-accent-1-fg",
                )}
                data-plate-prevent-deselect
                key={size}
                onClick={() => setFontSize(size, true)}
                onMouseDown={(event) => event.preventDefault()}
                role="option"
                type="button"
              >
                {size}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <ToolbarButton
        className="rounded-l-none bg-surface-hover-bg p-0 text-surface-dark-fg hover:bg-surface-dark"
        disabled={cursorFontSize >= MAX_FONT_SIZE}
        label="Increase font size"
        onClick={() => setFontSize(cursorFontSize + 1)}
      >
        <Plus />
      </ToolbarButton>
    </div>
  );
}

function FontColorControl({
  label,
  markKey,
  icon,
  fallbackColor,
}: {
  label: string;
  markKey: string;
  icon: React.ReactNode;
  fallbackColor: string;
}) {
  const editor = useEditorRef() as AnyEditor;
  const [open, setOpen] = useState(false);
  const currentColor = useEditorSelector(
    (currentEditor) => currentEditor.api.mark(markKey) as string | undefined,
    [markKey],
  );

  const applyColor = (color: string) => {
    editor.tf.addMarks({ [markKey]: color });
    setOpen(false);
  };

  const clearColor = () => {
    editor.tf.removeMarks(markKey);
    setOpen(false);
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <ToolbarButton
          active={Boolean(currentColor)}
          className="relative"
          label={label}
        >
          {icon}
          <span
            aria-hidden
            className="absolute right-1.5 bottom-0.5 left-1.5 h-1 rounded-full border border-line-strong"
            style={{ backgroundColor: currentColor || fallbackColor }}
          />
        </ToolbarButton>
      </PopoverTrigger>
      <PopoverContent
        align="center"
        className="w-64 border border-line bg-surface p-2.5 shadow-pop"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          editor.tf.focus();
        }}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <ColorPicker
          onChange={applyColor}
          onClear={clearColor}
          value={currentColor}
        />
      </PopoverContent>
    </Popover>
  );
}

// TODO: reflect text block style in the trigger value
function BlockTypeMenu({ onBlock }: { onBlock: (type: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <ToolbarButton className="w-fit" label="Block Type">
          <span className="translate-y-px">Paragraph</span>
          <ChevronDown className="size-3! text-fg-secondary" />
        </ToolbarButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-42 gap-0.5 bg-surface p-1 shadow-pop"
      >
        <MenuRow
          icon={<Pilcrow />}
          label="Paragraph"
          onClick={() => onBlock(KEYS.p)}
        />
        <MenuRow
          icon={<Heading1 />}
          label="Heading 1"
          onClick={() => onBlock(KEYS.h1)}
        />
        <MenuRow
          icon={<Heading2 />}
          label="Heading 2"
          onClick={() => onBlock(KEYS.h2)}
        />
        <MenuRow
          icon={<Heading3 />}
          label="Heading 3"
          onClick={() => onBlock(KEYS.h3)}
        />
        <MenuRow
          icon={<Quote />}
          label="Blockquote"
          onClick={() => onBlock(KEYS.blockquote)}
        />
        <MenuRow
          icon={<Braces />}
          label="Code block"
          onClick={() => onBlock(KEYS.codeBlock)}
        />
      </PopoverContent>
    </Popover>
  );
}

type ImportKind = "markdown" | "docx" | "json";

const IMPORT_OPTIONS: Record<
  ImportKind,
  { accept: string; extensions: string[]; maxBytes: number }
> = {
  docx: {
    accept:
      ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extensions: [".docx"],
    maxBytes: 25 * 1024 * 1024,
  },
  json: {
    accept: ".json,.plate.json,application/json",
    extensions: [".json"],
    maxBytes: 10 * 1024 * 1024,
  },
  markdown: {
    accept: ".md,.mdx,text/markdown,text/mdx",
    extensions: [".md", ".mdx"],
    maxBytes: 5 * 1024 * 1024,
  },
};

function validateImportFile(file: File, kind: ImportKind) {
  const option = IMPORT_OPTIONS[kind];
  const name = file.name.toLowerCase();

  if (!option.extensions.some((extension) => name.endsWith(extension))) {
    throw new Error(`Choose a ${option.extensions.join(" or ")} file.`);
  }
  if (file.size === 0) {
    throw new Error("The selected file is empty.");
  }
  if (file.size > option.maxBytes) {
    throw new Error(
      `The selected file is larger than ${option.maxBytes / 1024 / 1024} MB.`,
    );
  }
}

function ImportMenu({
  importFile,
}: {
  importFile: (file: File, kind: ImportKind) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const markdownInput = useRef<HTMLInputElement>(null);
  const docxInput = useRef<HTMLInputElement>(null);
  const jsonInput = useRef<HTMLInputElement>(null);
  const inputRefs = {
    docx: docxInput,
    json: jsonInput,
    markdown: markdownInput,
  } satisfies Record<ImportKind, React.RefObject<HTMLInputElement | null>>;

  const chooseFile = (kind: ImportKind) => {
    setOpen(false);
    inputRefs[kind].current?.click();
  };

  const handleFile = async (
    event: React.ChangeEvent<HTMLInputElement>,
    kind: ImportKind,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      validateImportFile(file, kind);
      await importFile(file, kind);
    } catch (cause) {
      userToast({
        description:
          cause instanceof Error
            ? cause.message
            : "The selected file could not be read.",
        title: "Import failed",
        variant: "error",
      });
    }
  };

  return (
    <>
      {(Object.keys(IMPORT_OPTIONS) as ImportKind[]).map((kind) => (
        <input
          accept={IMPORT_OPTIONS[kind].accept}
          className="hidden"
          key={kind}
          onChange={(event) => void handleFile(event, kind)}
          ref={inputRefs[kind]}
          type="file"
        />
      ))}
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <ToolbarButton className="w-fit" label="Import document">
            <ArrowUpFromLine />
            <ChevronDown className="size-3! text-fg-secondary" />
          </ToolbarButton>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-52 gap-0.5 border border-line bg-surface p-1 shadow-pop"
        >
          <MenuRow
            label="Import Markdown (.md)"
            onClick={() => chooseFile("markdown")}
          />
          <MenuRow
            label="Import Word (.docx)"
            onClick={() => chooseFile("docx")}
          />
          <MenuRow label="Import JSON" onClick={() => chooseFile("json")} />
        </PopoverContent>
      </Popover>
    </>
  );
}

function ExportMenu({ editor }: { editor: AnyEditor }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <ToolbarButton className="w-fit" label="Export document">
          <ArrowDownToLine />
          <ChevronDown className="size-3! text-fg-secondary" />
        </ToolbarButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-52 gap-0.5 border border-line bg-surface p-1 shadow-pop"
      >
        <MenuRow
          label="Export Markdown (.md)"
          onClick={() =>
            downloadEditorText(
              exportMarkdownDocument(editor),
              "document.md",
              "text/markdown",
            )
          }
        />
        <MenuRow
          label="Export Word (.docx)"
          onClick={() =>
            void exportDocxDocument(editor, MaterialKit as SlatePlugin[]).then(
              (blob) => downloadEditorFile(blob, "document.docx"),
            )
          }
        />
        <MenuRow
          label="Export JSON"
          onClick={() =>
            downloadEditorText(
              JSON.stringify(
                { schemaVersion: 1, value: editor.children },
                null,
                2,
              ),
              "document.plate.json",
              "application/json",
            )
          }
        />
      </PopoverContent>
    </Popover>
  );
}

function AlignMenu({ editor }: { editor: AnyEditor }) {
  const [open, setOpen] = useState(false);
  const align = (value: string) => editor.tf.setNodes({ align: value });
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <span>
          <ToolbarButton label="Text alignment" onClick={() => setOpen(true)}>
            <AlignLeft />
          </ToolbarButton>
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex w-auto gap-1 border border-line bg-surface p-1 shadow-pop"
      >
        <ToolbarButton label="Align left" onClick={() => align("left")}>
          <AlignLeft />
        </ToolbarButton>
        <ToolbarButton label="Align center" onClick={() => align("center")}>
          <AlignCenter />
        </ToolbarButton>
        <ToolbarButton label="Align right" onClick={() => align("right")}>
          <AlignRight />
        </ToolbarButton>
        {/* <ToolbarButton label="Justify" onClick={() => align('justify')}>
          <AlignJustify />
        </ToolbarButton> */}
      </PopoverContent>
    </Popover>
  );
}

function TableMenu() {
  const [open, setOpen] = useState(false);
  const { editor, tf } = useEditorPlugin(TablePlugin);
  const tableSelected = useEditorSelector(
    (currentEditor) => currentEditor.api.some({ match: { type: KEYS.table } }),
    [],
  );
  const { canMerge, canSplit } = useTableMergeState();

  const run = (action: () => void) => {
    action();
    editor.tf.focus();
  };

  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton active={open} label="Table controls">
          <Table2 />
        </ToolbarButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-45">
        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Grid3X3 />
              <span>Table</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-auto p-0">
              <TablePicker
                onInsert={(rowCount, colCount) => {
                  run(() =>
                    tf.insert.table({ colCount, rowCount }, { select: true }),
                  );
                  setOpen(false);
                }}
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={!tableSelected}>
              <span className="size-4" />
              <span>Cell</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-48">
              <DropdownMenuItem
                disabled={!canMerge}
                onSelect={() => run(() => tf.table.merge())}
              >
                <Combine />
                Merge cells
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!canSplit}
                onSelect={() => run(() => tf.table.split())}
              >
                <Ungroup />
                Split cell
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={!tableSelected}>
              <span className="size-4" />
              <span>Row</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-48">
              <DropdownMenuItem
                onSelect={() => run(() => tf.insert.tableRow({ before: true }))}
              >
                <ArrowUp />
                Insert row before
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => run(() => tf.insert.tableRow())}
              >
                <ArrowDown />
                Insert row after
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => run(() => tf.remove.tableRow())}
              >
                <X />
                Delete row
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={!tableSelected}>
              <span className="size-4" />
              <span>Column</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-52">
              <DropdownMenuItem
                onSelect={() =>
                  run(() => tf.insert.tableColumn({ before: true }))
                }
              >
                <ArrowLeft />
                Insert column before
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => run(() => tf.insert.tableColumn())}
              >
                <ArrowRight />
                Insert column after
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => run(() => tf.remove.tableColumn())}
              >
                <X />
                Delete column
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuItem
            disabled={!tableSelected}
            onSelect={() => run(() => tf.remove.table())}
          >
            <Trash2 />
            Delete table
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TablePicker({
  onInsert,
}: {
  onInsert: (rowCount: number, colCount: number) => void;
}) {
  const [size, setSize] = useState({ colCount: 3, rowCount: 3 });
  const dimension = 8;

  return (
    <div
      aria-label={`Insert ${size.rowCount} by ${size.colCount} table`}
      className="m-0 flex flex-col gap-1 p-1 outline-none"
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onInsert(size.rowCount, size.colCount);
          return;
        }

        const next = { ...size };
        if (event.key === "ArrowUp")
          next.rowCount = Math.max(1, size.rowCount - 1);
        else if (event.key === "ArrowDown")
          next.rowCount = Math.min(dimension, size.rowCount + 1);
        else if (event.key === "ArrowLeft")
          next.colCount = Math.max(1, size.colCount - 1);
        else if (event.key === "ArrowRight")
          next.colCount = Math.min(dimension, size.colCount + 1);
        else return;

        event.preventDefault();
        setSize(next);
      }}
      role="grid"
      tabIndex={0}
    >
      <div className="grid size-32 grid-cols-8 gap-0.5">
        {Array.from({ length: dimension * dimension }, (_, index) => {
          const row = Math.floor(index / dimension) + 1;
          const column = (index % dimension) + 1;
          const active = row <= size.rowCount && column <= size.colCount;

          return (
            <button
              aria-label={`Insert ${row} by ${column} table`}
              aria-selected={active}
              className={cn(
                "size-3.5 rounded-xs border border-line bg-surface outline-none",
                active && "border-action-accent bg-tint-accent-1",
              )}
              key={`${row}:${column}`}
              onClick={() => onInsert(row, column)}
              onFocus={() => setSize({ colCount: column, rowCount: row })}
              onPointerEnter={() =>
                setSize({ colCount: column, rowCount: row })
              }
              role="gridcell"
              tabIndex={-1}
              type="button"
            />
          );
        })}
      </div>
      <div className="text-center text-fg-secondary text-xs">
        {size.rowCount} × {size.colCount}
      </div>
    </div>
  );
}

function MenuRow({
  label,
  onClick,
  icon,
  shortcut,
  className,
  onMouseDown,
  ...rest
}: React.ComponentProps<"button"> & {
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  className?: string;
}) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-2 rounded-button px-2 py-1.5 text-left text-fg text-sm hover:bg-surface-hover-bg [&_svg]:size-4",
        className,
      )}
      onClick={onClick}
      onMouseDown={(event) => {
        event.preventDefault();
        onMouseDown?.(event);
      }}
      type="button"
      {...rest}
    >
      {icon && (
        <span className="flex size-4 shrink-0 items-center justify-center">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">{label}</span>
      {shortcut && (
        <kbd aria-hidden className="ml-auto shrink-0 text-fg-muted text-xs">
          {shortcut}
        </kbd>
      )}
    </button>
  );
}

function WidgetSettingsDialog() {
  const enabled = useNoteEditorPrefs((state) => state.enabled);
  const setEnabled = useNoteEditorPrefs((state) => state.setEnabled);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(enabled);
  const count = WIDGET_GROUPS.filter((group) => draft[group.id]).length;

  const setAll = (value: boolean) => {
    const next = {} as Record<WidgetGroupId, boolean>;
    for (const group of WIDGET_GROUPS) {
      next[group.id] = value;
    }
    setDraft(next);
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (next) setDraft({ ...enabled });
        setOpen(next);
      }}
      open={open}
    >
      <button
        aria-label="Editor command settings"
        className="inline-flex size-8 items-center justify-center rounded-button hover:bg-surface-hover-bg"
        onClick={() => setOpen(true)}
        title="Editor command settings"
        type="button"
      >
        <Settings2 className="size-4" />
      </button>
      <DialogContent className="max-w-xl">
        <DialogTitle className="pb-2">Editor commands</DialogTitle>
        <p className="mb-4 text-fg-muted text-sm">
          Choose which optional commands appear in toolbars and the slash menu.
          Existing document content always remains enabled.
        </p>
        <div className="mb-3 flex items-center justify-between">
          <span className="font-medium text-fg text-sm">
            {count} of {WIDGET_GROUPS.length} enabled
          </span>
          <div className="flex gap-1">
            <Button onClick={() => setAll(true)} size="sm" variant="ghost">
              All
            </Button>
            <Button onClick={() => setAll(false)} size="sm" variant="ghost">
              None
            </Button>
          </div>
        </div>
        <div className="grid max-h-[52vh] grid-cols-1 gap-2 overflow-auto pr-1 sm:grid-cols-2">
          {WIDGET_GROUPS.map((group) => (
            <label
              className="flex items-center justify-between gap-3 rounded-card border border-line px-3 py-2"
              key={group.id}
            >
              <span className="min-w-0">
                <span className="block font-medium text-fg text-sm">
                  {group.label}
                </span>
                <span className="block text-fg-muted text-xs">
                  {group.description}
                </span>
              </span>
              <Switch
                checked={draft[group.id]}
                onChange={() =>
                  setDraft((current) => ({
                    ...current,
                    [group.id]: !current[group.id],
                  }))
                }
              />
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="ghost-hover">
            Cancel
          </Button>
          <Button
            onClick={() => {
              setEnabled(draft);
              setOpen(false);
            }}
            variant="accent"
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
