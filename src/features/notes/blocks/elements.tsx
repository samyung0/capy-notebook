import {
  FloatingPortal,
  flip,
  getRangeBoundingClientRect,
  offset,
  shift,
  useVirtualFloating,
} from '@platejs/floating';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { NodeApi } from 'platejs';
import {
  PlateElement,
  type PlateElementProps,
  useEditorRef,
  useEditorSelector,
  useReadOnly,
  useSelected,
} from 'platejs/react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { materialQuery, useUpdateFlashcardContent } from '@/api/hooks';
import { showErrorToast } from '@/api/queryClient';
import { FloatingBlockToolbar } from '@/components/ui/BlockToolbar';
import {
  Popover,
  PopoverAnchor,
  PopoverTrigger,
} from '@/components/ui/Popover';
import { PopupMotion } from '@/components/ui/PopupMotion';
import { ButtonTooltip } from '@/components/ui/Tooltip';
import { parseFlashcardsFenceBody } from '@/features/materials/blocks';
import {
  type FlashcardElement as FlashcardNode,
  type FlashcardsElement as FlashcardsNode,
  flashcardsElementToCards,
  flashcardsNodeFromFence,
  type MaterialElement,
  type MaterialNode,
  type MaterialRefElement as MaterialRefNode,
  type MermaidElement as MermaidNode,
  normalizeMaterialValue,
  type QuizQuestionElement as QuizQuestionNode,
  quizQuestionElementToQuestion,
} from '@/features/materials/document';
import { MaterialRefCard } from '@/features/materials/MaterialRefCard';
import { StandaloneMaterialTitle } from '@/features/materials/MaterialRenderContext';
import { Mermaid, MermaidSwatch } from '@/features/materials/Mermaid';
import {
  MERMAID_THEME_LABEL,
  MERMAID_THEMES,
  type MermaidTheme,
  mermaidTheme,
} from '@/features/materials/mermaidThemes';
import { EditorIcon } from '@/features/notes/EditorIcon';
import {
  QuestionBlockView,
  QuestionView,
} from '@/features/questions/QuestionView';
import { quizEditSearch } from '@/features/quizzes/quizNavigation';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { uid } from '@/lib/id';
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
import { flashcardsFenceBody } from './shared';
import type { NoteVisualBlock } from './VisualBlockDialog';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = any;

/** Identifies this browser session's claim on a pending reference. */
const CLIENT_ID = uid('client');
/** Long enough for a concurrent claim to merge back before creating a row. */
const CLAIM_SETTLE_MS = 400;

function replaceElement(editor: AnyEditor, current: object, next: object) {
  const at = editor.api.findPath(current);
  if (!at) return;
  editor.tf.replaceNodes(next, { at });
}

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
        className="flex items-center gap-0.5 rounded-lg border border-line bg-surface p-1 shadow-pop"
        contentEditable={false}
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
  const editor = useEditorRef();
  const dialogs = useOptionalNoteBlockDialogs();
  const element = props.element as unknown as FlashcardsNode;
  function edit() {
    dialogs?.openFlashcards(
      flashcardsFenceBody(flashcardsElementToCards(element)),
      (code) => {
        replaceElement(
          editor,
          props.element,
          flashcardsNodeFromFence(code, element.id)
        );
      }
    );
  }
  return (
    <StudyBlockRoot
      className="gap-2"
      onEdit={dialogs ? edit : undefined}
      props={props}
    >
      <StandaloneMaterialTitle kinds="flashcards" />
    </StudyBlockRoot>
  );
}

/** A note's embedded quiz or flashcard set: a void block holding the material
 * id, rendered as a compact card. Edits go through the authoring dialogs and
 * the material's own content endpoints, never through this document. */
export function MaterialRefElement(props: PlateElementProps) {
  const editor = useEditorRef();
  const readOnly = useReadOnly();
  const dialogs = useOptionalNoteBlockDialogs();
  const queryClient = useQueryClient();
  const element = props.element as unknown as MaterialRefNode;
  const { materialId, refKind, pending } = element;
  const navigate = useNavigate();
  const router = useRouter();
  const { mutateAsync: updateFlashcardContent } =
    useUpdateFlashcardContent(materialId);
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

  function editQuiz() {
    void navigate({
      params: { quizId: materialId },
      search: quizEditSearch(router.state.location.href),
      to: '/quizzes/$quizId/edit',
    });
  }

  async function editFlashcards() {
    const latest = await queryClient.fetchQuery({
      ...materialQuery(materialId),
      staleTime: 0,
    });
    const block = latest.content.value.find(
      (node): node is FlashcardsNode => node.type === 'flashcards'
    );
    if (!block) throw new Error('Flashcard content is unavailable');
    const current = flashcardsElementToCards(block);
    dialogs?.openFlashcards(
      flashcardsFenceBody(
        current.map(({ id, front, back }) => ({ back, front, id }))
      ),
      async (code) => {
        await updateFlashcardContent({
          cards: parseFlashcardsFenceBody(code).cards.map((card) => ({
            back: card.back,
            front: card.front,
            ...(current.some((item) => item.id === card.id)
              ? { id: card.id }
              : {}),
          })),
          expectedRevision: latest.revision,
        });
      }
    );
  }

  const canEdit = !readOnly && !!dialogs && !!materialId;
  return (
    <PlateElement {...props} className="my-4">
      <MaterialRefCard
        materialId={materialId}
        onEdit={
          canEdit
            ? refKind === 'quiz'
              ? () => void editQuiz()
              : () => void editFlashcards().catch(showErrorToast)
            : undefined
        }
        refKind={refKind}
      />
      {props.children}
    </PlateElement>
  );
}

