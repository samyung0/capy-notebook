import {
  FloatingPortal,
  flip,
  getRangeBoundingClientRect,
  offset,
  shift,
  useVirtualFloating,
} from '@platejs/floating';
import { NodeApi, type TElement } from 'platejs';
import {
  type PlateEditor,
  PlateElement,
  type PlateElementProps,
  useEditorRef,
  useEditorSelector,
  useReadOnly,
} from 'platejs/react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ContentSwap } from '@/components/ui/ContentSwap';
import { Popover, PopoverTrigger } from '@/components/ui/Popover';
import { PopupMotion } from '@/components/ui/PopupMotion';
import { ButtonTooltip } from '@/components/ui/Tooltip';
import {
  type FlashcardElement as FlashcardNode,
  type HtmlEmbedElement as HtmlEmbedNode,
  type MaterialElement,
  type MaterialNode,
  type MaterialRefElement as MaterialRefNode,
  type MermaidElement as MermaidNode,
  normalizeMaterialValue,
  type QuestionFigureElement as QuestionFigureNode,
  type QuizQuestionElement as QuizQuestionNode,
  quizQuestionElementToQuestion,
} from '@/features/materials/document';
import {
  AppEmbedEdit,
  AppEmbedView,
} from '@/features/materials/embeds/AppEmbed';
import { EmbedLoading } from '@/features/materials/embeds/EmbedView';
import { HtmlEmbed } from '@/features/materials/HtmlEmbed';
import { StandaloneMaterialTitle } from '@/features/materials/MaterialRenderContext';
import { MediaFrame } from '@/features/materials/MediaFrame';
import { MermaidPreview } from '@/features/materials/MediaPreview';
import { Mermaid, MermaidSwatch } from '@/features/materials/Mermaid';
import {
  MERMAID_THEME_LABEL,
  MERMAID_THEMES,
  type MermaidTheme,
  mermaidTheme,
} from '@/features/materials/mermaidThemes';
import { FigureView } from '@/features/materials/staticViews';
import { EditorIcon } from '@/features/notes/EditorIcon';
import { QuestionView } from '@/features/questions/QuestionView';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { uid } from '@/lib/id';
import { useOptionalEditorRuntime } from '../EditorRuntime';
import {
  FLASHCARD_BACK_CLASS,
  FLASHCARD_CLASS,
  FLASHCARD_FRONT_CLASS,
  MERMAID_CAPTION_CLASS,
  QUIZ_REVIEW_QUESTION_CLASS,
  STUDY_BLOCK_LIST_CLASS,
} from '../nodeStyles';
import { ToolbarButton } from '../toolbar/ToolbarButton';
import {
  ToolbarPopoverContent,
  ToolbarPopoverRow,
} from '../toolbar/ToolbarPopover';
import { useOptionalNoteBlockDialogs } from './dialogContext';
import { setMermaidCaption } from './mermaidBlock';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = any;

/** Identifies this browser session's claim on a pending reference. */
const CLIENT_ID = uid('client');
/** Long enough for a concurrent claim to merge back before creating a row. */
const CLAIM_SETTLE_MS = 400;

