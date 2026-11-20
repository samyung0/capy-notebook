import { type KeyboardEvent, lazy, Suspense, useState } from 'react';
import {
  PERSONAL_BANK,
  useDeleteItemBankQuestion,
  useItemBankQuestions,
  useItemBankTags,
  useSaveItemBankQuestion,
} from '@/api/itemBanks';
import type { ItemBankQuestion } from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { ListEnd } from '@/components/app/ListEnd';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Popover, PopoverTrigger } from '@/components/ui/Popover';
import { SearchInput } from '@/components/ui/SearchInput';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { ToolbarPopoverContent } from '@/components/ui/ToolbarPopover';
import { MenuItem } from '@/features/questions/editorFields';
import { blankQuestion, questionMarks } from '@/features/questions/types';
import { questionSummary } from '@/features/quizzes/QuizSplit';
import { dayMonth } from '@/features/study/assignments/assignmentText';
import { Td, Th } from '@/features/study/practice/studyPage';
import { m } from '@/i18n';
import { unexpectedErrorId } from '@/lib/errors';
import { useDebounced } from '@/lib/useDebounced';
import { useLoadingReveal } from '@/lib/useLoadingReveal';
import { questionTypes } from './bankText';
import {
  BankFilter,
  hasTopicOrTags,
  TopicAndTags,
  useBankTopics,
} from './TopicAndTags';

const QuestionDialog = lazy(() =>
  import('@/features/questions/QuestionDialog').then((module) => ({
    default: module.QuestionDialog,
  }))
);

/**
 * One item bank's page body (Epo 2026-11-14, mock A): Search over the
 * questions' words and answers, a class bank's Topic filter, the Tags filter
 * and the count, then the questions newest first, each with its topic's badge
 * before its tags (Epo 2026-11-15). A row opens the question dialog to edit it
 * with its tags under Topic (Epo 2026-11-15); its ⋮ edits or deletes it. New
 * question, the page header's button, opens the same dialog on a blank
 * question.
 */
