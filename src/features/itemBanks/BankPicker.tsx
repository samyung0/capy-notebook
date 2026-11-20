import { type ReactNode, useRef, useState } from 'react';
import { useCopyBankQuestions, useCreateBankQuiz } from '@/api/hooks';
import {
  useItemBankQuestions,
  useItemBanks,
  useItemBankTags,
} from '@/api/itemBanks';
import type {
  AssignmentFormReq,
  ItemBank,
  ItemBankQuestion,
  Question,
} from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { ListEnd } from '@/components/app/ListEnd';
import { Button } from '@/components/ui/Button';
import { checkboxVariants } from '@/components/ui/Checkbox';
import { SimpleDialog } from '@/components/ui/Dialog';
import { SkeletonList, Spinner } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { SearchInput } from '@/components/ui/SearchInput';
import { TwoWaySwitch } from '@/components/ui/TwoWaySwitch';
import { userToast } from '@/components/ui/userToast';
import { collectSelectionPages } from '@/features/files/useFileSelection';
import { questionMarks } from '@/features/questions/types';
import { quizBounds } from '@/features/questions/validation';
import { questionSummary } from '@/features/quizzes/QuizSplit';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { unexpectedErrorId } from '@/lib/errors';
import { useDebounced } from '@/lib/useDebounced';
import { questionTypes } from './bankText';
import {
  BankFilter,
  hasTopicOrTags,
  TopicAndTags,
  useBankTopics,
} from './TopicAndTags';

/** The questions picked from one bank, in the order picked. */
interface Picked {
  bank: string;
  items: ItemBankQuestion[];
}

/**
 * Add quiz's From the bank (Epo 2026-11-14, board BankPicker): the banks the
 * caller may use here (the class's and My bank, switched; My bank alone has no
 * switch), Search, a class bank's Topic, Tags, Select all and a box per
 * question, its topic's badge before its tags. The primary button
 * copies the picked questions, images and all, into a new quiz: the server's
 * `POST /api/item-banks/{bank}/quizzes`, so a later bank edit never reaches
 * it. Picks belong to the bank shown: switching banks starts them over. The
 * body mounts on the tab's first visit, so the banks load only then.
 */
export function useBankPicker({
  active,
  gradedQuiz,
  label,
  onMade,
  title,
  workspaceId,
}: {
  /** The tab is showing. */
  active: boolean;
  /** A graded quiz's settings: the quiz is made with its graded quiz. */
  gradedQuiz?: AssignmentFormReq;
  /** The primary button's label. */
  label: string;
  onMade: (quizId: string, assignmentId?: string) => void;
  /** The new quiz's title, worked out when it is made. */
  title: () => string;
  workspaceId: string;
}) {
  const { body, note, picked, tooLarge } = useBankPicks({
    active,
    workspaceId,
  });
  const { isPending: creating, mutate: create } =
    useCreateBankQuiz(workspaceId);
  const action = (
    <Button
      disabled={creating || picked.items.length === 0 || !!tooLarge}
      onClick={() => {
        const name = title();
        create(
          {
            bank: picked.bank,
            // An untitled graded quiz is named after its quiz.
            gradedQuiz: gradedQuiz && {
              ...gradedQuiz,
              title: gradedQuiz.title || name,
            },
            questionIds: picked.items.map((item) => item.id),
            title: name,
          },
          {
            onSuccess: (material) => onMade(material.id, material.assignmentId),
          }
        );
      }}
      type="button"
    >
      {creating ? <Spinner /> : label}
    </Button>
  );
  return { action, body, note };
}

/**
 * The quiz editor's From the bank (Epo 2026-11-15, boards Main and Phone): the
 * same picker in a dialog, whose "Add N questions" copies the picked questions,
 * images and all, for the quiz (`POST /api/quizzes/{id}/bank-questions`) and
 * hands the copies to `onAdd` to insert. The picks count against the quiz's
 * bounds with the questions it already holds.
 */
export function BankQuestionsDialog({
  existing,
  onAdd,
  onClose,
  open,
  quizId,
  workspaceId,
}: {
  /** The quiz's questions now. */
  existing: Question[];
  onAdd: (questions: Question[]) => void;
  onClose: () => void;
  open: boolean;
  quizId: string;
  /** The quiz's workspace ('' for none: My bank alone). */
  workspaceId: string;
}) {
  const { body, note, picked, tooLarge } = useBankPicks({
    active: open,
    existing,
    freshOnOpen: true,
    workspaceId,
  });
  const { isPending: copying, mutate: copy } = useCopyBankQuestions(quizId);
  const count = picked.items.length;
  return (
    <SimpleDialog
      action={
        <Button
          disabled={copying || count === 0 || !!tooLarge}
          onClick={() =>
            copy(
              {
                bank: picked.bank,
                questionIds: picked.items.map((item) => item.id),
              },
              { onSuccess: ({ questions }) => onAdd(questions) }
            )
          }
          type="button"
        >
          {copying ? (
            <Spinner />
          ) : count === 0 ? (
            m.bank_add_questions_none()
          ) : count === 1 ? (
            m.bank_add_one_question()
          ) : (
            m.bank_add_questions({ count })
          )}
        </Button>
      }
      cardClassName="h-full"
      className="flex flex-col gap-0 sm:h-[min(680px,88dvh)]"
      footer={
        note && (
          <p className="t-meta mr-auto flex min-w-0 items-center gap-1.5 self-center text-fg-muted max-sm:w-full">
            {note}
          </p>
        )
      }
      onClose={onClose}
      open={open}
      pending={copying}
      title={m.practice_tab_bank()}
      width={600}
    >
      {body}
    </SimpleDialog>
  );
}

