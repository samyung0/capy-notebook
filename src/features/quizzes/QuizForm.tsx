import type { CognitiveLevel, Question, QuestionType } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';
import { LEVEL_LABEL, LEVELS } from '@/lib/levels';

const Q_TYPES: QuestionType[] = [
  'mcq',
  'multi',
  'boolean',
  'fill',
  'short',
  'matching',
  'ordering',
];
const Q_TYPE_LABEL: Record<QuestionType, string> = {
  boolean: 'True / false',
  fill: 'Fill blank',
  matching: 'Matching',
  mcq: 'Multiple choice',
  multi: 'Multi-select',
  ordering: 'Ordering',
  short: 'Short answer',
};

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
    case 'fill':
      return { ...shared, accepted: [{ value: '' }], type: 'fill' };
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
    case 'fill':
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
          <p className="t-label text-fg-muted">Quiz name</p>
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
              {Q_TYPES.map((t) => (
                <option key={t} value={t}>
                  {Q_TYPE_LABEL[t]}
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
                  {LEVEL_LABEL[lvl]}
                </option>
              ))}
            </select>
            <button
              aria-label="Delete question"
              className="ml-auto text-fg-muted hover:text-tint-error-fg"
              onClick={() => removeQuestion(i)}
              type="button"
            >
              <Icon name="trash" size={16} />
            </button>
          </div>

          <Input
            onChange={(e) => update(i, { ...q, prompt: e.target.value })}
            placeholder="Question prompt"
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
                      placeholder={`Option ${oi + 1}`}
                      value={opt.value}
                      wrapperClassName="flex-1"
                    />
                    <button
                      aria-label="Remove option"
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
                    placeholder={`Why option ${oi + 1} is right / wrong (optional)`}
                    value={opt.explanation ?? ''}
                    wrapperClassName="ml-7"
                  />
                </div>
              ))}
              <AddRowButton
                label="Add option"
                onClick={() =>
                  update(i, { ...q, options: [...q.options, { value: '' }] })
                }
              />
            </div>
          )}

          {q.type === 'boolean' && (
            <div className="mt-3 flex items-center gap-2">
              <p className="t-meta text-fg-muted">Correct answer:</p>
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

          {(q.type === 'fill' || q.type === 'short') && (
            <label className="mt-3 flex flex-col gap-1.5">
              <p className="t-label text-fg-muted">
                Accepted answers (comma separated)
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
              <p className="t-label text-fg-muted">
                Items (listed in correct order)
              </p>
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
                    placeholder={`Item ${oi + 1}`}
                    value={item.value}
                    wrapperClassName="flex-1"
                  />
                  <button
                    aria-label="Remove item"
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
                label="Add item"
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
                    placeholder="Left"
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
                    placeholder="Right"
                    value={p.right}
                    wrapperClassName="flex-1"
                  />
                  <button
                    aria-label="Remove pair"
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
                label="Add pair"
                onClick={() =>
                  update(i, {
                    ...q,
                    pairs: [...q.pairs, { left: '', right: '' }],
                  })
                }
              />
            </div>
          )}

          <label className="mt-3 flex flex-col gap-1.5">
            <p className="t-label text-fg-muted">Explanation (optional)</p>
            <Input
              onChange={(e) => update(i, { ...q, explanation: e.target.value })}
              placeholder="Shown after answering"
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