function StudyBlockRoot({
  props,
  onEdit,
  className,
  children,
}: {
  props: PlateElementProps;
  onEdit?: () => void;
  className?: string;
  children?: React.ReactNode;
}) {
  const editor = useEditorRef();
  const readOnly = useReadOnly();
  const active = useEditorSelector(
    (currentEditor) => {
      const selection = currentEditor.selection;
      const path = currentEditor.api.findPath(props.element);
      if (!selection || !path || !isCollapsed(selection)) return false;
      return isDescendantPath(path, selection.anchor.path);
    },
    [props.element]
  );

  const [toolbarMounted, setToolbarMounted] = useState(active);
  if (active && !toolbarMounted) setToolbarMounted(true);

  const runBlockAction = (action: 'duplicate' | 'delete') => {
    const at = editor.api.findPath(props.element);
    if (!at) return;
    const item = findCurrentStudyItem(editor, at);
    if (!item) return;
    const [itemNode, itemPath] = item;
    if (action === 'duplicate') {
      const duplicate = cloneStudyItem(itemNode);
      const insertAt = [...itemPath];
      insertAt[insertAt.length - 1] += 1;
      editor.tf.insertNodes(duplicate, { at: insertAt, select: true });
    } else {
      const parent = editor.api.node(at)?.[0] as MaterialElement | undefined;
      const isLastItem = parent?.children?.length === 1;
      editor.tf.removeNodes({ at: isLastItem ? at : itemPath });
    }
    editor.tf.focus();
  };

  useEffect(() => {
    if (readOnly) return;
    const id = (props.element as { id?: string }).id;
    if (!id) return;
    const activateFromPointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('[data-study-block-toolbar]')) return;
      const block = target.closest(
        '[data-slate-type="quiz"], [data-slate-type="flashcards"]'
      );
      if (block?.getAttribute('data-block-id') !== id) return;
      const path = editor.api.findPath(props.element);
      if (!path) return;
      requestAnimationFrame(() => {
        const selection = editor.selection;
        if (selection && isDescendantPath(path, selection.anchor.path)) return;
        editor.tf.select(editor.api.start(path));
        editor.tf.focus();
      });
    };
    document.addEventListener('pointerdown', activateFromPointer, true);
    return () =>
      document.removeEventListener('pointerdown', activateFromPointer, true);
  }, [editor, props.element, readOnly]);

  return (
    <PlateElement
      {...props}
      className={cn(STUDY_BLOCK_LIST_CLASS, 'relative', className)}
    >
      {!readOnly && toolbarMounted && (
        <StudyBlockToolbar
          onDelete={() => runBlockAction('delete')}
          onDuplicate={() => runBlockAction('duplicate')}
          onEdit={onEdit}
          onExited={() => setToolbarMounted(false)}
          open={active}
        />
      )}
      {children}
      {props.children}
    </PlateElement>
  );
}

