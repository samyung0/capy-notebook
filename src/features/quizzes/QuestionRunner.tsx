import {
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useRef,
  useState,
} from 'react';
import { QUIZ_OPEN_ANSWER_MAX } from '@/api/limits.generated';
import type { Question, QuestionPart } from '@/api/types';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { CharCount, Input, InputError } from '@/components/ui/Input';
import { AiWarning } from '@/features/questions/AiWarning';
import { MatchingGrid } from '@/features/questions/MatchingGrid';
import {
  AnswerView,
  ChoiceMarker,
  CorrectTag,
  choiceRowsClass,
  OptionKey,
  optionColumns,
  optionLetter,
  QuestionBlockView,
  QuestionReview,
  QuestionView,
  type QuestionViewProps,
  type RowState,
  TextView,
} from '@/features/questions/QuestionView';
import {
  GAP_MARKER,
  isAuthoredPart,
  type LearnerPart,
  type LearnerQuestion,
  multipleAnswers,
  shownOptions,
  type TextBlock,
} from '@/features/questions/types';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { textLength } from '@/lib/textLength';
import { DrawingAnswer } from './drawing/DrawingAnswer';
import type { PinnedQuestion } from './drawing/DrawingBoardScreen';
import { isDrawingValue } from './drawing/drawingValue';
import { pinnedQuestion } from './drawing/pinnedQuestion';
import {
  type Answer,
  type Answers,
  emptyAnswer,
  formatPoints,
  quantityValue,
} from './grade';

// Plate and the formula field load with the first long answer.
const TextEditor = lazy(() =>
  import('@/features/questions/TextEditor').then((module) => ({
    default: module.TextEditor,
  }))
);

/** A learner's long answer as written, formulas typeset, on ruled lines. */
function OpenAnswerView({ text }: { text: string }) {
  return (
    <div className="ruled-lines min-h-[calc(var(--ruled-line)*3)] px-0.5">
      <TextView marks text={text} />
    </div>
  );
}

/** A learner's long answer with formulas (Epo 2026-11-16, mock B): one
 * Formula button and the formula keyboard under it. The editor reads its
 * value once, so a value changed from outside (a reset) remounts it. */
function OpenAnswerField({
  onChange,
  value,
}: {
  onChange: (value: string) => void;
  value: string;
}) {
  const own = useRef(value);
  const [shown, setShown] = useState({ key: 0, value });
  if (value !== shown.value)
    setShown({
      key: value === own.current ? shown.key : shown.key + 1,
      value,
    });
  const [tools, setTools] = useState<HTMLSpanElement | null>(null);
  return (
    <>
      <Suspense fallback={<OpenAnswerView text={value} />}>
        <TextEditor
          answer
          key={shown.key}
          maxLength={QUIZ_OPEN_ANSWER_MAX}
          onChange={(text) => {
            own.current = text;
            onChange(text);
          }}
          placeholder={m.question_ui_type_answer()}
          toolbarTarget={tools}
          value={value}
        />
      </Suspense>
      <div className="flex min-h-9 items-center gap-1">
        <span className="flex items-center gap-1" ref={setTools} />
        <CharCount
          className="ml-auto"
          max={QUIZ_OPEN_ANSWER_MAX}
          value={textLength(value)}
        />
      </div>
    </>
  );
}

// Silent cap on gap and short answers; they are graded without the model.
const SHORT_ANSWER_MAX = 1000;

const NON_QUANTITY_CHAR = /[^\d\s+\-./eE]/;

/**
 * One question in the shared quiz look, used for taking, reviewing and every
 * read-only view (quiz preview, quiz editor, question bank, question dialog).
 */
