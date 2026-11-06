import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { isApiError } from '@/api/client';
import { useFiles, useGenerate, useMaterials, useTopics } from '@/api/hooks';
import type { MaterialRef, QuestionType, SourceFile, Topic } from '@/api/types';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/Dialog';
import { FormAlert } from '@/components/ui/FormAlert';
import { Icon } from '@/components/ui/Icon';
import { Menu } from '@/components/ui/Menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { m } from '@/i18n';
import {
  deferStorageRefusal,
  describeError,
  unexpectedErrorId,
} from '@/lib/errors';

const COUNTS = [5, 10, 15, 20] as const;

/** What each Question types choice asks for. Mixed leaves out gaps, which are
 * authored only, as generation always has. */
const TYPES: { label: () => string; types: QuestionType[]; value: string }[] = [
  {
    label: m.practice_types_mixed,
    types: ['mcq', 'boolean', 'short', 'open', 'matching', 'ordering'],
    value: 'mixed',
  },
  { label: m.quiz_type_mcq, types: ['mcq'], value: 'mcq' },
  { label: m.quiz_type_short, types: ['short'], value: 'short' },
  { label: m.quiz_type_open, types: ['open'], value: 'open' },
];

/** What a topic can feed a run: its indexed files and notes. A generate run
 * reads sources, so a topic holding only quizzes has nothing to offer. */
export function practiceSources(
  topics: Topic[],
  files: SourceFile[],
  materials: MaterialRef[]
) {
  const inTopic = (topicId: string | null) => [
    ...files
      .filter((f) => f.indexed && (f.topicId ?? null) === topicId)
      .map((f) => ({ id: f.id, name: f.name })),
    ...materials
      .filter((mt) => mt.type === 'note' && (mt.topicId ?? null) === topicId)
      .map((mt) => ({ id: mt.id, name: mt.title })),
  ];
  const offered = [...topics]
    .sort((a, b) => a.order - b.order)
    .map((t) => ({ id: t.id, name: t.name }))
    .filter((t) => inTopic(t.id).length > 0);
  const items = [...topics.map((t) => t.id), null].flatMap(inTopic);
  return { items, topics: offered };
}