function StudyBlockToolbar({
  open,
  onExited,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  open: boolean;
  onExited: () => void;
  onEdit?: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const editor = useEditorRef();
  const floating = useVirtualFloating({
    getBoundingClientRect: () =>
      getRangeBoundingClientRect(editor, editor.selection),
    middleware: [
      offset(10),
      flip({
        fallbackPlacements: [
          'top',
          'bottom-start',
          'bottom-end',
          'top-start',
          'top-end',
        ],
        padding: 12,
      }),
      shift({ padding: 12 }),
    ],
    open,
    placement: 'bottom',
    strategy: 'fixed',
  });
  useEditorSelector(() => {
    floating.update?.();
  }, [floating.update]);
  useEffect(() => {
    floating.update?.();
  }, [floating.update]);

  return (
    <FloatingPortal>
      <PopupMotion
        aria-label={m.editor_study_actions()}
        className="flex items-center gap-0.5 rounded-lg border border-overlay-line bg-overlay p-1 shadow-pop"
        contentEditable={false}
        data-floating-toolbar
        data-plate-prevent-deselect
        data-study-block-toolbar
        onExited={onExited}
        onMouseDown={(event) => event.preventDefault()}
        open={open}
        positionClassName="z-50"
        positionRef={floating.refs.setFloating}
        role="toolbar"
        style={floating.style}
      >
        {onEdit && (
          <>
            <StudyBlockAction label={m.action_edit()} onClick={onEdit}>
              <EditorIcon name="newNote" />
            </StudyBlockAction>
            <span className="mx-1 h-5 w-px bg-divider" />
          </>
        )}
        <StudyBlockAction label={m.editor_duplicate()} onClick={onDuplicate}>
          <EditorIcon name="copy" />
        </StudyBlockAction>
        <StudyBlockAction danger label={m.action_delete()} onClick={onDelete}>
          <EditorIcon name="trash" />
        </StudyBlockAction>
      </PopupMotion>
    </FloatingPortal>
  );
}

function StudyBlockAction({
  label,
  children,
  danger = false,
  onClick,
}: {
  label: string;
  children: React.ReactNode;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <ButtonTooltip label={label}>
      <button
        aria-label={label}
        className={cn(
          'flex size-8 items-center justify-center rounded-button text-fg-secondary hover:bg-surface-hover-bg hover:text-fg [&_svg]:size-4',
          danger && 'hover:text-tint-error-fg'
        )}
        data-plate-prevent-deselect
        onClick={onClick}
        onMouseDown={(event) => event.preventDefault()}
        type="button"
      >
        {children}
      </button>
    </ButtonTooltip>
  );
}

function isCollapsed(selection: {
  anchor: { path: number[]; offset: number };
  focus: { path: number[]; offset: number };
}): boolean {
  return (
    selection.anchor.offset === selection.focus.offset &&
    selection.anchor.path.length === selection.focus.path.length &&
    selection.anchor.path.every(
      (part, index) => part === selection.focus.path[index]
    )
  );
}

function isDescendantPath(parent: number[], child: number[]): boolean {
  return (
    child.length > parent.length &&
    parent.every((part, index) => child[index] === part)
  );
}

function stripElementIds(node: MaterialNode): MaterialNode {
  if ('text' in node) return { ...node };
  const { id: _id, ...element } = node;
  return {
    ...element,
    children: node.children.map(stripElementIds),
  } as MaterialElement;
}

/** Resolve the quiz_question / flashcard under the caret inside a study block. */
function findCurrentStudyItem(
  editor: AnyEditor,
  studyBlockPath: number[]
): [MaterialElement, number[]] | undefined {
  const selection = editor.selection;
  if (!selection || !isDescendantPath(studyBlockPath, selection.anchor.path)) {
    return;
  }
  const itemPath = selection.anchor.path.slice(0, studyBlockPath.length + 1);
  const node = editor.api.node(itemPath)?.[0];
  if (!node || (node.type !== 'quiz_question' && node.type !== 'flashcard')) {
    return;
  }
  return [node as MaterialElement, itemPath];
}

/** Duplicates get new question and part identities. */
function cloneStudyItem(element: MaterialElement): MaterialElement {
  if (element.type === 'quiz_question') {
    const clone = structuredClone(element) as QuizQuestionNode;
    clone.id = crypto.randomUUID();
    clone.question.id = clone.id;
    clone.question.parts.forEach((part) => {
      part.id = crypto.randomUUID();
    });
    return clone;
  }
  return normalizeMaterialValue([
    stripElementIds(structuredClone(element)) as MaterialElement,
  ])[0];
}

export function QuizElement(props: PlateElementProps) {
  return (
    <StudyBlockRoot props={props}>
      <StandaloneMaterialTitle kinds="quiz" />
    </StudyBlockRoot>
  );
}

export function FlashcardsElement(props: PlateElementProps) {
  return (
    <StudyBlockRoot className="gap-2" props={props}>
      <StandaloneMaterialTitle kinds="flashcards" />
    </StudyBlockRoot>
  );
}

/** A note's embedded quiz or flashcard set: a void block holding the material
 * id. Edit mode edits the item in place and View studies it (AppEmbed); edits
 * go through the material's own content endpoints, never through this
 * document. */
export function MaterialRefElement(props: PlateElementProps) {
  const editor = useEditorRef();
  const readOnly = useReadOnly();
  const owner = useOptionalEditorRuntime()?.materialId;
  const dialogs = useOptionalNoteBlockDialogs();
  const element = props.element as unknown as MaterialRefNode;
  const { materialId, refKind, pending } = element;
  const resolving = useRef(false);

  // A fence imported as markdown lands here without a row. Every client with
  // the note open sees it, so the node is claimed in the shared document
  // first and only the client whose claim survives the merge creates the row;
  // a failed creation drops the block.
  useEffect(() => {
    if (materialId || !pending || readOnly || !dialogs || resolving.current)
      return;
    if (element.resolvingBy && element.resolvingBy !== CLIENT_ID) return;
    resolving.current = true;
    const at = () => editor.api.findPath(props.element);
    const claim = at();
    if (!claim) return;
    editor.tf.setNodes({ resolvingBy: CLIENT_ID }, { at: claim });
    const timer = setTimeout(() => {
      const path = at();
      const current = path && (editor.api.node(path)?.[0] as MaterialRefNode);
      if (!current || current.resolvingBy !== CLIENT_ID) return;
      dialogs.createEmbedded(refKind, pending).then(
        (material) => {
          const target = at();
          if (!target) return;
          editor.tf.setNodes({ materialId: material.id }, { at: target });
          editor.tf.unsetNodes(['pending', 'resolvingBy'], { at: target });
        },
        () => {
          const target = at();
          if (target) editor.tf.removeNodes({ at: target });
        }
      );
    }, CLAIM_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [
    dialogs,
    editor,
    element.resolvingBy,
    materialId,
    pending,
    props.element,
    readOnly,
    refKind,
  ]);

  const canEdit = !readOnly && !!dialogs;
  return (
    <PlateElement {...props} className="my-4">
      <div contentEditable={false}>
        {materialId && canEdit ? (
          <AppEmbedEdit
            materialId={materialId}
            // The last question or card removed takes the block with it;
            // removing the block trashes the item, and Undo restores both.
            onEmpty={() => {
              const at = editor.api.findPath(props.element);
              if (at) editor.tf.removeNodes({ at });
            }}
            ownerId={owner}
            refKind={refKind}
          />
        ) : materialId ? (
          <AppEmbedView materialId={materialId} refKind={refKind} />
        ) : (
          <EmbedLoading />
        )}
      </div>
      {props.children}
    </PlateElement>
  );
}

const MermaidSourceDialog = lazy(() => import('./MermaidSourceDialog'));
const HtmlEmbedSourceDialog = lazy(() => import('./HtmlEmbedSourceDialog'));

/**
 * Copies one block exactly as Cmd+C would: a real copy event the editor fills.
 * navigator.clipboard.write cannot carry Plate's application/x-slate-fragment,
 * without which a paste finds no block.
 */
function copyBlock(editor: PlateEditor, element: TElement) {
  const at = editor.api.findPath(element);
  if (!at) return false;
  editor.tf.select(editor.api.range(at));
  editor.tf.focus();
  const fill = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.preventDefault();
    // The editor's own copy handler would refill it from the DOM selection.
    event.stopImmediatePropagation();
    editor.tf.setFragmentData(event.clipboardData, 'copy');
  };
  document.addEventListener('copy', fill, { capture: true });
  try {
    return document.execCommand('copy');
  } finally {
    document.removeEventListener('copy', fill, { capture: true });
  }
}

/** Copy for a block's toolbar; the icon swaps to a check for a moment. */
function CopyBlockButton({ element }: { element: TElement }) {
  const editor = useEditorRef();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timeout);
  }, [copied]);
  return (
    <ToolbarButton
      label={copied ? m.editor_copied() : m.action_copy()}
      onClick={() => setCopied(copyBlock(editor, element))}
      tooltipSide="top"
    >
      <ContentSwap contentKey={String(copied)} kind="icon">
        <EditorIcon name={copied ? 'check' : 'copy'} />
      </ContentSwap>
    </ToolbarButton>
  );
}