export function QuestionRunner({
  question,
  answers,
  onChange,
  review = false,
  disabled = false,
  showAnswerKey = false,
  questionNumber,
  renderBlock,
  frameAnswer,
  titleAside,
  headerMarks,
  partResults = true,
  layout = 'boxes',
}: {
  /** Learner questions (no answer key) only render without `review`, which
   * shows a question graded on the server: its key and each part's `awarded`. */
  question: Question | LearnerQuestion;
  answers: Answers;
  onChange?: (partId: string, value: Answer) => void;
  review?: boolean;
  /** Read-only preview: the answer controls show but take no input. */
  disabled?: boolean;
  /** Editors: list the answer, marking scheme and worked solution under each part. */
  showAnswerKey?: boolean;
  questionNumber?: number;
  renderBlock?: QuestionViewProps['renderBlock'];
  /** The question dialog: wraps each part's answer controls to select them. */
  frameAnswer?: (partId: string, answer: ReactNode) => ReactNode;
  titleAside?: QuestionViewProps['titleAside'];
  headerMarks?: boolean;
  /** A checked choice part's "Wrong · 0 / 2 marks" line; a member's result
   * row shows its verdict beside the question instead (Epo 2026-11-18). */
  partResults?: boolean;
  /** A checked choice or ordering part as boxes, as the learner answered
   * it, or as plain lines with Your answer and Correct answer under them (a
   * member's result, Epo 2026-11-18). */
  layout?: AnswerLayout;
}) {
  // A gaps part's text carries its own fields, one per numbered blank.
  const gapBlock: QuestionViewProps['renderBlock'] = (
    block,
    index,
    section
  ) => {
    const part = question.parts.find(
      (item) => item.id === section.partId && item.answer.type === 'gaps'
    );
    if (part && block.type === 'text' && !section.solution) {
      const view = (
        <GapText
          block={block}
          disabled={disabled}
          onChange={(value) => onChange?.(part.id, value)}
          part={part}
          review={review}
          value={answers[part.id] ?? emptyAnswer(part)}
        />
      );
      // The question dialog frames it as it does every block.
      return renderBlock ? renderBlock(block, index, section, view) : view;
    }
    return renderBlock ? (
      renderBlock(block, index, section)
    ) : (
      <QuestionBlockView block={block} />
    );
  };
  const answer = (part: QuestionPart | LearnerPart) => {
    const runner = (
      <PartRunner
        disabled={disabled}
        key={part.id}
        layout={layout}
        onChange={(value) => onChange?.(part.id, value)}
        part={part}
        pinned={
          part.answer.type === 'drawing'
            ? pinnedQuestion(question, part, questionNumber)
            : undefined
        }
        results={partResults}
        review={review}
        twoColumns={optionColumns(question)}
        value={answers[part.id] ?? emptyAnswer(part as QuestionPart)}
      />
    );
    return (
      <div className="@container col-[2/-1] min-w-0">
        {frameAnswer ? frameAnswer(part.id, runner) : runner}
      </div>
    );
  };
  if (!review)
    return (
      <QuestionView
        headerMarks={headerMarks}
        question={question}
        questionNumber={questionNumber}
        renderAnswer={answer}
        renderBlock={gapBlock}
        review={showAnswerKey}
        titleAside={titleAside}
      />
    );
  return (
    <QuestionReview
      headerMarks={headerMarks}
      question={question as Question}
      questionNumber={questionNumber}
      renderAnswer={answer}
      renderBlock={gapBlock}
    />
  );
}

// Punctuation right after a blank stays on the blank's line.
const LEADING_PUNCTUATION = /^[.,;:!?)\]”’]+/;

/** A gaps part's text with a blank at each "(n) ______" that grows with what
 * is typed, up to the line: a hidden copy of the value (data-value) sizes it,
 * which every browser supports. On review each blank shows the learner's
 * answer right or wrong under its number; the correct answers list under the
 * part (PartRunner). A member's result draws it in its question's view. */
