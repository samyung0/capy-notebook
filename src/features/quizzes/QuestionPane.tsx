import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  QUESTION_MARKS_MAX,
  QUESTION_TEXT_MAX,
  QUIZ_MARKSCHEME_MAX,
} from '@/api/limits.generated';
import type { Question } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Popover, PopoverTrigger } from '@/components/ui/Popover';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { ToolbarPopoverContent } from '@/components/ui/ToolbarPopover';
import type { ItemRoomStatus } from '@/features/collaboration/itemRoom';
import type { UndoTarget } from '@/features/collaboration/undo';
import type { UploadQuestionAsset } from '@/features/questions/BlockEditor';
import {
  AnswerEditor,
  answerLabels,
  emptyAnswer,
  MenuItem,
} from '@/features/questions/editorFields';
import { isLonePart, questionItems } from '@/features/questions/groups';
import { IssueSummary } from '@/features/questions/IssueViews';
import { issueMessages, questionIssues } from '@/features/questions/issues';
import {
  changeBlocks,
  QuestionDialog,
  withAnswer,
} from '@/features/questions/QuestionDialog';
import {
  type BlockSection,
  QuestionBlockView,
} from '@/features/questions/QuestionView';
import { TextEditor } from '@/features/questions/TextEditor';
import {
  QUESTION_TYPES,
  type QuestionAnswer,
  type QuestionBlock,
  type QuestionPart,
  type QuestionType,
  questionMarks,
  schemeMarks,
} from '@/features/questions/types';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';
import { IMAGE_ACCEPT } from '@/lib/fitImage';

const marksLabel = (count: number) =>
  count === 1 ? m.question_ui_one_mark() : m.question_ui_marks({ count });
const MARKS = Array.from({ length: QUESTION_MARKS_MAX }, (_, i) => i + 1);

/** The board's bordered dropdown, for marks and answer types. */
function FieldSelect({
  ariaLabel,
  className,
  onChange,
  options,
  value,
}: {
  ariaLabel: string;
  className?: string;
  onChange: (value: string) => void;
  options: readonly { label: string; value: string }[];
  value: string;
}) {
  return (
    <Select onValueChange={onChange} value={value}>
      <SelectTrigger aria-label={ariaLabel} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function LabelledField({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className?: string;
  label: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <span className="t-meta font-semibold text-fg-secondary">{label}</span>
      {children}
    </div>
  );
}

/** A text block: reads as the learner sees it, a click edits it in place, and
 * clicking away or Escape leaves. */
function TextBlock({
  block,
  onChange,
  placeholder,
}: {
  block: Extract<QuestionBlock, { type: 'text' }>;
  onChange: (block: QuestionBlock) => void;
  placeholder: string;
}) {
  const [caret, setCaret] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!editing) return;
    const leave = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        !box.current?.contains(target) &&
        // A formula's keyboard and popovers sit outside the block.
        !target.closest(
          '[data-radix-popper-content-wrapper], .ML__keyboard, [role="dialog"]'
        )
      )
        setEditing(false);
    };
    document.addEventListener('pointerdown', leave, true);
    return () => document.removeEventListener('pointerdown', leave, true);
  }, [editing]);
  if (editing)
    return (
      <div
        className="rounded-input border border-action-accent bg-field px-3 py-2"
        onKeyDown={(event) => {
          if (event.key === 'Escape') setEditing(false);
        }}
        ref={box}
        role="presentation"
      >
        <TextEditor
          caretAt={caret}
          compact
          maxLength={QUESTION_TEXT_MAX}
          onChange={(text) => onChange({ ...block, text })}
          placeholder={placeholder}
          value={block.text}
        />
      </div>
    );
  const empty = !block.text.trim();
  return (
    <button
      className="-mx-1.5 block w-[calc(100%+0.75rem)] cursor-text rounded-md px-1.5 py-0.5 text-left outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action"
      onClick={(event) => {
        setCaret(event.detail ? { x: event.clientX, y: event.clientY } : null);
        setEditing(true);
      }}
      type="button"
    >
      {empty ? (
        <span className="text-fg-muted leading-relaxed">{placeholder}</span>
      ) : (
        <QuestionBlockView block={block} />
      )}
    </button>
  );
}