const NO_PICKS: Picked = { bank: '', items: [] };

/** The picker's body and the note under it (count and marks, or the quiz
 * bound the picks break with `existing`, the quiz's questions). */
function useBankPicks({
  active,
  existing = [],
  freshOnOpen = false,
  workspaceId,
}: {
  active: boolean;
  existing?: Question[];
  /** Each time `active` turns on, the picks, bank, search and filters start
   * over, so a dialog opened again never adds the last picks twice. */
  freshOnOpen?: boolean;
  workspaceId: string;
}) {
  // `opens` counts the fresh starts; 0 while never shown.
  const [shown, setShown] = useState({ active, opens: active ? 1 : 0 });
  const [picked, setPicked] = useState<Picked>(NO_PICKS);
  if (active !== shown.active) {
    const fresh = active && (freshOnOpen || shown.opens === 0);
    setShown({ active, opens: shown.opens + (fresh ? 1 : 0) });
    if (fresh) setPicked(NO_PICKS);
  }

  const marks = picked.items.reduce(
    (sum, item) => sum + questionMarks(item.question),
    0
  );
  let tooLarge: string | undefined;
  try {
    quizBounds([...existing, ...picked.items.map((item) => item.question)]);
  } catch (error) {
    tooLarge = (error as Error).message;
  }
  const note =
    picked.items.length === 0 ? null : tooLarge ? (
      <span className="text-tint-error-fg">{tooLarge}</span>
    ) : (
      <>
        <span className="font-semibold text-fg">
          {picked.items.length === 1
            ? m.question_ui_one_question()
            : m.question_ui_question_count({ count: picked.items.length })}
        </span>
        <span>·</span>
        <span>
          {marks === 1
            ? m.question_ui_one_mark()
            : m.question_ui_marks({ count: marks })}
        </span>
      </>
    );
  const body = shown.opens ? (
    <BankPickerBody
      key={shown.opens}
      onPick={setPicked}
      picked={picked}
      workspaceId={workspaceId}
    />
  ) : null;
  return { body, note, picked, tooLarge };
}

/** The switch says just "Personal" or the class's name, without "bank"
 * (Epo 2026-11-16). */
const switchName = (bank: ItemBank) =>
  bank.kind === 'personal' ? m.bank_personal() : bank.name;

function BankPickerBody({
  onPick,
  picked,
  workspaceId,
}: {
  onPick: (picked: Picked) => void;
  picked: Picked;
  workspaceId: string;
}) {
  const { data: banks, error, isError, refetch } = useItemBanks(workspaceId);
  if (isError)
    return (
      <ErrorState
        className="h-auto py-16"
        errorId={unexpectedErrorId(error)}
        onRetry={() => void refetch()}
        title={m.bank_load_failed()}
        variant="panel"
      />
    );
  if (!banks) return <SkeletonList count={6} rowHeight={52} />;
  const bank = picked.bank || banks[0].id;
  return (
    <>
      {banks.length > 1 && (
        <TwoWaySwitch
          className="mb-3"
          label={m.practice_tab_bank()}
          onChange={(next) => onPick({ bank: next, items: [] })}
          options={[
            { label: switchName(banks[0]), value: banks[0].id },
            { label: switchName(banks[1]), value: banks[1].id },
          ]}
          value={bank}
        />
      )}
      {/* Keyed, so a bank's search and tags start over with it. */}
      <BankQuestions
        bank={bank}
        key={bank}
        onPick={(items) => onPick({ bank, items })}
        picked={picked.bank === bank ? picked.items : []}
      />
    </>
  );
}