export function GapText({
  block,
  part,
  value,
  onChange,
  review,
  disabled,
}: {
  block: TextBlock;
  part: QuestionPart | LearnerPart;
  value: Answer;
  onChange?: (value: Answer) => void;
  review: boolean;
  disabled: boolean;
}) {
  const answer = part.answer;
  if (answer.type !== 'gaps') return null;
  const typed = gapValues(answer, value);
  // The server's verdict per gap.
  const results =
    review && isAuthoredPart(part) ? (part.itemResults ?? []) : undefined;
  // split() with a capture group alternates text and blank numbers.
  const pieces = block.text.split(new RegExp(GAP_MARKER.source));
  return (
    <div className="leading-[2.1]">
      {pieces.map((piece, i) => {
        if (i % 2 === 0) {
          const text = i > 0 ? piece.replace(LEADING_PUNCTUATION, '') : piece;
          return text && <TextView key={i} marks text={text} />;
        }
        const gap = Number(piece) - 1;
        const tail = pieces[i + 1]?.match(LEADING_PUNCTUATION)?.[0] ?? '';
        const right = results?.[gap];
        return (
          <span className="whitespace-nowrap" key={i}>
            <span
              className={cn(
                'mx-1 inline-grid min-w-[7ch] max-w-[calc(100%-2ch)] border-line-strong border-b align-baseline focus-within:-mb-px focus-within:border-solid-accent-1 focus-within:border-b-2',
                'after:invisible after:col-start-1 after:row-start-1 after:overflow-hidden after:whitespace-pre after:px-0.5 after:leading-none after:content-[attr(data-value)]',
                results &&
                  (right
                    ? 'border-solid-success border-b-2'
                    : 'border-solid-error border-b-2')
              )}
              data-value={typed[gap]}
            >
              <input
                aria-label={m.question_ui_gap({ number: gap + 1 })}
                className={cn(
                  'col-start-1 row-start-1 w-full min-w-0 bg-transparent px-0.5 text-center text-[length:inherit] text-fg outline-none placeholder:text-placeholder',
                  results &&
                    !right &&
                    'text-tint-error-fg line-through decoration-1'
                )}
                disabled={review || disabled}
                maxLength={SHORT_ANSWER_MAX}
                onChange={(event) =>
                  onChange?.(
                    typed.map((item, j) =>
                      j === gap ? event.target.value : item
                    )
                  )
                }
                placeholder={review ? undefined : String(gap + 1)}
                size={1}
                value={typed[gap] ?? ''}
              />
            </span>
            {review && (
              <sup className="text-[0.65rem] text-fg-muted">{gap + 1}</sup>
            )}
            {tail}
          </span>
        );
      })}
    </div>
  );
}

/** A gaps answer as one typed string per gap. */
function gapValues(
  answer: QuestionPart['answer'] | LearnerPart['answer'],
  value: Answer
) {
  if (answer.type !== 'gaps') return [];
  const count = 'gaps' in answer ? answer.gaps : answer.accepted.length;
  return Array.from({ length: count }, (_, i) => {
    const item = Array.isArray(value) ? value[i] : undefined;
    return typeof item === 'string' ? item : '';
  });
}

/** "Your answer" / "Correct answer" over a checked part's lists, as the
 * member result's sections head theirs. */
const SUBHEAD = 't-meta mb-1.5 text-fg-secondary';

type AnswerLayout = 'boxes' | 'list';

type PlainRow = {
  /** A letter or place; True and False have none. */
  label: string | null;
  text: string;
  /** The learner's own pick, marked right or wrong. */
  state?: 'right' | 'wrong';
};

/** Answers as plain lines, no boxes, one column even on paper questions:
 * the label muted, then the text; a learner's own pick carries its mark at
 * the end. */