/** Mouse down on a media block selects it; its own fields and controls keep their focus. */
function useSelectOnMouseDown(element: TElement) {
  const editor = useEditorRef();
  const readOnly = useReadOnly();
  return (event: React.MouseEvent) => {
    if (
      readOnly ||
      (event.target as Element).closest(
        'input, button, [data-media-resize-handle]'
      )
    )
      return;
    event.preventDefault();
    const at = editor.api.findPath(element);
    if (at) {
      editor.tf.select(editor.api.start(at));
      editor.tf.focus();
    }
  };
}

/** Edit, Copy and Delete at the end of a media block's hover toolbar. */
function MediaBlockActions({
  element,
  onEdit,
}: {
  element: TElement;
  onEdit: () => void;
}) {
  const editor = useEditorRef();
  return (
    <>
      <ToolbarButton label={m.action_edit()} onClick={onEdit} tooltipSide="top">
        <EditorIcon name="pencil" />
      </ToolbarButton>
      <CopyBlockButton element={element} />
      <ToolbarButton
        label={m.action_delete()}
        onClick={() => {
          const at = editor.api.findPath(element);
          if (at) editor.tf.removeNodes({ at });
        }}
        tooltipSide="top"
        variant="danger-light"
      >
        <EditorIcon name="trash" />
      </ToolbarButton>
    </>
  );
}

export function VisualBlockElement(props: PlateElementProps) {
  const editor = useEditorRef();
  const readOnly = useReadOnly();
  const dialogs = useOptionalNoteBlockDialogs();
  const element = props.element as unknown as QuestionFigureNode;
  const { block } = element;
  const onMouseDown = useSelectOnMouseDown(props.element);
  const update = (patch: Partial<QuestionFigureNode>) => {
    const at = editor.api.findPath(props.element);
    if (at) editor.tf.setNodes(patch, { at });
  };
  return (
    <PlateElement {...props} className="relative my-3">
      <div contentEditable={false} onMouseDown={onMouseDown}>
        <FigureView
          block={block}
          onWidthChange={readOnly ? undefined : (width) => update({ width })}
          toolbar={
            readOnly ? undefined : (
              <MediaBlockActions
                element={props.element}
                onEdit={() =>
                  dialogs?.openVisual(block, (next) => update({ block: next }))
                }
              />
            )
          }
          width={element.width}
        />
      </div>
      {/* Slate's void spacer is already invisible; display:none would leave
       * the caret without a position, so focusing scrolled the page away. */}
      <span className="absolute top-0 left-0">{props.children}</span>
    </PlateElement>
  );
}