export function ItemBankList({
  bank,
  creating,
  onCreatingChange,
}: {
  /** `me`, or the class workspace's id. */
  bank: string;
  creating: boolean;
  onCreatingChange: (creating: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim());
  const [tags, setTags] = useState<string[]>([]);
  const [topicIds, setTopicIds] = useState<string[]>([]);
  const topics = useBankTopics(bank);
  const workspaceBank = bank !== PERSONAL_BANK;
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
  const { mutateAsync: save } = useSaveItemBankQuestion();
  const { mutate: remove } = useDeleteItemBankQuestion();
  const [blank, setBlank] = useState(blankQuestion);
  const [editing, setEditing] = useState<ItemBankQuestion | null>(null);
  const [deleting, setDeleting] = useState<ItemBankQuestion | null>(null);
  const revealRef = useLoadingReveal(isPending);
  const items = data?.pages.flatMap((page) => page.items) ?? [];
  const total = data?.pages[0]?.total ?? 0;
  const filtered = !!q || tags.length > 0 || topicIds.length > 0;

  const rowProps = (item: ItemBankQuestion) => ({
    onClick: () => setEditing(item),
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      setEditing(item);
    },
    role: 'button',
    tabIndex: 0,
  });
  const actions = (item: ItemBankQuestion) => (
    <RowActions
      onDelete={() => setDeleting(item)}
      onEdit={() => setEditing(item)}
    />
  );
  // Wrapped, never cut: the cell's truncate stops at this box.
  const tagList = (item: ItemBankQuestion) => (
    <TopicAndTags className="text-fg-secondary" item={item} topics={topics} />
  );

  return (
    <section className="@container">
      <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-2">
        <SearchInput
          aria-label={m.bank_search()}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={m.bank_search()}
          value={query}
          wrapperClassName="h-8 sm:w-70"
        />
        <BankFilter
          bankTags={bankTags}
          onTags={setTags}
          onTopicIds={setTopicIds}
          tags={tags}
          topicIds={topicIds}
          topics={topics}
        />
        {data && (
          <span className="t-meta ml-auto text-fg-muted">
            {total === 1
              ? m.question_ui_one_question()
              : m.question_ui_question_count({ count: total })}
          </span>
        )}
      </div>
      {isPending ? (
        <SkeletonList className="mt-4" count={6} rowHeight={44} />
      ) : isError ? (
        <ErrorState
          className="h-auto py-20"
          errorId={unexpectedErrorId(error)}
          onRetry={() => void refetch()}
          title={m.bank_load_failed()}
          variant="panel"
        />
      ) : items.length === 0 ? (
        <p className="t-meta mt-6 text-fg-muted">
          {filtered ? m.common_no_matches() : m.common_nothing_yet()}
        </p>
      ) : (
        <div className="mt-3" ref={revealRef}>
          {/* Wide: the mock's table. */}
          <table className="@[740px]:table hidden w-full table-fixed border-separate border-spacing-0">
            <thead>
              <tr>
                <Th>{m.editor_export_question()}</Th>
                <Th className="w-40">{m.common_type()}</Th>
                <Th className="w-20">{m.question_ui_part_marks()}</Th>
                <Th className="w-64">{m.bank_topic_and_tags()}</Th>
                <Th className="w-24">{m.common_added()}</Th>
                <Th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  className="cursor-pointer outline-none hover:[&>td]:bg-surface-hover-bg focus-visible:[&>td]:bg-surface-hover-bg"
                  key={item.id}
                  {...rowProps(item)}
                >
                  <Td className="h-auto whitespace-normal py-2.5 align-top">
                    <span className="line-clamp-2">
                      {questionSummary(item.question)}
                    </span>
                  </Td>
                  <Td className="py-2.5 align-top">
                    {questionTypes(item.question)}
                  </Td>
                  <Td className="py-2.5 align-top">
                    {questionMarks(item.question)}
                  </Td>
                  <Td className="h-auto whitespace-normal py-2.5 align-top">
                    {tagList(item)}
                  </Td>
                  <Td className="py-2.5 align-top" muted>
                    {dayMonth(item.createdAt)}
                  </Td>
                  <Td className="py-1.5 text-right align-top">
                    {actions(item)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Phones and narrow panes: the text, its facts under it. */}
          <ul className="@[740px]:hidden">
            {items.map((item) => (
              <li
                className="flex cursor-pointer items-start gap-2 border-divider border-b py-2.5 outline-none hover:bg-surface-hover-bg focus-visible:bg-surface-hover-bg"
                key={item.id}
                {...rowProps(item)}
              >
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2">
                    {questionSummary(item.question)}
                  </p>
                  <p className="t-meta mt-0.5 text-fg-muted">
                    {[
                      questionTypes(item.question),
                      questionMarks(item.question) === 1
                        ? m.question_ui_one_mark()
                        : m.question_ui_marks({
                            count: questionMarks(item.question),
                          }),
                      dayMonth(item.createdAt),
                    ].join(' · ')}
                  </p>
                  {hasTopicOrTags(item, topics) && (
                    <div className="t-meta mt-1">{tagList(item)}</div>
                  )}
                </div>
                {actions(item)}
              </li>
            ))}
          </ul>
          <ListEnd
            fetchNextPage={fetchNextPage}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            isFetchNextPageError={isFetchNextPageError}
          />
        </div>
      )}
      {/* The question editor loads only when its dialog opens (Epo 2026-11-16). */}
      {creating && (
        <Suspense fallback={null}>
          <QuestionDialog
            onClose={() => {
              onCreatingChange(false);
              setBlank(blankQuestion());
            }}
            onSave={(question, tagged) =>
              save({ bank, question, tags: tagged }).then(() => undefined)
            }
            open
            question={blank}
            tags={{ catalog: bankTags, initial: [] }}
            topics={workspaceBank ? topics : undefined}
          />
        </Suspense>
      )}
      {editing && (
        <Suspense fallback={null}>
          <QuestionDialog
            onClose={() => setEditing(null)}
            onSave={(question, tagged) =>
              save({ bank, id: editing.id, question, tags: tagged }).then(
                () => undefined
              )
            }
            open
            question={editing.question}
            tags={{ catalog: bankTags, initial: editing.tags }}
            topics={workspaceBank ? topics : undefined}
          />
        </Suspense>
      )}
      <ConfirmDialog
        body={m.bank_delete_body()}
        confirmLabel={m.action_delete()}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove({ bank, id: deleting.id })}
        open={!!deleting}
        title={m.quiz_delete_question()}
      />
    </section>
  );
}

/** A row's ⋮: edit or delete it. Its clicks stay off the row. */
function RowActions({
  onDelete,
  onEdit,
}: {
  onDelete: () => void;
  onEdit: () => void;
}) {
  return (
    // Only stops the row's click and keys.
    <span
      className="inline-flex"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Popover>
        <PopoverTrigger asChild>
          <ToolbarButton label={m.a11y_more_actions()}>
            <Icon name="moreVertical" />
          </ToolbarButton>
        </PopoverTrigger>
        <ToolbarPopoverContent align="end" className="w-52">
          <MenuItem
            icon={<Icon name="pencil" />}
            label={m.action_edit()}
            onClick={onEdit}
          />
          <MenuItem
            icon={<Icon name="trash" />}
            label={m.action_delete()}
            onClick={onDelete}
          />
        </ToolbarPopoverContent>
      </Popover>
    </span>
  );
}