function PlainList({ rows }: { rows: PlainRow[] }) {
  return (
    <ol className="grid gap-1.5">
      {rows.map((row, i) => (
        <li className="flex items-baseline gap-2.5" key={`${row.label}${i}`}>
          {row.label !== null && (
            <span className="w-4 shrink-0 font-semibold text-fg-muted">
              {row.label}
            </span>
          )}
          <TextView
            className={cn(
              'min-w-0',
              row.state === 'right' && 'text-tint-success-fg',
              row.state === 'wrong' && 'text-tint-error-fg'
            )}
            text={row.text}
          />
          {row.state && (
            <span
              className={cn(
                'ml-auto inline-flex shrink-0 items-center gap-1 self-center whitespace-nowrap pl-2 text-[12.5px]',
                row.state === 'right'
                  ? 'text-tint-success-fg'
                  : 'text-tint-error-fg'
              )}
            >
              <Icon name={row.state === 'right' ? 'check' : 'x'} size={16} />
              {row.state === 'right'
                ? m.question_ui_result_right()
                : m.question_ui_result_wrong()}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** A checked part's section: its heading, then its list. */
function AnswerSection({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title: string;
}) {
  return (
    <div className={className}>
      <h4 className={SUBHEAD}>{title}</h4>
      {children}
    </div>
  );
}

/** A choice as the editor's row (Epo 2026-11-19, A): its marker, then its
 * text. A pick fills purple while answering; once checked it reads right
 * (green) or wrong (red), and a correct choice left unpicked is ringed green,
 * each with its tag at the row's end. */
function ChoiceRow({
  correct,
  disabled,
  multiple,
  onClick,
  review,
  selected,
  text,
}: {
  correct: boolean;
  disabled: boolean;
  multiple: boolean;
  onClick?: () => void;
  review: boolean;
  selected: boolean;
  text: ReactNode;
}) {
  const state: RowState | undefined = review
    ? selected
      ? correct
        ? 'right'
        : 'wrong'
      : correct
        ? 'missed'
        : undefined
    : selected
      ? 'selected'
      : undefined;
  const locked = review || disabled;
  return (
    <button
      aria-pressed={selected}
      className="group flex min-h-11 w-full items-center gap-3 text-left outline-none disabled:cursor-default"
      disabled={locked}
      onClick={onClick}
      type="button"
    >
      {/* The editor's marker button: a hover circle centred on the marker. */}
      <span
        className={cn(
          'relative -top-px -m-2 grid shrink-0 place-items-center rounded-full p-2 group-focus-visible:ring-2 group-focus-visible:ring-action',
          !locked && 'group-hover:bg-surface-hover-bg'
        )}
      >
        <ChoiceMarker
          checked={selected}
          className="top-0"
          multiple={multiple}
          state={state}
        />
      </span>
      <span className="min-w-0 flex-1 px-0.5">{text}</span>
      {state === 'right' && <CorrectTag />}
      {state === 'wrong' && (
        <CorrectTag label={m.question_ui_result_wrong()} wrong />
      )}
      {state === 'missed' && (
        <CorrectTag label={m.question_ui_correct_answer()} />
      )}
    </button>
  );
}

/** A checked part's verdict under its answer (Epo 2026-11-18, L1): Correct,
 * Wrong or Not answered, beside its marks. Choices, True or False and
 * ordering score all or nothing. */
function PartResult({
  part,
  answered,
}: {
  part: QuestionPart;
  answered: boolean;
}) {
  const { awarded, marks } = part;
  if (awarded == null) return null;
  const right = answered && awarded >= marks;
  return (
    <p className="mt-3 flex items-center gap-2.5">
      <span
        className={cn(
          'inline-flex h-5.5 items-center rounded-md px-1.75 font-semibold text-xs',
          right
            ? 'bg-tint-success text-tint-success-fg'
            : 'bg-tint-error text-tint-error-fg'
        )}
      >
        {right
          ? m.question_ui_result_right()
          : answered
            ? m.question_ui_result_wrong()
            : m.assignment_not_answered()}
      </span>
      <span className="text-fg-secondary">
        <b className="font-bold text-fg text-lg">{formatPoints(awarded)}</b>
        {` / ${formatPoints(marks)}`}
      </span>
    </p>
  );
}

/** The answer key under a checked gaps part, apart from the learner's own
 * answer so it reads plainly: the title in green, each entry with a note
 * where the learner differed. */
function KeyList({
  title,
  rows,
}: {
  title: string;
  rows: { key: number; text: string; note?: string }[];
}) {
  return (
    <div className="mt-3.5">
      <h4 className={SUBHEAD}>{title}</h4>
      <ol className="grid">
        {rows.map((row) => (
          // A long note (what the learner wrote) wraps under the answer on
          // narrow areas and beside it, capped, on wide ones.
          <li
            className="grid min-h-7.5 @md:grid-cols-[auto_minmax(0,1fr)_minmax(0,40%)] grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 py-1"
            key={row.key}
          >
            <OptionKey className="h-auto">{row.key}</OptionKey>
            <TextView className="wrap-anywhere min-w-0" text={row.text} />
            {row.note && (
              <span className="wrap-anywhere @md:col-start-3 col-start-2 min-w-0 @md:text-right text-fg-muted text-xs">
                {row.note}
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** A checked open answer's verdict, counted over its marking points (the
 * scheme's items) so a glance tells right from wrong. */
function OpenVerdict({
  answered,
  part,
}: {
  answered: boolean;
  part: QuestionPart;
}) {
  const {
    aiComment,
    aiFlag,
    awarded,
    itemAwards = [],
    markscheme = [],
    marks,
  } = part;
  if (awarded == null) return null;
  // No credits, the model failed or a shared page, which marks no open answer:
  // not wrong, just not marked (Epo 2026-11-03, 2026-11-05).
  if (part.pending)
    return (
      <p className="mb-2 font-bold text-fg-muted text-sm">
        {m.assignment_not_marked()}
      </p>
    );
  const count = markscheme.length;
  const got = markscheme.filter(
    (item, i) => itemAwards[i] === item.marks
  ).length;
  const one = count === 1;
  const [tone, label, detail] = answered
    ? awarded >= marks
      ? [
          'text-tint-success-fg',
          m.question_ui_verdict_correct(),
          one
            ? m.question_ui_point_right()
            : m.question_ui_points_all({ count }),
        ]
      : awarded > 0
        ? [
            'text-tint-warning-fg',
            m.question_ui_verdict_partial(),
            one
              ? m.question_ui_point_partly()
              : m.question_ui_points_some({ count, got }),
          ]
        : [
            'text-tint-error-fg',
            m.question_ui_verdict_incorrect(),
            one
              ? m.question_ui_point_wrong()
              : m.question_ui_points_none({ count }),
          ]
    : [
        'text-fg-muted',
        m.question_ui_verdict_skipped(),
        m.question_ui_question_not_answered(),
      ];
  return (
    <>
      <p className="mb-2 text-fg-secondary text-sm">
        <strong className={cn('mr-1.5 font-bold', tone)}>{label}</strong>
        {detail}
      </p>
      {aiComment && (
        <AiWarning className="mb-2" flag={aiFlag} message={aiComment} />
      )}
    </>
  );
}

function PartRunner({
  part,
  pinned,
  value,
  onChange,
  review,
  results,
  layout,
  disabled,
  twoColumns,
}: {
  part: QuestionPart | LearnerPart;
  /** A drawing part's question, pinned over its board. */
  pinned?: PinnedQuestion;
  value: Answer;
  onChange: (value: Answer) => void;
  review: boolean;
  results: boolean;
  layout: AnswerLayout;
  disabled: boolean;
  twoColumns: boolean;
}) {
  const answer = part.answer;
  // Learner questions carry no key; only a graded review reads it.
  const key = isAuthoredPart(part) ? part.answer : undefined;
  // Learners read matching options and ordering items shuffled by the server,
  // so those answers are texts: the chosen option per item, and the items in
  // the learner's order. The shown order is the answer, committed as soon as
  // a learner sees it; a review shows them against the stored key.
  const items = answer.type === 'ordering' ? answer.items : null;
  const taking = !(review || disabled);
  useEffect(() => {
    if (taking && items && value === null) onChange([...items]);
  }, [taking, items, value, onChange]);
  const [unitError, setUnitError] = useState(false);
  // Choice answers are option indices; gaps and ordering are strings.
  const indices = Array.isArray(value)
    ? value.filter((item) => typeof item === 'number')
    : null;
  const result = (answered: boolean) =>
    review && results && isAuthoredPart(part) ? (
      <PartResult answered={answered} part={part} />
    ) : null;
  // Checked and short of full marks: the correct answer lists apart.
  const missed =
    review && isAuthoredPart(part) && (part.awarded ?? 0) < part.marks;
  const asList = review && layout === 'list';
  // One correct option is a single choice: picking one replaces the other.
  // Several toggle like checkboxes, under a hint saying so.
  if (answer.type === 'mcq') {
    const multiple = multipleAnswers(answer);
    const correct = (i: number) =>
      key?.type === 'mcq' && key.correct.includes(i);
    const chosen = indices ?? [];
    const options = shownOptions(answer).map(({ index, text }, shown) => ({
      index,
      label: optionLetter(shown),
      text,
    }));
    const correctList = (
      <PlainList rows={options.filter((option) => correct(option.index))} />
    );
    // A member's result (A): every option as a line, then what they picked
    // and what was correct, each in its own section.
    if (asList)
      return (
        <div className="grid gap-4">
          <PlainList rows={options} />
          {result(chosen.length > 0)}
          <AnswerSection title={m.question_ui_your_answer()}>
            {chosen.length > 0 ? (
              <PlainList
                rows={options
                  .filter((option) => chosen.includes(option.index))
                  .map((option) => ({
                    ...option,
                    state: correct(option.index) ? 'right' : 'wrong',
                  }))}
              />
            ) : (
              <p className="text-fg-muted">{m.assignment_not_answered()}</p>
            )}
          </AnswerSection>
          <AnswerSection title={m.question_ui_correct_answer()}>
            {correctList}
          </AnswerSection>
        </div>
      );
    return (
      <div>
        {multiple && !review && (
          <p className="mb-2 text-fg-muted text-sm">
            {m.question_ui_multiple_answers()}
          </p>
        )}
        <div className={choiceRowsClass(twoColumns)}>
          {/* Shown in the learner's order; a pick stores its authored index. */}
          {options.map(({ index: i, text: option }) => {
            const selected = chosen.includes(i);
            return (
              <ChoiceRow
                correct={correct(i)}
                disabled={disabled}
                key={i}
                multiple={multiple}
                onClick={() =>
                  onChange(
                    multiple
                      ? selected
                        ? chosen.filter((n) => n !== i)
                        : [...chosen, i]
                      : [i]
                  )
                }
                review={review}
                selected={selected}
                text={<TextView text={option} />}
              />
            );
          })}
        </div>
        {result(chosen.length > 0)}
      </div>
    );
  }
  // True and False stack like other choices, text at the left (B2).
  if (answer.type === 'boolean') {
    const text = (option: boolean) =>
      option ? m.question_ui_true() : m.question_ui_false();
    const keyed = key?.type === 'boolean' ? key.correct : undefined;
    const correctList = keyed !== undefined && (
      <PlainList rows={[{ label: null, text: text(keyed) }]} />
    );
    if (asList)
      return (
        <div className="grid gap-4">
          {result(typeof value === 'boolean')}
          <AnswerSection title={m.question_ui_your_answer()}>
            {typeof value === 'boolean' ? (
              <PlainList
                rows={[
                  {
                    label: null,
                    state: value === keyed ? 'right' : 'wrong',
                    text: text(value),
                  },
                ]}
              />
            ) : (
              <p className="text-fg-muted">{m.assignment_not_answered()}</p>
            )}
          </AnswerSection>
          <AnswerSection title={m.question_ui_correct_answer()}>
            {correctList}
          </AnswerSection>
        </div>
      );
    return (
      <div>
        <div className={choiceRowsClass()}>
          {[true, false].map((option) => (
            <ChoiceRow
              correct={keyed === option}
              disabled={disabled}
              key={String(option)}
              multiple={false}
              onClick={() => onChange(option)}
              review={review}
              selected={value === option}
              text={text(option)}
            />
          ))}
        </div>
        {result(typeof value === 'boolean')}
      </div>
    );
  }
  // Gap fields sit inside the part's text (GapText); a review lists the key
  // under it, as a short answer's Correct answer shows (Epo 2026-11-18), with
  // Not answered beside a blank left empty. What was written shows in the
  // text above, so it isn't repeated here (Epo 2026-11-19).
  if (answer.type === 'gaps') {
    if (!review || !('accepted' in answer)) return null;
    const typed = gapValues(answer, value);
    const results = isAuthoredPart(part) ? (part.itemResults ?? []) : [];
    return (
      <KeyList
        rows={answer.accepted.map((accepted, i) => ({
          key: i + 1,
          note:
            results[i] || typed[i]?.trim()
              ? undefined
              : m.question_ui_not_answered(),
          text: accepted.join(' / '),
        }))}
        title={m.question_ui_correct_answers()}
      />
    );
  }
  if (answer.type === 'short') {
    const right = 'awarded' in part && part.awarded === part.marks;
    // A member's result: what they wrote, then the correct answer, each in
    // its own section as a choice's are (Epo 2026-11-19).
    if (asList) {
      const typed = typeof value === 'string' ? value.trim() : '';
      return (
        <div className="grid gap-4">
          {result(typed !== '')}
          <AnswerSection title={m.question_ui_your_answer()}>
            {typed ? (
              <PlainList
                rows={[
                  {
                    label: null,
                    state: right ? 'right' : 'wrong',
                    text: answer.unit ? `${typed} ${answer.unit}` : typed,
                  },
                ]}
              />
            ) : (
              <p className="text-fg-muted">{m.assignment_not_answered()}</p>
            )}
          </AnswerSection>
          {isAuthoredPart(part) && (
            <AnswerSection title={m.question_ui_correct_answer()}>
              <AnswerView part={part} />
            </AnswerSection>
          )}
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <div className="relative min-w-0 flex-1">
            <Input
              aria-label={m.question_ui_your_answer()}
              className="disabled:bg-transparent disabled:text-fg"
              disabled={review || disabled}
              maxLength={SHORT_ANSWER_MAX}
              onBlur={() =>
                setUnitError(
                  Boolean(
                    answer.unit &&
                      typeof value === 'string' &&
                      value.trim() &&
                      quantityValue(value) === undefined
                  )
                )
              }
              onChange={(event) => {
                const next = event.target.value;
                if (answer.unit && NON_QUANTITY_CHAR.test(next)) {
                  setUnitError(true);
                  return;
                }
                setUnitError(false);
                onChange(next);
              }}
              placeholder={m.question_ui_type_answer()}
              value={typeof value === 'string' ? value : ''}
              variant="underline"
              wrapperClassName={cn(
                'w-full border-line-strong px-0.5 focus-within:border-b-2 has-disabled:bg-transparent',
                unitError && 'border-solid-error border-b-2',
                review &&
                  (right
                    ? 'border-solid-success border-b-2 pr-9'
                    : 'border-solid-error border-b-2 pr-9')
              )}
            />
            {review && (
              <span
                className={cn(
                  'absolute top-1/2 right-1 grid size-5 -translate-y-1/2 place-items-center rounded-md text-surface',
                  right ? 'bg-tint-success-fg' : 'bg-tint-error-fg'
                )}
              >
                <Icon
                  name={right ? 'check' : 'x'}
                  size={12}
                  strokeWidth={2.25}
                />
              </span>
            )}
          </div>
          {answer.unit && (
            <span className="shrink-0 text-fg-secondary">{answer.unit}</span>
          )}
        </div>
        {unitError && (
          <InputError>
            {m.question_ui_value_only({ unit: answer.unit })}
          </InputError>
        )}
        {result(typeof value === 'string' && value.trim() !== '')}
        {review && isAuthoredPart(part) && (
          <AnswerSection
            className="mt-2.5"
            title={m.question_ui_correct_answer()}
          >
            <AnswerView part={part} />
          </AnswerSection>
        )}
      </div>
    );
  }
  if (answer.type === 'drawing' && pinned)
    return (
      <DrawingAnswer
        disabled={disabled}
        onChange={onChange}
        partId={part.id}
        pinned={pinned}
        review={review}
        value={value}
        verdict={
          review && isAuthoredPart(part) ? (
            <OpenVerdict answered={isDrawingValue(value)} part={part} />
          ) : undefined
        }
      />
    );
  // A written answer sits on ruled lines, like exam paper.
  if (answer.type === 'open') {
    const text = typeof value === 'string' ? value : '';
    return (
      <div className="flex flex-col gap-1">
        {review && isAuthoredPart(part) && (
          <OpenVerdict answered={text.trim() !== ''} part={part} />
        )}
        {review || disabled ? (
          <OpenAnswerView text={text} />
        ) : (
          <OpenAnswerField onChange={onChange} value={text} />
        )}
      </div>
    );
  }
  // One pick per row on a grid (Epo 2026-11-15); the stored answer is still
  // each row's chosen option text. A check marks every row's pick right or
  // wrong and lists the correct answer under the grid, as choices do (Epo
  // 2026-11-18): always in a member's result, short of full marks otherwise.
  if (answer.type === 'matching') {
    const choices =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
    const rows =
      'left' in answer ? answer.left : answer.pairs.map((pair) => pair.left);
    const picks = rows.map((_, i) => {
      const chosen = choices[String(i)];
      const index = chosen === undefined ? -1 : answer.options.indexOf(chosen);
      return index < 0 ? undefined : index;
    });
    const keyed = review && key?.type === 'matching' ? key : undefined;
    return (
      <div>
        <MatchingGrid
          columns={answer.options}
          correct={keyed?.pairs.map((pair) => pair.right)}
          label={m.question_ui_your_answer()}
          onPick={
            taking
              ? (row, column) =>
                  onChange({
                    ...choices,
                    [String(row)]: answer.options[column],
                  })
              : undefined
          }
          rows={rows}
          value={picks}
        />
        {keyed && (asList || missed) && (
          <AnswerSection
            className="mt-3.5"
            title={m.question_ui_correct_answer()}
          >
            <PlainList
              rows={keyed.pairs.map((pair) => ({
                label: null,
                text: `${pair.left}: ${answer.options[pair.right] ?? ''}`,
              }))}
            />
          </AnswerSection>
        )}
      </div>
    );
  }
  if (answer.type === 'ordering') {
    const ordered = Array.isArray(value)
      ? value.filter((item) => typeof item === 'string')
      : null;
    const current = ordered?.length ? ordered : answer.items;
    // On review the items are the key's stored order.
    const right = (item: string, i: number) => answer.items[i] === item;
    // Rows keep their identity while moving, so focus stays on the button;
    // a repeated text is told apart by its occurrence.
    const seen = new Map<string, number>();
    const keys = current.map((item) => {
      const count = seen.get(item) ?? 0;
      seen.set(item, count + 1);
      return `${count}:${item}`;
    });
    function move(index: number, direction: number) {
      const next = [...current];
      [next[index], next[index + direction]] = [
        next[index + direction],
        next[index],
      ];
      onChange(next);
    }
    // Checked (O4): "Your order" tags each item Correct in its right place
    // and Wrong elsewhere; when any is misplaced, "Correct order" lists the
    // key plainly, each item saying where the learner put it. A skipped part
    // shows the key's order unmarked.
    const state = (item: string, i: number): RowState | undefined =>
      review && ordered?.length
        ? right(item, i)
          ? 'right'
          : 'wrong'
        : undefined;
    const misplaced = review && current.some((item, i) => !right(item, i));
    const keyOrder = (
      <PlainList
        rows={answer.items.map((item, i) => ({
          label: String(i + 1),
          text: item,
        }))}
      />
    );
    if (asList)
      return (
        <div className="grid gap-4">
          {result(Boolean(ordered?.length))}
          <AnswerSection title={m.question_ui_your_order()}>
            {ordered?.length ? (
              <PlainList
                rows={current.map((item, i) => ({
                  label: String(i + 1),
                  state: right(item, i) ? 'right' : 'wrong',
                  text: item,
                }))}
              />
            ) : (
              <p className="text-fg-muted">{m.assignment_not_answered()}</p>
            )}
          </AnswerSection>
          <AnswerSection title={m.question_ui_correct_order()}>
            {keyOrder}
          </AnswerSection>
        </div>
      );
    return (
      <div>
        {misplaced && <h4 className={SUBHEAD}>{m.question_ui_your_order()}</h4>}
        <div>
          {current.map((item, i) => {
            const at = state(item, i);
            return (
              // The editor's ordering row (Epo 2026-11-19): its number, the
              // text, then Move up and Move down, or once checked its tag.
              <div className="flex min-h-11 items-center gap-3" key={keys[i]}>
                <span
                  className={cn(
                    'w-4.5 shrink-0',
                    at === 'right' && 'text-tint-success-fg',
                    at === 'wrong' && 'text-tint-error-fg'
                  )}
                >
                  {i + 1}.
                </span>
                <TextView className="min-w-0 flex-1 px-0.5" text={item} />
                {at === 'right' && <CorrectTag />}
                {at === 'wrong' && (
                  <CorrectTag label={m.question_ui_result_wrong()} wrong />
                )}
                {!review && (
                  <span className="flex shrink-0 items-center">
                    <IconButton
                      disabled={disabled || i === 0}
                      icon="chevronUp"
                      label={m.question_ui_move_up()}
                      onClick={() => move(i, -1)}
                      size="sm"
                      variant="ghost-hover"
                    />
                    <IconButton
                      disabled={disabled || i === current.length - 1}
                      icon="chevronDown"
                      label={m.question_ui_move_down()}
                      onClick={() => move(i, 1)}
                      size="sm"
                      variant="ghost-hover"
                    />
                  </span>
                )}
              </div>
            );
          })}
        </div>
        {result(Boolean(ordered?.length))}
        {misplaced && (
          <AnswerSection
            className="mt-3.5"
            title={m.question_ui_correct_order()}
          >
            {keyOrder}
          </AnswerSection>
        )}
      </div>
    );
  }
  return null;
}