/** Removable picks, then a menu adding one more. */
function Picks({
  add,
  label,
  onChange,
  options,
  picked,
}: {
  add: string;
  label: string;
  onChange: (ids: string[]) => void;
  options: { id: string; name: string }[];
  picked: string[];
}) {
  const left = options.filter((o) => !picked.includes(o.id));
  return (
    <div className="flex flex-col gap-1.5">
      <span className="t-meta font-semibold text-fg-secondary">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {options
          .filter((o) => picked.includes(o.id))
          .map((o) => (
            <span
              className="t-meta inline-flex h-7 max-w-full items-center gap-1 rounded-md bg-page-hover pr-1 pl-2 font-semibold text-fg-secondary"
              key={o.id}
            >
              <span className="truncate">{o.name}</span>
              <button
                aria-label={m.practice_remove_pick({ name: o.name })}
                className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-surface-hover-bg"
                onClick={() => onChange(picked.filter((id) => id !== o.id))}
                type="button"
              >
                <Icon name="x" size={14} />
              </button>
            </span>
          ))}
        {left.length > 0 && (
          <Menu
            align="start"
            items={left.map((o) => ({
              label: o.name,
              onClick: () => onChange([...picked, o.id]),
            }))}
            trigger={
              <Button iconLeft="plus" size="sm" variant="outline">
                {add}
              </Button>
            }
          />
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: { label: string; value: string }[];
  value: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="t-meta font-semibold text-fg-secondary">{label}</span>
      <Select onValueChange={onChange} value={value}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Make my own practice (Epo 2026-11-04, boards P3 and T5): a quiz written from
 * the sources picked, kept as a quiz file. A member's is their own, which only
 * they can reach (`onlyYou`); it opens ready to answer. Questions keep the
 * generation prompt as it was. */
export function MakePractice({
  initialTopicId,
  onClose,
  onMade,
  onlyYou,
  title,
  workspaceId,
}: {
  /** The topic it starts on: Summary's weakest. */
  initialTopicId?: string;
  onClose: () => void;
  /** Stays on the page once the quiz is made, rather than opening it to answer:
   * a teacher making one for an assignment. */
  onMade?: () => void;
  onlyYou: boolean;
  /** The dialog's title, where "Make my own practice" isn't what's happening. */
  title?: string;
  workspaceId: string;
}) {
  const navigate = useNavigate();
  const { data: topics } = useTopics(workspaceId);
  const { data: files } = useFiles(workspaceId);
  const { data: materials } = useMaterials(workspaceId);
  const sources = useMemo(
    () => practiceSources(topics ?? [], files ?? [], materials ?? []),
    [topics, files, materials]
  );
  const { isPending, mutateAsync: generate } = useGenerate(workspaceId, {
    errorToast: false,
  });
  const [formError, setFormError] = useState<{
    errorId: string | null;
    message: string;
  } | null>(null);
  const [from, setFrom] = useState<'topics' | 'files'>('topics');
  const [pickedTopics, setPickedTopics] = useState<string[] | null>(null);
  const [pickedFiles, setPickedFiles] = useState<string[]>([]);
  const [count, setCount] = useState(10);
  const [types, setTypes] = useState('mixed');
  const [mix, setMix] = useState(false);
  // The start topic once it is known to have sources, else the first that does.
  const startTopic =
    sources.topics.find((t) => t.id === initialTopicId) ?? sources.topics[0];
  const chosenTopics =
    pickedTopics ?? (startTopic ? [startTopic.id] : ([] as string[]));
  const ready =
    from === 'topics' ? chosenTopics.length > 0 : pickedFiles.length > 0;
  // Loaded, and nothing to generate from: says why Start stays off.
  const nothingToRead =
    !!topics &&
    !!files &&
    !!materials &&
    sources.topics.length === 0 &&
    sources.items.length === 0;
  const nameOf = (id?: string) =>
    (from === 'topics' ? sources.topics : sources.items).find(
      (o) => o.id === id
    )?.name;

  async function start() {
    setFormError(null);
    const picked = from === 'topics' ? chosenTopics : pickedFiles;
    try {
      const made = (await generate({
        count,
        fileIds: from === 'files' ? picked : [],
        mix,
        title: m.practice_own_title({
          name: nameOf(picked[0])?.slice(0, 80) ?? '',
        }),
        topics: from === 'topics' ? picked : [],
        types: TYPES.find((t) => t.value === types)?.types ?? [],
      })) as { quiz?: { id: string } };
      if (onMade) onMade();
      else if (made.quiz?.id)
        navigate({
          params: { quizId: made.quiz.id },
          to: '/quizzes/$quizId/attempt',
        });
    } catch (error) {
      // A frozen or storage refusal shows as the workspace status instead.
      if (isApiError(error) && error.code === 'pending_sources_too_large')
        setFormError({ errorId: null, message: m.source_pending_context() });
      else if (!deferStorageRefusal(error))
        setFormError({
          errorId: unexpectedErrorId(error),
          message: describeError(error).description,
        });
    }
  }

  const startButton = (
    <Button disabled={!ready || isPending} onClick={() => void start()}>
      {isPending ? m.generating_quiz() : m.review_start()}
    </Button>
  );
  return (
    <Dialog onOpenChange={(open) => !open && !isPending && onClose()} open>
      <DialogContent
        aria-describedby={undefined}
        cardScrollContainerClassName="sm:px-7 sm:pb-0"
        className="sm:max-w-[600px]"
      >
        <DialogTitle action={startButton} className="pb-0">
          {title ?? m.practice_make_own()}
        </DialogTitle>
        <div className="mt-4 flex flex-col gap-4">
          {nothingToRead && (
            <p className="text-fg-secondary text-sm">
              {m.practice_nothing_to_read()}
            </p>
          )}
          <Field
            label={m.practice_from()}
            onChange={(v) => setFrom(v as 'topics' | 'files')}
            options={[
              { label: m.practice_from_topics(), value: 'topics' },
              { label: m.practice_from_files(), value: 'files' },
            ]}
            value={from}
          />
          {from === 'topics' ? (
            <Picks
              add={m.practice_add_topic()}
              label={m.practice_from_topics()}
              onChange={setPickedTopics}
              options={sources.topics}
              picked={chosenTopics}
            />
          ) : (
            <Picks
              add={m.practice_add_file()}
              label={m.practice_from_files()}
              onChange={setPickedFiles}
              options={sources.items}
              picked={pickedFiles}
            />
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field
              label={m.practice_choose_questions()}
              onChange={(v) => setCount(Number(v))}
              options={COUNTS.map((n) => ({
                label: String(n),
                value: String(n),
              }))}
              value={String(count)}
            />
            <Field
              label={m.practice_question_types()}
              onChange={setTypes}
              options={TYPES.map((t) => ({
                label: t.label(),
                value: t.value,
              }))}
              value={types}
            />
          </div>
          <label className="flex items-center justify-between gap-3">
            <span>{m.practice_mix_answered()}</span>
            <Switch checked={mix} onCheckedChange={setMix} />
          </label>
        </div>
        <p className="t-meta mt-4 flex items-center gap-1.5 text-fg-muted sm:hidden">
          <Icon name="ai" size={14} />
          {onlyYou ? m.practice_credits_only_you() : m.practice_credits()}
        </p>
        <FormAlert
          errorId={formError?.errorId}
          message={formError?.message ?? null}
        />
        <DialogFooter className="mt-2.5 max-sm:hidden sm:-mx-7 sm:px-7 sm:pb-5">
          <span className="t-meta mr-auto flex items-center gap-1.5 text-fg-muted">
            <Icon name="ai" size={14} />
            {onlyYou ? m.practice_credits_only_you() : m.practice_credits()}
          </span>
          <Button disabled={isPending} onClick={onClose} variant="ghost">
            {m.action_cancel()}
          </Button>
          {startButton}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