/** An image block: a dashed box with Choose image until it has its file (the
 * issue above says the same), then the image with Change. */
function ImageBlock({
  block,
  onChange,
  uploadAsset,
}: {
  block: Extract<QuestionBlock, { type: 'image' }>;
  onChange: (block: QuestionBlock) => void;
  uploadAsset: UploadQuestionAsset;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const chosen = 'assetId' in block.image || !!block.image.url;
  const button = (
    <Button
      disabled={uploading}
      onClick={() => input.current?.click()}
      size="sm"
      type="button"
      variant="outline"
    >
      {uploading ? m.question_ui_uploading() : m.quiz_editor_choose_image()}
    </Button>
  );
  return (
    <div className="flex flex-col gap-2">
      <input
        accept={IMAGE_ACCEPT}
        className="hidden"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (input.current) input.current.value = '';
          if (!file) return;
          setUploading(true);
          setError('');
          const local = URL.createObjectURL(file);
          try {
            const image = new Image();
            image.src = local;
            await image.decode();
            onChange({
              ...block,
              height: image.naturalHeight,
              image: await uploadAsset(file),
              width: image.naturalWidth,
            });
          } catch (failure) {
            setError(errorCopy(failure, m.question_ui_upload_failed()));
          } finally {
            URL.revokeObjectURL(local);
            setUploading(false);
          }
        }}
        ref={input}
        type="file"
      />
      {chosen ? (
        <div className="flex flex-col items-start gap-2 [&_figure]:mx-0 [&_img]:max-h-80 [&_img]:w-auto">
          <QuestionBlockView block={block} />
          {button}
        </div>
      ) : (
        <div className="flex h-27.5 items-center gap-3 rounded-lg border border-line border-dashed px-5 text-fg-muted">
          <Icon name="image" />
          {button}
        </div>
      )}
      {error && (
        <p className="t-meta text-tint-error-fg" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The fields under a part (board X2): Answer type, the correct answer and
 * Marks in one row; an open part's marking scheme; other answer types as the
 * question dialog edits them. */
function AnswerFields({
  onChange,
  part,
}: {
  onChange: (part: QuestionPart) => void;
  part: QuestionPart;
}) {
  const { answer } = part;
  const setAnswer = (next: QuestionAnswer) =>
    onChange(
      next.type === answer.type
        ? { ...part, answer: next }
        : withAnswer(part, next)
    );
  const typeField = (
    <LabelledField label={m.question_ui_answer_type()}>
      <FieldSelect
        ariaLabel={m.question_ui_answer_type()}
        onChange={(value) => setAnswer(emptyAnswer(value as QuestionType))}
        options={QUESTION_TYPES.map((value) => ({
          label: answerLabels[value](),
          value,
        }))}
        value={answer.type}
      />
    </LabelledField>
  );
  const marksField = (
    <LabelledField
      className="sm:col-start-3"
      label={m.question_ui_part_marks()}
    >
      <FieldSelect
        ariaLabel={m.question_ui_part_marks()}
        onChange={(value) => onChange({ ...part, marks: Number(value) })}
        options={MARKS.map((value) => ({
          label: marksLabel(value),
          value: String(value),
        }))}
        value={String(part.marks)}
      />
    </LabelledField>
  );
  const row = (middle?: ReactNode) => (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-[200px_minmax(0,1fr)_140px]">
      {typeField}
      {middle}
      {answer.type !== 'open' && marksField}
    </div>
  );
  if (answer.type === 'short')
    return (
      <>
        {row(
          <LabelledField
            className="col-span-2 row-start-2 sm:col-span-1 sm:col-start-2 sm:row-start-1"
            label={m.question_ui_correct_answer()}
          >
            <Input
              aria-label={m.question_ui_correct_answer()}
              maxLength={QUESTION_TEXT_MAX}
              onChange={(event) =>
                setAnswer({
                  ...answer,
                  accepted: [event.target.value, ...answer.accepted.slice(1)],
                })
              }
              value={answer.accepted[0] ?? ''}
            />
          </LabelledField>
        )}
        {answer.accepted.slice(1).map((value, i) => (
          <div className="flex items-center gap-2" key={i}>
            <Input
              aria-label={m.question_ui_numbered_item({
                label: m.question_ui_accepted_answers(),
                number: i + 2,
              })}
              maxLength={QUESTION_TEXT_MAX}
              onChange={(event) =>
                setAnswer({
                  ...answer,
                  accepted: answer.accepted.map((item, j) =>
                    j === i + 1 ? event.target.value : item
                  ),
                })
              }
              value={value}
              wrapperClassName="flex-1"
            />
            <ToolbarButton
              label={m.question_ui_remove_item({
                label: m.question_ui_accepted_answers(),
                number: i + 2,
              })}
              onClick={() =>
                setAnswer({
                  ...answer,
                  accepted: answer.accepted.filter((_, j) => j !== i + 1),
                })
              }
            >
              <Icon name="x" size={16} />
            </ToolbarButton>
          </div>
        ))}
      </>
    );
  if (answer.type === 'boolean')
    return row(
      <LabelledField
        className="col-span-2 row-start-2 sm:col-span-1 sm:col-start-2 sm:row-start-1"
        label={m.question_ui_correct_answer()}
      >
        <FieldSelect
          ariaLabel={m.question_ui_correct_answer()}
          onChange={(value) =>
            setAnswer({ ...answer, correct: value === 'true' })
          }
          options={[
            { label: m.question_ui_true(), value: 'true' },
            { label: m.question_ui_false(), value: 'false' },
          ]}
          value={String(answer.correct)}
        />
      </LabelledField>
    );
  if (answer.type === 'open') {
    const items = part.markscheme ?? [];
    const total = items.reduce((sum, item) => sum + item.marks, 0);
    const setItems = (markscheme: typeof items) =>
      onChange({ ...part, marks: schemeMarks(markscheme), markscheme });
    return (
      <>
        {row()}
        <p className="t-meta mt-2.5 font-semibold text-fg-secondary">
          {m.question_ui_scheme_marks({ marks: marksLabel(part.marks) })}
        </p>
        {items.map((item, i) => (
          <div
            className="group/item relative grid grid-cols-[minmax(0,1fr)_72px_auto] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_72px]"
            key={i}
          >
            <Input
              aria-label={m.question_ui_numbered_item({
                label: m.question_ui_marking_scheme(),
                number: i + 1,
              })}
              onChange={(event) =>
                setItems(
                  items.map((row, j) =>
                    j === i ? { ...row, text: event.target.value } : row
                  )
                )
              }
              value={item.text}
            />
            <FieldSelect
              ariaLabel={m.question_ui_item_marks({ number: i + 1 })}
              onChange={(value) =>
                setItems(
                  items.map((row, j) =>
                    j === i ? { ...row, marks: Number(value) } : row
                  )
                )
              }
              options={MARKS.slice(
                0,
                Math.max(item.marks, QUESTION_MARKS_MAX - total + item.marks)
              ).map((value) => ({
                label: String(value),
                value: String(value),
              }))}
              value={String(item.marks)}
            />
            {/* From sm outside the row, on hover, so the rows read as the
                board's. */}
            <span className="sm:absolute sm:-right-9 sm:opacity-0 sm:group-hover/item:opacity-100 sm:focus-within:opacity-100">
              <ToolbarButton
                label={m.question_ui_remove_item({
                  label: m.question_ui_marking_scheme(),
                  number: i + 1,
                })}
                onClick={() => setItems(items.filter((_, j) => j !== i))}
              >
                <Icon name="x" size={16} />
              </ToolbarButton>
            </span>
          </div>
        ))}
        {items.length < QUIZ_MARKSCHEME_MAX && total < QUESTION_MARKS_MAX && (
          <Button
            className="-ml-3 self-start"
            iconLeft="plus"
            onClick={() => setItems([...items, { marks: 1, text: '' }])}
            size="sm"
            type="button"
            variant="ghost-hover"
          >
            {m.question_ui_add_item()}
          </Button>
        )}
      </>
    );
  }
  return (
    <>
      {row()}
      <AnswerEditor
        answer={answer}
        bank={false}
        onChange={setAnswer}
        typeField={false}
      />
    </>
  );
}

/**
 * One question of the quiz editor (Epo 2026-11-02, board X2): its title and
 * marks, its first issue, then its text, figures and parts, each edited where
 * it stands. Anything the page doesn't lay out (charts, graphs, tables, blanks,
 * layout, adding blocks or parts) is in Edit all details, the question dialog
 * on the same question.
 */
export function QuestionPane({
  canMoveDown,
  canMoveUp,
  context,
  number,
  opening,
  onMove,
  onRemove,
  question,
  status,
  undo,
  uploadAsset,
  write,
}: {
  /** Painted before its keys come: nothing to warn about yet. */
  opening?: boolean;

  canMoveDown: boolean;
  canMoveUp: boolean;
  context: string;
  number: number;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  question: Question;
  status: ItemRoomStatus;
  undo: UndoTarget | null;
  uploadAsset: UploadQuestionAsset;
  write: (question: Question) => void;
}) {
  const [details, setDetails] = useState(false);
  const [removing, setRemoving] = useState(false);
  const title = m.quiz_editor_question({ number });
  const marks = questionMarks(question);
  const lone = isLonePart(question);
  const changePart = (part: QuestionPart) =>
    write({
      ...question,
      parts: question.parts.map((item) => (item.id === part.id ? part : item)),
    });
  const blocks = (
    list: QuestionBlock[],
    section: BlockSection,
    placeholder: string
  ) =>
    list.map((block, index) => {
      const onChange = (next: QuestionBlock) =>
        write(
          changeBlocks(
            question,
            section,
            list.map((item, i) => (i === index ? next : item))
          )
        );
      const part = question.parts.find((item) => item.id === section.partId);
      // A blanks part's text carries its answers: the dialog edits them together.
      const inline =
        block.type === 'text' &&
        !(part?.answer.type === 'gaps' && !section.solution);
      return (
        <div key={index}>
          {inline ? (
            <TextBlock
              block={block}
              onChange={onChange}
              placeholder={placeholder}
            />
          ) : block.type === 'image' ? (
            <ImageBlock
              block={block}
              onChange={onChange}
              uploadAsset={uploadAsset}
            />
          ) : (
            <button
              aria-label={m.quiz_editor_edit_block()}
              className="block w-full cursor-pointer rounded-md text-left outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action"
              onClick={() => setDetails(true)}
              type="button"
            >
              <QuestionBlockView block={block} />
            </button>
          )}
        </div>
      );
    });
  const partBody = (part: QuestionPart, label: string) => (
    <div
      className={cn(
        'flex flex-col gap-2',
        !lone && 'border-divider border-t pt-3'
      )}
      key={part.id}
    >
      <div className="flex gap-2.5 font-semibold">
        {!lone && (
          <span className="shrink-0 py-0.5 text-fg-secondary leading-relaxed">
            {label}
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {blocks(
            part.blocks,
            { partId: part.id },
            m.question_ui_question_placeholder()
          )}
        </div>
      </div>
      <AnswerFields onChange={changePart} part={part} />
      {part.solution.length > 0 ? (
        <>
          <div className="mt-2 flex items-center gap-2.5 font-semibold text-[12.5px] text-fg-muted">
            <span className="wavy-rule flex-1 text-line-strong" />
            {m.quiz_editor_worked_solution()}
            <span className="wavy-rule flex-1 text-line-strong" />
          </div>
          <div className="flex flex-col gap-2 text-fg-secondary">
            {blocks(
              part.solution,
              { partId: part.id, solution: true },
              m.question_ui_solution_placeholder()
            )}
          </div>
        </>
      ) : (
        <button
          className="t-meta cursor-pointer self-start text-fg-muted underline-offset-2 hover:text-fg hover:underline"
          onClick={() =>
            changePart({ ...part, solution: [{ text: '', type: 'text' }] })
          }
          type="button"
        >
          {m.quiz_editor_add_solution()}
        </button>
      )}
    </div>
  );
  return (
    <section
      aria-label={title}
      className="flex max-w-205 flex-col gap-3 px-4 pt-4 pb-24 sm:px-10 sm:pt-5.5 md:pb-5.5"
    >
      {/* The tour opens the question dialog through it. */}
      <button
        className="hidden"
        data-question-edit
        onClick={() => setDetails(true)}
        tabIndex={-1}
        type="button"
      />
      <div className="flex items-center gap-2.5">
        <h2 className="font-semibold text-[15px]">{title}</h2>
        <span className="t-meta text-fg-muted">{marksLabel(marks)}</span>
        <span className="ml-auto" />
        <Popover>
          <PopoverTrigger asChild>
            <ToolbarButton label={m.quiz_editor_question_actions({ number })}>
              <Icon name="moreVertical" />
            </ToolbarButton>
          </PopoverTrigger>
          <ToolbarPopoverContent align="end" className="w-52">
            <MenuItem
              disabled={!canMoveUp}
              icon={<Icon name="arrowUp" />}
              label={m.question_ui_move_up()}
              onClick={() => onMove(-1)}
            />
            <MenuItem
              disabled={!canMoveDown}
              icon={<Icon name="arrowDown" />}
              label={m.question_ui_move_down()}
              onClick={() => onMove(1)}
            />
            <MenuItem
              icon={<Icon name="pencil" />}
              label={m.quiz_editor_more_details()}
              onClick={() => setDetails(true)}
            />
            <MenuItem
              icon={<Icon name="trash" />}
              label={m.action_remove()}
              onClick={() => setRemoving(true)}
            />
          </ToolbarPopoverContent>
        </Popover>
      </div>
      {!opening && (
        <IssueSummary messages={issueMessages(questionIssues(question))} />
      )}
      {blocks(question.stem, {}, m.question_ui_question_placeholder())}
      {questionItems(question).map((item) =>
        item.kind === 'part' ? (
          partBody(item.part, item.label)
        ) : (
          <div
            className="flex flex-col gap-3 border-divider border-t pt-3"
            key={item.group.id}
          >
            <div className="flex gap-2.5 font-semibold">
              <span className="shrink-0 py-0.5 text-fg-secondary leading-relaxed">
                {item.label}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                {blocks(
                  item.group.blocks,
                  { groupId: item.group.id },
                  m.question_ui_question_placeholder()
                )}
              </div>
            </div>
            <div className="flex flex-col gap-3 sm:pl-4">
              {item.parts.map(({ label, part }) => partBody(part, label))}
            </div>
          </div>
        )
      )}
      <ConfirmDialog
        body={m.quiz_remove_question_confirm_body()}
        confirmLabel={m.action_remove()}
        onClose={() => setRemoving(false)}
        onConfirm={onRemove}
        open={removing}
        title={m.quiz_remove_question_confirm_title()}
      />
      <QuestionDialog
        context={context}
        live={{ status, undo, write }}
        onClose={() => setDetails(false)}
        open={details}
        question={question}
        questionNumber={number}
        uploadAsset={uploadAsset}
      />
    </section>
  );
}
