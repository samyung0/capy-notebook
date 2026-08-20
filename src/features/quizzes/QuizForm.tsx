import {
  type CognitiveLevel,
  QUESTION_TYPES,
  type Question,
  type QuestionType,
} from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { LEVELS, levelLabel } from '@/lib/levels';

function quizTypeLabel(type: QuestionType): string {
  switch (type) {
    case 'boolean':
      return m.quiz_type_boolean();
    case 'matching':
      return m.quiz_type_matching();
    case 'mcq':
      return m.quiz_type_mcq();
    case 'multi':
      return m.quiz_type_multi();
    case 'ordering':
      return m.quiz_type_ordering();
    case 'short':
      return m.quiz_type_short();
    case 'open':
      return m.quiz_type_open();
  }
}

const newId = () => `q_${Math.random().toString(36).slice(2, 9)}`;

/** Build a blank question of the given type, preserving any shared fields. */
export function createBlankQuestion(
  type: QuestionType = 'mcq',
  base?: {
    id?: string;
    level?: CognitiveLevel;
    prompt?: string;
    explanation?: string;
  }
): Question {
  const shared = {
    id: base?.id ?? newId(),
    level: base?.level ?? ('recall' as const),
    prompt: base?.prompt ?? '',
    ...(base?.explanation ? { explanation: base.explanation } : {}),
  };
  switch (type) {
    case 'mcq':
      return {
        ...shared,
        correct: [],
        options: [{ value: '' }, { value: '' }],
        type: 'mcq',
      };
    case 'multi':
      return {
        ...shared,
        correct: [],
        options: [{ value: '' }, { value: '' }],
        type: 'multi',
      };
    case 'boolean':
      return { ...shared, correct: true, type: 'boolean' };
    case 'short':
      return { ...shared, accepted: [{ value: '' }], type: 'short' };
    case 'ordering':
      return {
        ...shared,
        items: [{ value: '' }, { value: '' }],
        type: 'ordering',
      };
    case 'matching':
      return {
        ...shared,
        pairs: [
          { left: '', right: '' },
          { left: '', right: '' },
        ],
        type: 'matching',
      };
    case 'open':
      return {
        ...shared,
        accepted: [{ value: '' }],
        hints: [],
        rubrics: [{ value: '' }],
        type: 'open',
      };
  }
}

export function isCompleteQuestion(question: Question): boolean {
  if (!question.prompt.trim()) return false;
  switch (question.type) {
    case 'mcq':
    case 'multi':
      return (
        question.options.length >= 2 &&
        question.options.every((option) => option.value.trim()) &&
        question.correct.length >= 1 &&
        (question.type === 'multi' || question.correct.length === 1) &&
        question.correct.every(
          (index) => index >= 0 && index < question.options.length
        )
      );
    case 'boolean':
      return true;
    case 'short':
      return (
        question.accepted.length > 0 &&
        question.accepted.every((answer) => answer.value.trim())
      );
    case 'ordering':
      return (
        question.items.length >= 2 &&
        question.items.every((item) => item.value.trim())
      );
    case 'matching':
      return (
        question.pairs.length >= 2 &&
        question.pairs.every((pair) => pair.left.trim() && pair.right.trim())
      );
    case 'open':
      return (
        question.accepted.some((answer) => answer.value.trim()) &&
        question.rubrics.some((rubric) => rubric.value.trim())
      );
  }
}

const selectClass =
  'rounded-button border border-line bg-surface px-2 py-1.5 text-xs text-fg outline-none focus:border-line-strong';

/**
 * Controlled quiz editor: name field + a list of type-specific question
 * editors. The parent owns the `name`/`questions` state so it can drive save
 * and navigation. Extracted from the old QuizEditModal so it can back a full
 * page.
 */
