import {
  FloatingPortal,
  flip,
  getRangeBoundingClientRect,
  offset,
  shift,
  useVirtualFloating,
} from '@platejs/floating';
import { Copy, PencilLine, Trash2 } from 'lucide-react';
import {
  PlateElement,
  type PlateElementProps,
  useEditorRef,
  useEditorSelector,
  useReadOnly,
} from 'platejs/react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import {
  type FlashcardElement as FlashcardNode,
  type FlashcardsElement as FlashcardsNode,
  flashcardsElementToCards,
  flashcardsNodeFromFence,
  type MaterialElement,
  type MaterialNode,
  type MermaidElement as MermaidNode,
  normalizeMaterialValue,
  type QuizElement as QuizNode,
  type QuizOptionElement as QuizOptionNode,
  type QuizQuestionElement as QuizQuestionNode,
  quizElementToBlock,
  quizNodeFromFence,
  quizQuestionElementToQuestion,
} from '@/features/materials/document';
import { Mermaid, mermaidBlockLabel } from '@/features/materials/Mermaid';
import { answerKey } from '@/features/quizzes/grade';
import {
  QuestionRunner,
  QuizOptionView,
  QuizQuestionHeader,
} from '@/features/quizzes/QuestionRunner';
import {
  type QuizOptionRole,
  quizOptionClassName,
} from '@/features/quizzes/quizOptionStyles';
import { cn } from '@/lib/cn';
import {
  BLOCK_SHELL_CLASS,
  FLASHCARD_BACK_CLASS,
  FLASHCARD_CLASS,
  FLASHCARD_FRONT_CLASS,
  MERMAID_CAPTION_CLASS,
  QUIZ_EXPLANATION_CLASS,
  QUIZ_REVIEW_PROMPT_CLASS,
  QUIZ_REVIEW_QUESTION_CLASS,
  STUDY_BLOCK_LIST_CLASS,
} from '../nodeStyles';
import { useOptionalNoteBlockDialogs } from './dialogContext';
import { flashcardsFenceBody, quizFenceBody } from './shared';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = any;

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
      {!readOnly && active && (
        <StudyBlockToolbar
          onDelete={() => runBlockAction('delete')}
          onDuplicate={() => runBlockAction('duplicate')}
          onEdit={onEdit}
        />
      )}
      {children}
      {props.children}
    </PlateElement>
  );
}

