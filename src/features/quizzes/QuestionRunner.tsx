import { type ReactNode, useEffect, useState } from 'react';
import { QUIZ_OPEN_ANSWER_MAX } from '@/api/limits.generated';
import type { Question, QuestionPart } from '@/api/types';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { CharCount, Input, InputError } from '@/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { Textarea } from '@/components/ui/TextArea';
import {
  AnswerView,
  answerRowClass,
  MatchingLayout,
  OptionKey,
  optionColumns,
  optionKeyClass,
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
  type TextBlock,
} from '@/features/questions/types';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { textLength } from '@/lib/textLength';
import { type Answer, type Answers, emptyAnswer, quantityValue } from './grade';

// Silent cap on gap and short answers; they are graded without the model.
const SHORT_ANSWER_MAX = 1000;

const NON_QUANTITY_CHAR = /[^\d\s+\-./eE]/;

/** Whether a learner has given an answer for a part (ordering always has one). */
export function isAnswered(value: Answer | undefined): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  // Gaps start as empty strings, one per gap.
  if (Array.isArray(value))
    return value.some((item) => typeof item === 'number' || item.trim() !== '');
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * One question in the shared quiz look, used for taking, reviewing and every
 * read-only view (quiz preview, quiz editor, question bank, question dialog).
 */