export function QuizForm({
  name,
  questions,
  onNameChange,
  onQuestionsChange,
  showName = true,
}: {
  name: string;
  questions: Question[];
  onNameChange: (name: string) => void;
  onQuestionsChange: (questions: Question[]) => void;
  showName?: boolean;
}) {
  function update(i: number, next: Question) {
    onQuestionsChange(questions.map((q, idx) => (idx === i ? next : q)));
  }
  function changeType(i: number, type: QuestionType) {
    const q = questions[i];
    if (q.type === type) return;
    update(
      i,
      createBlankQuestion(type, {
        explanation: q.explanation,
        id: q.id,
        level: q.level,
        prompt: q.prompt,
      })
    );
  }
  function addQuestion() {
    onQuestionsChange([...questions, createBlankQuestion()]);
  }
  function removeQuestion(i: number) {
    onQuestionsChange(questions.filter((_, idx) => idx !== i));
  }

  return (
    <div className="flex flex-col gap-5">
      {showName && (
        <label className="flex flex-col gap-1.5">
          <p className="t-label text-fg-muted">{m.quiz_name()}</p>
          <Input onChange={(e) => onNameChange(e.target.value)} value={name} />
        </label>
      )}

      {questions.map((q, i) => (
        <div
          className="rounded-card border border-line bg-surface-hover-bg p-4"
          key={q.id}
        >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="t-label text-fg-muted">Q{i + 1}</span>
            <select
              className={selectClass}
              onChange={(e) => changeType(i, e.target.value as QuestionType)}
              value={q.type}
            >
              {QUESTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {quizTypeLabel(t)}
                </option>
              ))}
            </select>
            <select
              className={selectClass}
              onChange={(e) =>
                update(i, { ...q, level: e.target.value as CognitiveLevel })
              }
              value={q.level}
            >
              {LEVELS.map((lvl) => (
                <option key={lvl} value={lvl}>
                  {levelLabel(lvl)}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5">
              <span className="t-label text-fg-muted">{m.quiz_points()}</span>
              <input
                className={selectClass}
                min={0.5}
                onChange={(e) => {
                  const points = Number(e.target.value);
                  update(
                    i,
                    Number.isFinite(points) && points > 0
                      ? { ...q, points }
                      : { ...q, points: undefined }
                  );
                }}
                step={0.5}
                type="number"
                value={q.points ?? 1}
              />
            </label>
            <button
              aria-label={m.quiz_delete_question()}
              className="ml-auto text-fg-muted hover:text-tint-error-fg"
              onClick={() => removeQuestion(i)}
              type="button"
            >
              <Icon name="trash" size={16} />
            </button>
          </div>

          <Input
            onChange={(e) => update(i, { ...q, prompt: e.target.value })}
            placeholder={m.quiz_prompt_placeholder()}
            value={q.prompt}
          />

          {(q.type === 'mcq' || q.type === 'multi') && (
            <div className="mt-3 flex flex-col gap-3">
              {q.options.map((opt, oi) => (
                <div className="flex flex-col gap-1.5" key={oi}>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={q.correct.includes(oi)}
                      onChange={(c) => {
                        const correct = c
                          ? [...q.correct, oi]
                          : q.correct.filter((x) => x !== oi);
                        update(i, {
                          ...q,
                          correct: q.type === 'mcq' ? (c ? [oi] : []) : correct,
                        });
                      }}
                      size={20}
                      tone="green"
                    />
                    <Input
                      onChange={(e) => {
                        const options = [...q.options];
                        options[oi] = { ...options[oi], value: e.target.value };
                        update(i, { ...q, options });
                      }}
                      placeholder={m.quiz_option_n({ n: oi + 1 })}
                      value={opt.value}
                      wrapperClassName="flex-1"
                    />
                    <button
                      aria-label={m.quiz_remove_option()}
                      className="text-fg-muted hover:text-fg disabled:opacity-30"
                      disabled={q.options.length <= 2}
                      onClick={() => {
                        const options = q.options.filter((_, x) => x !== oi);
                        const correct = q.correct
                          .filter((x) => x !== oi)
                          .map((x) => (x > oi ? x - 1 : x));
                        update(i, { ...q, correct, options });
                      }}
                      type="button"
                    >
                      <Icon name="x" size={15} />
                    </button>
                  </div>
                  <Input
                    onChange={(e) => {
                      const options = [...q.options];
                      options[oi] = {
                        ...options[oi],
                        explanation: e.target.value,
                      };
                      update(i, { ...q, options });
                    }}
                    placeholder={m.quiz_option_why({ n: oi + 1 })}
                    value={opt.explanation ?? ''}
                    wrapperClassName="ml-7"
                  />
                </div>
              ))}
              <AddRowButton
                label={m.quiz_add_option()}
                onClick={() =>
                  update(i, { ...q, options: [...q.options, { value: '' }] })
                }
              />
            </div>
          )}

          {q.type === 'boolean' && (
            <div className="mt-3 flex items-center gap-2">
              <p className="t-meta text-fg-muted">{m.quiz_correct_answer()}</p>
              <Button
                onClick={() => update(i, { ...q, correct: true })}
                size="sm"
                variant={q.correct ? 'accent' : 'outline'}
              >
                True
              </Button>
              <Button
                onClick={() => update(i, { ...q, correct: false })}
                size="sm"
                variant={q.correct ? 'outline' : 'accent'}
              >
                False
              </Button>
            </div>
          )}

          {q.type === 'short' && (
            <label className="mt-3 flex flex-col gap-1.5">
              <p className="t-label text-fg-muted">
                {m.quiz_accepted_answers()}
              </p>
              <Input
                onChange={(e) =>
                  update(i, {
                    ...q,
                    accepted: e.target.value
                      .split(',')
                      .map((s) => ({ value: s.trim() })),
                  })
                }
                value={q.accepted.map((a) => a.value).join(', ')}
              />
            </label>
          )}

          {q.type === 'ordering' && (
            <div className="mt-3 flex flex-col gap-2">
              <p className="t-label text-fg-muted">{m.quiz_items_order()}</p>
              {q.items.map((item, oi) => (
                <div className="flex items-center gap-2" key={oi}>
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface font-bold text-fg-secondary text-xs">
                    {oi + 1}
                  </span>
                  <Input
                    onChange={(e) => {
                      const items = [...q.items];
                      items[oi] = { value: e.target.value };
                      update(i, { ...q, items });
                    }}
                    placeholder={m.quiz_item_n({ n: oi + 1 })}
                    value={item.value}
                    wrapperClassName="flex-1"
                  />
                  <button
                    aria-label={m.quiz_remove_item()}
                    className="text-fg-muted hover:text-fg disabled:opacity-30"
                    disabled={q.items.length <= 2}
                    onClick={() =>
                      update(i, {
                        ...q,
                        items: q.items.filter((_, x) => x !== oi),
                      })
                    }
                    type="button"
                  >
                    <Icon name="x" size={15} />
                  </button>
                </div>
              ))}
              <AddRowButton
                label={m.quiz_add_item()}
                onClick={() =>
                  update(i, { ...q, items: [...q.items, { value: '' }] })
                }
              />
            </div>
          )}

          {q.type === 'matching' && (
            <div className="mt-3 flex flex-col gap-2">
              <p className="t-label text-fg-muted">Pairs</p>
              {q.pairs.map((p, oi) => (
                <div className="flex items-center gap-2" key={oi}>
                  <Input
                    onChange={(e) => {
                      const pairs = q.pairs.map((x, xi) =>
                        xi === oi ? { ...x, left: e.target.value } : x
                      );
                      update(i, { ...q, pairs });
                    }}
                    placeholder={m.quiz_matching_left()}
                    value={p.left}
                    wrapperClassName="flex-1"
                  />
                  <Icon className="text-fg-muted" name="arrowRight" size={14} />
                  <Input
                    onChange={(e) => {
                      const pairs = q.pairs.map((x, xi) =>
                        xi === oi ? { ...x, right: e.target.value } : x
                      );
                      update(i, { ...q, pairs });
                    }}
                    placeholder={m.quiz_matching_right()}
                    value={p.right}
                    wrapperClassName="flex-1"
                  />
                  <button
                    aria-label={m.quiz_remove_pair()}
                    className="text-fg-muted hover:text-fg disabled:opacity-30"
                    disabled={q.pairs.length <= 2}
                    onClick={() =>
                      update(i, {
                        ...q,
                        pairs: q.pairs.filter((_, x) => x !== oi),
                      })
                    }
                    type="button"
                  >
                    <Icon name="x" size={15} />
                  </button>
                </div>
              ))}
              <AddRowButton
                label={m.quiz_add_pair()}
                onClick={() =>
                  update(i, {
                    ...q,
                    pairs: [...q.pairs, { left: '', right: '' }],
                  })
                }
              />
            </div>
          )}

          {q.type === 'open' && (
            <div className="mt-3 flex flex-col gap-3">
              <label className="flex flex-col gap-1.5">
                <p className="t-label text-fg-muted">{m.quiz_model_answer()}</p>
                <textarea
                  className="min-h-20 rounded-button border border-line bg-surface px-3 py-2 text-fg text-sm outline-none focus:border-line-strong"
                  onChange={(e) =>
                    update(i, { ...q, accepted: [{ value: e.target.value }] })
                  }
                  placeholder={m.quiz_model_answer_placeholder()}
                  value={q.accepted[0]?.value ?? ''}
                />
              </label>
              <div className="flex flex-col gap-2">
                <p className="t-label text-fg-muted">{m.quiz_hints()}</p>
                {q.hints.map((hint, hi) => (
                  <div className="flex items-center gap-2" key={hi}>
                    <Input
                      onChange={(e) => {
                        const hints = [...q.hints];
                        hints[hi] = { value: e.target.value };
                        update(i, { ...q, hints });
                      }}
                      placeholder={m.quiz_hint_n({ n: hi + 1 })}
                      value={hint.value}
                      wrapperClassName="flex-1"
                    />
                    <button
                      aria-label={m.quiz_remove_hint()}
                      className="text-fg-muted hover:text-fg"
                      onClick={() =>
                        update(i, {
                          ...q,
                          hints: q.hints.filter((_, x) => x !== hi),
                        })
                      }
                      type="button"
                    >
                      <Icon name="x" size={15} />
                    </button>
                  </div>
                ))}
                <AddRowButton
                  label={m.quiz_add_hint()}
                  onClick={() =>
                    update(i, { ...q, hints: [...q.hints, { value: '' }] })
                  }
                />
              </div>
              <div className="flex flex-col gap-2">
                <p className="t-label text-fg-muted">{m.quiz_rubrics()}</p>
                {q.rubrics.map((rubric, ri) => (
                  <div className="flex items-center gap-2" key={ri}>
                    <Input
                      onChange={(e) => {
                        const rubrics = [...q.rubrics];
                        rubrics[ri] = { value: e.target.value };
                        update(i, { ...q, rubrics });
                      }}
                      placeholder={m.quiz_rubric_n({ n: ri + 1 })}
                      value={rubric.value}
                      wrapperClassName="flex-1"
                    />
                    <button
                      aria-label={m.quiz_remove_rubric()}
                      className="text-fg-muted hover:text-fg disabled:opacity-30"
                      disabled={q.rubrics.length <= 1}
                      onClick={() =>
                        update(i, {
                          ...q,
                          rubrics: q.rubrics.filter((_, x) => x !== ri),
                        })
                      }
                      type="button"
                    >
                      <Icon name="x" size={15} />
                    </button>
                  </div>
                ))}
                <AddRowButton
                  label={m.quiz_add_rubric()}
                  onClick={() =>
                    update(i, { ...q, rubrics: [...q.rubrics, { value: '' }] })
                  }
                />
              </div>
            </div>
          )}

          <label className="mt-3 flex flex-col gap-1.5">
            <p className="t-label text-fg-muted">Explanation (optional)</p>
            <Input
              onChange={(e) => update(i, { ...q, explanation: e.target.value })}
              placeholder={m.quiz_explanation_placeholder()}
              value={q.explanation ?? ''}
            />
          </label>
        </div>
      ))}

      <Button iconLeft="plus" onClick={addQuestion} variant="outline">
        Add question
      </Button>
    </div>
  );
}

function AddRowButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        'flex items-center gap-1 self-start rounded-full border border-line border-dashed px-2.5 py-1',
        'font-medium text-fg-secondary text-xs hover:bg-surface'
      )}
      onClick={onClick}
      type="button"
    >
      <Icon name="plus" size={13} /> {label}
    </button>
  );
}