function StudyBlockToolbar({
  onEdit,
  onDuplicate,
  onDelete,
}: {
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
    open: true,
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
      <div
        aria-label="Study block actions"
        className="z-50 flex items-center gap-0.5 rounded-lg border border-line bg-surface p-1 shadow-pop"
        contentEditable={false}
        data-plate-prevent-deselect
        data-study-block-toolbar
        onMouseDown={(event) => event.preventDefault()}
        ref={floating.refs.setFloating}
        role="toolbar"
        style={floating.style}
      >
        {onEdit && (
          <>
            <StudyBlockAction label="Edit" onClick={onEdit}>
              <PencilLine />
            </StudyBlockAction>
            <span className="mx-1 h-5 w-px bg-divider" />
          </>
        )}
        <StudyBlockAction label="Duplicate" onClick={onDuplicate}>
          <Copy />
        </StudyBlockAction>
        <StudyBlockAction danger label="Delete" onClick={onDelete}>
          <Trash2 />
        </StudyBlockAction>
      </div>
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
    <button
      aria-label={label}
      className={cn(
        'flex size-8 items-center justify-center rounded-button text-fg-secondary hover:bg-surface-hover-bg hover:text-fg [&_svg]:size-4',
        danger && 'hover:text-tint-error-fg'
      )}
      data-plate-prevent-deselect
      onClick={onClick}
      onMouseDown={(event) => event.preventDefault()}
      title={label}
      type="button"
    >
      {children}
    </button>
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

/** Deep-clone a question/card with fresh ids, remapping correctOptionIds by option index. */
function cloneStudyItem(element: MaterialElement): MaterialElement {
  const oldOptionIds =
    element.type === 'quiz_question'
      ? (element as QuizQuestionNode).children
          .filter(
            (child): child is QuizOptionNode => child.type === 'quiz_option'
          )
          .map((child) => child.id)
      : undefined;
  const oldCorrectIds =
    element.type === 'quiz_question'
      ? [...((element as QuizQuestionNode).correctOptionIds ?? [])]
      : undefined;

  const [clone] = normalizeMaterialValue([
    stripElementIds(structuredClone(element)) as MaterialElement,
  ]);

  if (clone.type === 'quiz_question' && oldOptionIds && oldCorrectIds?.length) {
    const newOptions = (clone as QuizQuestionNode).children.filter(
      (child): child is QuizOptionNode => child.type === 'quiz_option'
    );
    const remapped = oldCorrectIds
      .map((id) => {
        const index = oldOptionIds.indexOf(id);
        return index >= 0 ? newOptions[index]?.id : undefined;
      })
      .filter((id): id is string => Boolean(id));
    if (remapped.length)
      (clone as QuizQuestionNode).correctOptionIds = remapped;
    else delete (clone as QuizQuestionNode).correctOptionIds;
  }

  return clone;
}

function BlockShell({
  props,
  onEdit,
  label,
  children,
}: {
  props: PlateElementProps;
  onEdit?: () => void;
  label: string;
  children?: React.ReactNode;
}) {
  const readOnly = useReadOnly();
  return (
    <PlateElement {...props} className={BLOCK_SHELL_CLASS}>
      <div contentEditable={false}>
        <div className="mb-1 flex items-center justify-between">
          <span className="t-label text-fg-muted">{label}</span>
          {!readOnly && onEdit && (
            <Button
              className="opacity-70 hover:opacity-100"
              onClick={onEdit}
              size="sm"
              variant="ghost"
            >
              Edit
            </Button>
          )}
        </div>
      </div>
      {children}
      {props.children}
    </PlateElement>
  );
}

export function QuizElement(props: PlateElementProps) {
  const editor = useEditorRef();
  const dialogs = useOptionalNoteBlockDialogs();
  const element = props.element as unknown as QuizNode;
  function edit() {
    dialogs?.openQuiz(quizFenceBody(quizElementToBlock(element)), (code) => {
      replaceElement(
        editor,
        props.element,
        quizNodeFromFence(code, element.id)
      );
    });
  }
  return <StudyBlockRoot onEdit={dialogs ? edit : undefined} props={props} />;
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
    />
  );
}

export function MermaidElement(props: PlateElementProps) {
  const editor = useEditorRef();
  const readOnly = useReadOnly();
  const element = props.element as unknown as MermaidNode;
  function edit() {
    const next = window.prompt('Mermaid diagram source', element.source);
    if (next == null) return;
    const at = editor.api.findPath(props.element);
    if (at)
      editor.tf.setNodes({ source: next } as Partial<MermaidNode>, { at });
  }
  return (
    <BlockShell
      label={mermaidBlockLabel(element.source)}
      onEdit={readOnly ? undefined : edit}
      props={props}
    >
      <div contentEditable={false}>
        <Mermaid code={element.source} />
      </div>
    </BlockShell>
  );
}

export function QuizQuestionElement(props: PlateElementProps) {
  const editor = useEditorRef();
  const readOnly = useReadOnly();
  const element = props.element as unknown as QuizQuestionNode;
  const path = editor.api.findPath(props.element);
  const pathIndex = path?.[path.length - 1];
  const questionNumber =
    typeof pathIndex === 'number' ? pathIndex + 1 : undefined;
  if (readOnly) {
    const question = quizQuestionElementToQuestion(element);
    return (
      <PlateElement {...props} className={QUIZ_REVIEW_QUESTION_CLASS}>
        <div contentEditable={false}>
          <QuestionRunner
            answer={answerKey(question)}
            onChange={() => undefined}
            question={question}
            questionNumber={questionNumber}
            review
            showExplanation
          />
        </div>
        <div aria-hidden="true" className="hidden">
          {props.children}
        </div>
      </PlateElement>
    );
  }
  return (
    <PlateElement {...props} className={QUIZ_REVIEW_QUESTION_CLASS}>
      <QuizQuestionHeader
        level={element.level}
        questionNumber={questionNumber}
        questionType={element.questionType}
      />
      {props.children}
    </PlateElement>
  );
}

export function QuizPromptElement(props: PlateElementProps) {
  return (
    <PlateElement {...props} as="p" className={QUIZ_REVIEW_PROMPT_CLASS}>
      {props.children}
    </PlateElement>
  );
}

export function QuizOptionElement(props: PlateElementProps) {
  const editor = useEditorRef();
  const element = props.element as unknown as QuizOptionNode & {
    explanation?: string;
    role?: QuizOptionRole;
  };
  const question = editorParentQuestion(editor, props.element);
  const correct = question?.correctOptionIds?.includes(element.id);
  const path = editor.api.findPath(props.element);
  const pathIndex = path?.[path.length - 1];
  const optionNumber = typeof pathIndex === 'number' ? pathIndex : undefined;
  return (
    <PlateElement
      {...props}
      className={quizOptionClassName(Boolean(correct), element.role)}
    >
      <QuizOptionView
        correct={Boolean(correct)}
        explanation={element.explanation}
        optionNumber={optionNumber}
        role={element.role}
      >
        {props.children}
      </QuizOptionView>
    </PlateElement>
  );
}

function editorParentQuestion(
  editor: AnyEditor,
  element: object
): QuizQuestionNode | undefined {
  const path = editor.api.findPath(element);
  if (!path || path.length < 1) return;
  const parent = editor.api.node(path.slice(0, -1))?.[0];
  return parent?.type === 'quiz_question'
    ? (parent as QuizQuestionNode)
    : undefined;
}

export function QuizExplanationElement(props: PlateElementProps) {
  return (
    <PlateElement
      {...props}
      as="p"
      className={cn('col-span-2', QUIZ_EXPLANATION_CLASS)}
    >
      {props.children}
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