export function QuestionRunner({
  actions,
  question,
  answers,
  onChange,
  review = false,
  disabled = false,
  showAnswerKey = false,
  questionNumber,
  renderBlock,
}: {
  /** Controls at the question's top right (QuestionView `actions`). */
  actions?: ReactNode;
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
    if (part && block.type === 'text' && !section.solution)
      return (
        <GapText
          block={block}
          disabled={disabled}
          onChange={(value) => onChange?.(part.id, value)}
          part={part}
          review={review}
          value={answers[part.id] ?? emptyAnswer(part)}
        />
      );
    return renderBlock ? (
      renderBlock(block, index, section)
    ) : (
      <QuestionBlockView block={block} />
    );
  };
  const answer = (part: QuestionPart | LearnerPart) => (
    <div className="@container col-[2/-1] min-w-0">
      <PartRunner
        disabled={disabled}
        key={part.id}
        onChange={(value) => onChange?.(part.id, value)}
        part={part}
        review={review}
        twoColumns={optionColumns(question)}
        value={answers[part.id] ?? emptyAnswer(part as QuestionPart)}
      />
    </div>
  );
  if (!review)
    return (
      <QuestionView
        actions={actions}
        question={question}
        questionNumber={questionNumber}
        renderAnswer={answer}
        renderBlock={gapBlock}
        review={showAnswerKey}
      />
    );
  return (
    <QuestionReview
      actions={actions}
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
 * part (PartRunner). */
function GapText({
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
  onChange: (value: Answer) => void;
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
      {block.label && <strong className="mr-3">{block.label}</strong>}
      {pieces.map((piece, i) => {
        if (i % 2 === 0) {
          const text = i > 0 ? piece.replace(LEADING_PUNCTUATION, '') : piece;
          return text && <TextView key={i} text={text} />;
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
                  onChange(
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

/** A choice as an underlined row: chosen while answering; after checking,
 * right or wrong with a tag, and a correct answer that was not chosen marked
 * on a dashed rule. */
function ChoiceRow({
  label,
  text,
  selected,
  correct,
  review,
  disabled,
  onClick,
}: {
  label: ReactNode;
  text: ReactNode;
  selected: boolean;
  correct: boolean;
  review: boolean;
  disabled: boolean;
  onClick?: () => void;
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
  const marked = state === 'right' || state === 'wrong';
  return (
    <button
      aria-pressed={selected}
      className={cn(
        answerRowClass(state),
        'w-full text-left disabled:cursor-default',
        !(review || disabled || selected) && 'hover:border-line-strong',
        review && !state && 'text-fg-muted'
      )}
      disabled={review || disabled}
      onClick={onClick}
      type="button"
    >
      {(label !== null || review) && (
        <OptionKey className={optionKeyClass(state)}>
          {marked ? (
            <Icon
              name={state === 'right' ? 'check' : 'x'}
              size={13}
              strokeWidth={2.25}
            />
          ) : state === 'missed' && label === null ? (
            <Icon name="check" size={13} strokeWidth={2.25} />
          ) : (
            label
          )}
        </OptionKey>
      )}
      <span className="min-w-0 flex-1">{text}</span>
      {review && (selected || correct) && (
        <span
          className={cn(
            'shrink-0 whitespace-nowrap font-bold text-xs',
            correct ? 'text-tint-success-fg' : 'text-tint-error-fg'
          )}
        >
          {selected
            ? m.question_ui_your_answer()
            : m.question_ui_correct_answer()}
        </span>
      )}
    </button>
  );
}

/** The answer key under a checked gaps or ordering part, apart from the
 * learner's own answer so it reads plainly: the title in green, each entry
 * with a note where the learner differed. */
function KeyList({
  title,
  rows,
}: {
  title: string;
  rows: { key: number; text: string; note?: string }[];
}) {
  return (
    <div className="mt-3.5 border-divider border-t pt-2.5">
      <h4 className="mb-1 font-bold text-tint-success-fg text-xs">{title}</h4>
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
  const { awarded, itemAwards = [], markscheme = [], marks } = part;
  if (awarded == null) return null;
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
    <p className="mb-2 text-fg-secondary text-sm">
      <strong className={cn('mr-1.5 font-bold', tone)}>{label}</strong>
      {detail}
    </p>
  );
}

function PartRunner({
  part,
  value,
  onChange,
  review,
  disabled,
  twoColumns,
}: {
  part: QuestionPart | LearnerPart;
  value: Answer;
  onChange: (value: Answer) => void;
  review: boolean;
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
  if (answer.type === 'mcq' || answer.type === 'multi')
    return (
      <div className={cn('grid', twoColumns && '@xl:grid-cols-2 @xl:gap-x-7')}>
        {answer.options.map((option, i) => {
          const selected = indices?.includes(i) ?? false;
          return (
            <ChoiceRow
              correct={key?.type === answer.type && key.correct.includes(i)}
              disabled={disabled}
              key={i}
              label={optionLetter(i)}
              onClick={() =>
                onChange(
                  answer.type === 'mcq'
                    ? [i]
                    : selected
                      ? (indices ?? []).filter((n) => n !== i)
                      : [...(indices ?? []), i]
                )
              }
              review={review}
              selected={selected}
              text={<TextView text={option} />}
            />
          );
        })}
      </div>
    );
  // True and False sit side by side, stacked on phones like other choices.
  if (answer.type === 'boolean')
    return review ? (
      <div className="grid @md:grid-cols-2 @md:gap-x-7">
        {[true, false].map((option) => (
          <ChoiceRow
            correct={key?.type === 'boolean' && key.correct === option}
            disabled
            key={String(option)}
            label={null}
            review
            selected={value === option}
            text={option ? m.question_ui_true() : m.question_ui_false()}
          />
        ))}
      </div>
    ) : (
      <div className="grid @md:grid-cols-2 @md:gap-x-7">
        {[true, false].map((option) => (
          <button
            aria-pressed={value === option}
            className={cn(
              answerRowClass(value === option ? 'selected' : undefined),
              '@md:justify-center font-semibold disabled:cursor-default',
              value !== option && !disabled && 'hover:border-line-strong'
            )}
            disabled={disabled}
            key={String(option)}
            onClick={() => onChange(option)}
            type="button"
          >
            {option ? m.question_ui_true() : m.question_ui_false()}
          </button>
        ))}
      </div>
    );
  // Gap fields sit inside the part's text (GapText); a review with a miss
  // lists the key.
  if (answer.type === 'gaps') {
    if (!review || !('accepted' in answer)) return null;
    const typed = gapValues(answer, value);
    const results = isAuthoredPart(part) ? (part.itemResults ?? []) : [];
    if (answer.accepted.every((_, i) => results[i])) return null;
    return (
      <KeyList
        rows={answer.accepted.map((accepted, i) => ({
          key: i + 1,
          note: results[i]
            ? undefined
            : typed[i]?.trim()
              ? m.question_ui_you_wrote({ answer: typed[i] })
              : m.question_ui_not_answered(),
          text: accepted.join(' / '),
        }))}
        title={m.question_ui_correct_answers()}
      />
    );
  }
  if (answer.type === 'short') {
    const right = 'awarded' in part && part.awarded === part.marks;
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
        {review && isAuthoredPart(part) && (
          <p className="mt-2 text-sm">
            <span className="mr-1.5 font-bold text-tint-success-fg text-xs">
              {m.question_ui_accepted_answers()}
            </span>
            <AnswerView part={part} />
          </p>
        )}
      </div>
    );
  }
  // A written answer sits on ruled lines, like exam paper.
  if (answer.type === 'open') {
    const text = typeof value === 'string' ? value : '';
    return (
      <div className="flex flex-col gap-1">
        {review && isAuthoredPart(part) && (
          <OpenVerdict answered={text.trim() !== ''} part={part} />
        )}
        <Textarea
          aria-label={m.question_ui_your_answer()}
          className="ruled-lines max-h-[calc(var(--ruled-line)*8)] min-h-[calc(var(--ruled-line)*3)] rounded-none border-0 bg-transparent px-0.5 py-0 focus:border-0 disabled:bg-transparent disabled:text-fg"
          disabled={review || disabled}
          maxLength={QUIZ_OPEN_ANSWER_MAX}
          onChange={(event) => onChange(event.target.value)}
          placeholder={m.question_ui_type_answer()}
          value={text}
        />
        {!review && (
          <CharCount
            className="self-end"
            max={QUIZ_OPEN_ANSWER_MAX}
            value={textLength(text)}
          />
        )}
      </div>
    );
  }
  if (answer.type === 'matching') {
    const choices =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
    const choose = (i: number, index: number) =>
      onChange({ ...choices, [String(i)]: answer.options[index] });
    const rows = (
      <ol className="grid content-start">
        {('left' in answer
          ? answer.left
          : answer.pairs.map((pair) => pair.left)
        ).map((left, i) => {
          const chosen = choices[String(i)];
          const letter =
            chosen === undefined ? -1 : answer.options.indexOf(chosen);
          const right =
            key?.type === 'matching' ? key.pairs[i]?.right : undefined;
          // The server's verdict per pair.
          const correct =
            isAuthoredPart(part) && part.itemResults?.[i] === true;
          return (
            <li
              className="grid @md:min-h-11 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 @md:py-0 py-1.5"
              key={i}
            >
              <OptionKey>{i + 1}</OptionKey>
              <TextView className="min-w-0 text-fg" text={left} />
              {/* Wider screens: an underlined letter that opens the options. */}
              {review ? (
                <span className="@md:flex hidden items-center gap-3">
                  {!correct && right !== undefined && (
                    <span className="whitespace-nowrap font-bold text-tint-success-fg text-xs">
                      {m.question_ui_correct_letter({
                        letter: optionLetter(right),
                      })}
                    </span>
                  )}
                  <span
                    className={cn(
                      'w-16 border-b-2 px-1.5 py-1.5 font-bold',
                      correct
                        ? 'border-solid-success text-tint-success-fg'
                        : 'border-solid-error text-tint-error-fg'
                    )}
                  >
                    {letter < 0 ? '–' : optionLetter(letter)}
                  </span>
                </span>
              ) : (
                <div className="@md:block hidden w-16">
                  <Select
                    disabled={disabled}
                    onValueChange={(next) => choose(i, Number(next))}
                    value={letter < 0 ? '' : String(letter)}
                  >
                    <SelectTrigger
                      aria-label={left}
                      className={cn(
                        'h-auto border-line-strong bg-transparent px-1.5 py-1.5 font-bold data-[state=open]:border-solid-accent-1 data-[state=open]:border-b-2',
                        letter >= 0 && 'text-tint-accent-1-fg'
                      )}
                      variant="underline"
                    >
                      <SelectValue placeholder="–" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {answer.options.map((option, index) => (
                          <SelectItem
                            hint={
                              <TextView className="text-fg" text={option} />
                            }
                            key={index}
                            size="sm"
                            value={String(index)}
                          >
                            {optionLetter(index)}.
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              )}
              {/* Phones: the letters themselves under the item, with the
                  options listed above; no menu to open. */}
              <div
                aria-label={left}
                className="col-span-3 flex @md:hidden flex-wrap gap-1.5 pl-8.5"
                role="group"
              >
                {answer.options.map((_, index) => {
                  const here = index === letter;
                  const state: RowState | undefined = review
                    ? here
                      ? correct
                        ? 'right'
                        : 'wrong'
                      : !correct && index === right
                        ? 'missed'
                        : undefined
                    : here
                      ? 'selected'
                      : undefined;
                  return (
                    <button
                      aria-pressed={here}
                      className={cn(
                        'grid size-10 place-items-center border-b font-bold disabled:cursor-default',
                        state
                          ? 'border-b-2'
                          : 'border-line-strong text-fg-muted',
                        state === 'selected' &&
                          'border-solid-accent-1 text-tint-accent-1-fg',
                        state === 'right' &&
                          'border-solid-success text-tint-success-fg',
                        state === 'wrong' &&
                          'border-solid-error text-tint-error-fg',
                        state === 'missed' &&
                          'border-solid-success border-dashed text-tint-success-fg',
                        review && !state && 'opacity-45',
                        !(review || disabled || state) && 'hover:text-fg'
                      )}
                      disabled={review || disabled}
                      key={index}
                      onClick={() => choose(i, index)}
                      type="button"
                    >
                      {optionLetter(index)}
                    </button>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ol>
    );
    // The option list stays after checking so result letters keep their text.
    return <MatchingLayout items={rows} options={answer.options} />;
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
    return (
      <div className="grid">
        {current.map((item, i) => (
          <div
            className={cn(
              answerRowClass(
                review ? (right(item, i) ? 'right' : 'wrong') : undefined
              ),
              !review && 'py-1 pr-0'
            )}
            key={keys[i]}
          >
            <OptionKey
              className={cn(
                review &&
                  (right(item, i)
                    ? 'text-tint-success-fg'
                    : 'text-tint-error-fg')
              )}
            >
              {i + 1}
            </OptionKey>
            <TextView className="min-w-0 flex-1 text-fg" text={item} />
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
        ))}
        {review && current.some((item, i) => !right(item, i)) && (
          <KeyList
            rows={answer.items.map((item, i) => {
              const at = current.indexOf(item);
              return {
                key: i + 1,
                note:
                  at === i
                    ? undefined
                    : m.question_ui_you_put({ position: at + 1 }),
                text: item,
              };
            })}
            title={m.question_ui_correct_order()}
          />
        )}
      </div>
    );
  }
  return null;
}