export function MermaidThemeMenu({
  compactOnPhones = false,
  theme,
  onTheme,
}: {
  /** Only the swatch below `sm`, where the bar is short of room. */
  compactOnPhones?: boolean;
  theme: MermaidTheme;
  onTheme: (theme: MermaidTheme) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover modal={false} onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        {/* `!`: the media toolbar squares every button; this one has a label. */}
        <ToolbarButton
          className="w-auto! px-1.5 text-sm"
          dropdown
          label={m.mermaid_theme()}
          tooltipSide="top"
        >
          <MermaidSwatch theme={theme} />
          <span
            className={cn(
              'translate-y-px pl-1',
              compactOnPhones && 'hidden sm:inline'
            )}
          >
            {MERMAID_THEME_LABEL[theme]()}
          </span>
        </ToolbarButton>
      </PopoverTrigger>
      <ToolbarPopoverContent align="end" className="w-46" open={open}>
        {MERMAID_THEMES.map((option) => (
          <ToolbarPopoverRow
            icon={<MermaidSwatch theme={option} />}
            key={option}
            label={MERMAID_THEME_LABEL[option]()}
            onClick={() => onTheme(option)}
            selected={option === theme}
          />
        ))}
      </ToolbarPopoverContent>
    </Popover>
  );
}