const MermaidSourceDialog = lazy(() => import('./MermaidSourceDialog'));

function EmbedShell({
  props,
  onEdit,
  tools,
  children,
}: {
  props: PlateElementProps;
  onEdit: () => void;
  /** Block-specific controls placed before edit, copy and delete. */
  tools?: React.ReactNode;
  children: React.ReactNode;
}) {
  const editor = useEditorRef();
  const readOnly = useReadOnly();
  const selected = useSelected();
  const collapsed = useEditorSelector(
    (current) => current.api.isCollapsed(),
    []
  );
  const active = selected && collapsed && !readOnly;
  const locate = () => editor.api.findPath(props.element);
  async function copy() {
    const at = locate();
    if (!at) return;
    editor.tf.select(editor.api.range(at));
    editor.tf.focus();
    const data = new DataTransfer();
    editor.tf.setFragmentData(data, 'copy');
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([data.getData('text/html')], {
          type: 'text/html',
        }),
        'text/plain': new Blob([data.getData('text/plain')], {
          type: 'text/plain',
        }),
      }),
    ]);
  }
  const className = cn(
    'relative my-4 rounded-md border border-transparent p-2',
    active && 'border-action-accent ring-2 ring-action-accent/20'
  );
  const body = (
    <div
      contentEditable={false}
      onMouseDown={(event) => {
        // Fields inside the embed (the caption) take their own focus.
        if (readOnly || (event.target as Element).closest('input')) return;
        event.preventDefault();
        const at = locate();
        if (at) {
          editor.tf.select(editor.api.start(at));
          editor.tf.focus();
        }
      }}
    >
      {children}
    </div>
  );
  // Slate's void spacer is already invisible; display:none would leave the
  // caret without a position, so focusing the block scrolled the page away.
  const spacer = (
    <span className="absolute top-0 left-0">{props.children}</span>
  );
  const actions = (
    <>
      <ToolbarButton label={m.action_edit()} onClick={onEdit}>
        <EditorIcon name="pencil" />
      </ToolbarButton>
      <ToolbarButton
        label={m.action_copy()}
        onClick={() => void copy().catch(showErrorToast)}
      >
        <EditorIcon name="copy" />
      </ToolbarButton>
      <ToolbarButton
        label={m.action_delete()}
        onClick={() => {
          const at = locate();
          if (at) editor.tf.removeNodes({ at });
        }}
        variant="danger-light"
      >
        <EditorIcon name="trash" />
      </ToolbarButton>
    </>
  );
  return (
    <Popover modal={false} open={active}>
      <PopoverAnchor asChild>
        <PlateElement {...props} className={className}>
          {body}
          {spacer}
        </PlateElement>
      </PopoverAnchor>
      <FloatingBlockToolbar aria-label={m.editor_study_actions()} open={active}>
        {tools}
        {actions}
      </FloatingBlockToolbar>
    </Popover>
  );
}

export function VisualBlockElement(props: PlateElementProps) {
  const editor = useEditorRef();
  const dialogs = useOptionalNoteBlockDialogs();
  const element = props.element as unknown as { block: NoteVisualBlock };
  function edit() {
    dialogs?.openVisual(element.block, (block) => {
      const at = editor.api.findPath(props.element);
      if (at) editor.tf.setNodes({ block }, { at });
    });
  }
  return (
    <EmbedShell onEdit={edit} props={props}>
      <QuestionBlockView block={element.block} />
    </EmbedShell>
  );
}

function MermaidThemeMenu({
  theme,
  onTheme,
}: {
  theme: MermaidTheme;
  onTheme: (theme: MermaidTheme) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover modal={false} onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <ToolbarButton
          className="px-1.5 text-sm"
          dropdown
          label={m.mermaid_theme()}
        >
          <MermaidSwatch theme={theme} />
          <span className="translate-y-px">{MERMAID_THEME_LABEL[theme]()}</span>
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
  const captionRef = useRef<HTMLInputElement>(null);
  const locate = () => editor.api.findPath(props.element);
  useEffect(() => {
    if (captioning) captionRef.current?.focus();
  }, [captioning]);
  return (
    <>
      <EmbedShell
        onEdit={() => setEditing(true)}
        props={props}
        tools={
          <>
            <MermaidThemeMenu
              onTheme={(next) => {
                const at = locate();
                if (at) editor.tf.setNodes({ theme: next }, { at });
              }}
              theme={theme}
            />
            <ToolbarButton
              label={m.editor_caption_add()}
              onClick={() => setCaptioning(true)}
            >
              <EditorIcon name="closedCaption" />
            </ToolbarButton>
          </>
        }
      >
        <StandaloneMaterialTitle kinds={['mindmap', 'diagram']} />
        <Mermaid code={element.source} theme={theme} />
        {readOnly
          ? caption.trim() && <p className={MERMAID_CAPTION_CLASS}>{caption}</p>
          : (captioning || caption) && (
              <input
                aria-label={m.editor_caption_add()}
                className={cn(
                  MERMAID_CAPTION_CLASS,
                  'block w-full bg-transparent outline-none placeholder:text-fg-placeholder'
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
      </EmbedShell>
      {editing && (
        <Suspense fallback={null}>
          <MermaidSourceDialog
            onClose={() => setEditing(false)}
            onRemove={() => {
              const at = locate();
              if (at) editor.tf.removeNodes({ at });
            }}
            onSave={(source) => {
              const at = locate();
              if (at) editor.tf.setNodes({ source }, { at });
            }}
            source={element.source}
            theme={theme}
          />
        </Suspense>
      )}
    </>
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