function BankQuestions({
  bank,
  onPick,
  picked,
}: {
  bank: string;
  onPick: (items: ItemBankQuestion[]) => void;
  picked: ItemBankQuestion[];
}) {
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim());
  const [tags, setTags] = useState<string[]>([]);
  const [topicIds, setTopicIds] = useState<string[]>([]);
  const topics = useBankTopics(bank);
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchingNextPage,
    isFetchNextPageError,
    isPending,
    refetch,
  } = useItemBankQuestions(bank, { q, tags, topics: topicIds });
  const { data: bankTags = [] } = useItemBankTags(bank);
  const scroller = useRef<HTMLDivElement>(null);
  const [loadingAll, setLoadingAll] = useState(false);
  const items = data?.pages.flatMap((page) => page.items) ?? [];
  const total = data?.pages[0]?.total ?? 0;
  const pickedIds = new Set(picked.map((item) => item.id));
  const allPicked =
    !hasNextPage &&
    items.length > 0 &&
    items.every((item) => pickedIds.has(item.id));

  const toggle = (item: ItemBankQuestion, on: boolean) =>
    onPick(
      on
        ? [...picked, item]
        : picked.filter((current) => current.id !== item.id)
    );
  // Every match, every page loaded first; picks outside the filter stay.
  const toggleAll = async (on: boolean) => {
    if (loadingAll) return;
    if (!on) {
      const shown = new Set(items.map((item) => item.id));
      onPick(picked.filter((item) => !shown.has(item.id)));
      return;
    }
    setLoadingAll(true);
    try {
      const all = await collectSelectionPages(data?.pages ?? [], () =>
        fetchNextPage({ throwOnError: true })
      );
      onPick([...picked, ...all.filter((item) => !pickedIds.has(item.id))]);
    } catch {
      userToast({ title: m.files_selection_load_failed(), variant: 'error' });
    } finally {
      setLoadingAll(false);
    }
  };

  let list: ReactNode;
  if (isPending) list = <SkeletonList count={6} rowHeight={52} />;
  else if (isError)
    list = (
      <ErrorState
        className="h-auto py-16"
        errorId={unexpectedErrorId(error)}
        onRetry={() => void refetch()}
        title={m.bank_load_failed()}
        variant="panel"
      />
    );
  else if (items.length === 0)
    list = (
      <p className="t-meta mt-3 text-fg-muted">
        {q || tags.length > 0 || topicIds.length > 0
          ? m.common_no_matches()
          : m.common_nothing_yet()}
      </p>
    );
  else
    list = (
      <>
        <div>
          <PickRow
            checked={allPicked}
            className="py-2 font-semibold text-sm"
            onChange={(on) => void toggleAll(on)}
          >
            {m.bank_select_all({ count: total })}
            {loadingAll && <Spinner className="ml-2 text-fg-muted" />}
          </PickRow>
          {items.map((item) => (
            <PickRow
              checked={pickedIds.has(item.id)}
              key={item.id}
              onChange={(on) => toggle(item, on)}
            >
              <span className="line-clamp-2">
                {questionSummary(item.question)}
              </span>
              <span className="t-meta mt-1 flex flex-wrap gap-x-1.5 text-fg-secondary">
                <span>{questionTypes(item.question)}</span>
                <span>·</span>
                <span>
                  {questionMarks(item.question) === 1
                    ? m.question_ui_one_mark()
                    : m.question_ui_marks({
                        count: questionMarks(item.question),
                      })}
                </span>
              </span>
              {hasTopicOrTags(item, topics) && (
                <TopicAndTags
                  className="t-meta mt-1.5 text-fg-secondary"
                  item={item}
                  topics={topics}
                />
              )}
            </PickRow>
          ))}
        </div>
        <ListEnd
          fetchNextPage={fetchNextPage}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          isFetchNextPageError={isFetchNextPageError}
          root={scroller}
        />
      </>
    );

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          aria-label={m.bank_search()}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={m.bank_search()}
          value={query}
          wrapperClassName="h-8 min-w-0 flex-1"
        />
        <BankFilter
          bankTags={bankTags}
          onTags={setTags}
          onTopicIds={setTopicIds}
          tags={tags}
          topicIds={topicIds}
          topics={topics}
        />
      </div>
      {/* Its own scroller, filling the dialog's fixed height, so the dialog
          keeps its size across banks and filters. */}
      <div className="mt-2 min-h-60 flex-1 overflow-y-auto" ref={scroller}>
        {list}
      </div>
    </>
  );
}

/** A row that is its own checkbox: a click or Space anywhere on it picks it. */
function PickRow({
  checked,
  children,
  className,
  onChange,
}: {
  checked: boolean;
  children: ReactNode;
  className?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div
      aria-checked={checked}
      className={cn(
        'flex cursor-pointer items-start gap-3 border-divider border-b px-1 py-3 outline-none hover:bg-surface-hover-bg focus-visible:bg-surface-hover-bg',
        className
      )}
      onClick={() => onChange(!checked)}
      onKeyDown={(event) => {
        if (event.key !== ' ' && event.key !== 'Enter') return;
        event.preventDefault();
        onChange(!checked);
      }}
      role="checkbox"
      tabIndex={0}
    >
      <span
        aria-hidden
        className={cn(checkboxVariants({ checked }), 'mt-0.5 size-4.5')}
      >
        {checked && <Icon name="check" size={13} strokeWidth={2.4} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">{children}</span>
    </div>
  );
}