export function MermaidElement(props: PlateElementProps) {
  const editor = useEditorRef();
  const readOnly = useReadOnly();
  const element = props.element as unknown as MermaidNode;
  const theme = mermaidTheme(element.theme);
  const caption = NodeApi.string(props.element);
  const [editing, setEditing] = useState(false);
  const [captioning, setCaptioning] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  // A diagram that cannot be drawn shows its error, with nothing to enlarge.
  const [drawn, setDrawn] = useState(false);
  const captionRef = useRef<HTMLInputElement>(null);
  const onMouseDown = useSelectOnMouseDown(props.element);
  const locate = () => editor.api.findPath(props.element);
  const update = (patch: Partial<MermaidNode>) => {
    const at = locate();
    if (at) editor.tf.setNodes(patch, { at });
  };
  useEffect(() => {
    if (captioning) captionRef.current?.focus();
  }, [captioning]);
  return (
    <PlateElement {...props} className="relative my-3">
      <div contentEditable={false} onMouseDown={onMouseDown}>
        <MediaFrame
          fill
          onOpen={drawn ? () => setPreviewing(true) : undefined}
          onWidthChange={readOnly ? undefined : (width) => update({ width })}
          toolbar={
            readOnly ? undefined : (
              <>
                <MermaidThemeMenu
                  onTheme={(next) => update({ theme: next })}
                  theme={theme}
                />
                <ToolbarButton
                  label={m.editor_caption_add()}
                  onClick={() => setCaptioning(true)}
                  tooltipSide="top"
                >
                  <EditorIcon name="closedCaption" />
                </ToolbarButton>
                <MediaBlockActions
                  element={props.element}
                  onEdit={() => setEditing(true)}
                />
              </>
            )
          }
          width={element.width}
        >
          <Mermaid
            code={element.source}
            fill={element.width !== undefined}
            onDrawn={setDrawn}
            theme={theme}
          />
        </MediaFrame>
        {readOnly
          ? caption.trim() && <p className={MERMAID_CAPTION_CLASS}>{caption}</p>
          : (captioning || caption) && (
              <input
                aria-label={m.editor_caption_add()}
                className={cn(
                  MERMAID_CAPTION_CLASS,
                  'block w-full bg-transparent outline-none placeholder:text-placeholder'
                )}
                onBlur={() => setCaptioning(false)}
                onChange={(event) => {
                  const at = locate();
                  if (at) setMermaidCaption(editor, at, event.target.value);
                }}
                onKeyDown={(event) => {
                  // Keep editor shortcuts (Backspace, Enter, marks) out of the field.
                  event.stopPropagation();
                  if (event.key === 'Enter' || event.key === 'Escape') {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
                placeholder={m.editor_caption_placeholder()}
                ref={captionRef}
                value={caption}
              />
            )}
      </div>
      {/* Slate's void spacer is already invisible; display:none would leave
       * the caret without a position, so focusing scrolled the page away. */}
      <span className="absolute top-0 left-0">{props.children}</span>
      <MermaidPreview
        caption={caption}
        code={element.source}
        onOpenChange={setPreviewing}
        open={previewing}
        theme={theme}
      />
      {editing && (
        <Suspense fallback={null}>
          <MermaidSourceDialog
            onClose={() => setEditing(false)}
            onSave={(source) => update({ source })}
            source={element.source}
            theme={theme}
          />
        </Suspense>
      )}
    </PlateElement>
  );
}

/** Interactive HTML block: View source (editors save from it), Copy, Delete. */
export function HtmlEmbedElement(props: PlateElementProps) {
  const editor = useEditorRef();
  const readOnly = useReadOnly();
  const element = props.element as unknown as HtmlEmbedNode;
  const [viewing, setViewing] = useState(false);
  const locate = () => editor.api.findPath(props.element);
  return (
    <PlateElement {...props} className="relative my-3">
      <div
        contentEditable={false}
        onMouseDown={(event) => {
          if (readOnly || (event.target as Element).closest('button')) return;
          event.preventDefault();
          const at = locate();
          if (at) {
            editor.tf.select(editor.api.start(at));
            editor.tf.focus();
          }
        }}
      >
        <HtmlEmbed
          caption={element.caption}
          html={element.html}
          id={element.id}
          toolbar={
            <>
              <ToolbarButton
                label={m.html_embed_view_source()}
                onClick={() => setViewing(true)}
                tooltipSide="top"
              >
                <EditorIcon name="code" />
              </ToolbarButton>
              {!readOnly && (
                <>
                  <CopyBlockButton element={props.element} />
                  <ToolbarButton
                    label={m.action_delete()}
                    onClick={() => {
                      const at = locate();
                      if (at) editor.tf.removeNodes({ at });
                    }}
                    tooltipSide="top"
                    variant="danger-light"
                  >
                    <EditorIcon name="trash" />
                  </ToolbarButton>
                </>
              )}
            </>
          }
        />
      </div>
      {/* Slate's void spacer, kept positioned like the mermaid block's. */}
      <span className="absolute top-0 left-0">{props.children}</span>
      {viewing && (
        <Suspense fallback={null}>
          <HtmlEmbedSourceDialog
            caption={element.caption}
            html={element.html}
            onClose={() => setViewing(false)}
            onSave={
              readOnly
                ? undefined
                : (next) => {
                    const at = locate();
                    if (at) editor.tf.setNodes(next, { at });
                  }
            }
          />
        </Suspense>
      )}
    </PlateElement>
  );
}

export function QuizQuestionElement(props: PlateElementProps) {
  const editor = useEditorRef();
  const element = props.element as unknown as QuizQuestionNode;
  const path = editor.api.findPath(props.element);
  const index = path?.[path.length - 1];
  return (
    <PlateElement {...props} className={QUIZ_REVIEW_QUESTION_CLASS}>
      <div contentEditable={false}>
        <QuestionView
          question={quizQuestionElementToQuestion(element)}
          questionNumber={index == null ? undefined : index + 1}
          review
        />
      </div>
      <span className="hidden">{props.children}</span>
    </PlateElement>
  );
}

export function FlashcardElement(props: PlateElementProps) {
  const element = props.element as unknown as FlashcardNode;
  return (
    <PlateElement
      {...props}
      className={FLASHCARD_CLASS}
      data-card-id={element.id}
    >
      {props.children}
    </PlateElement>
  );
}

export function FlashcardFrontElement(props: PlateElementProps) {
  return (
    <PlateElement {...props} as="p" className={FLASHCARD_FRONT_CLASS}>
      {props.children}
    </PlateElement>
  );
}

export function FlashcardBackElement(props: PlateElementProps) {
  return (
    <PlateElement {...props} as="p" className={FLASHCARD_BACK_CLASS}>
      {props.children}
    </PlateElement>
  );
}

export function MermaidCaptionElement(props: PlateElementProps) {
  return (
    <PlateElement {...props} as="p" className={MERMAID_CAPTION_CLASS}>
      {props.children}
    </PlateElement>
  );
}
