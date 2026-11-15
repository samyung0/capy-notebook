import { useTopics } from '@/api/hooks';
import { PERSONAL_BANK } from '@/api/itemBanks';
import type { ItemBankQuestion, Topic } from '@/api/types';
import {
  FilterPopover,
  type FilterSection,
  toggleValue,
} from '@/components/app/ListToolbar';
import { Badge } from '@/components/ui/Badge';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** A class bank's topics, for its questions' badges, Topic filter and Topic
 * field; My bank has none. */
export const useBankTopics = (bank: string) => {
  const { data = [] } = useTopics(bank === PERSONAL_BANK ? '' : bank, {
    errorBoundary: false,
  });
  return data;
};

/** A class bank question's own topics, those the class still holds, in its
 * topic order. */
const ownTopics = (item: ItemBankQuestion, topics: Topic[]) =>
  topics.filter((topic) => item.question.topicIds?.includes(topic.id));

/** A bank question's topics as coloured badges, then its tags as plain text
 * (Epo 2026-11-15, board BankTopics). Wrapped, never cut. */
export function TopicAndTags({
  className,
  item,
  topics,
}: {
  className?: string;
  item: ItemBankQuestion;
  topics: Topic[];
}) {
  return (
    <span
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-1 whitespace-normal',
        className
      )}
    >
      {ownTopics(item, topics).map((topic) => (
        <Badge className="rounded-md" key={topic.id} size="sm" tone="accent-1">
          {topic.name}
        </Badge>
      ))}
      {item.tags.map((tag) => (
        <span key={tag}>{tag}</span>
      ))}
    </span>
  );
}

/** The question shows a topic or a tag. */
export const hasTopicOrTags = (item: ItemBankQuestion, topics: Topic[]) =>
  item.tags.length > 0 || ownTopics(item, topics).length > 0;

interface BankFilterProps {
  /** Every tag the bank's questions carry. */
  bankTags: string[];
  onTags: (tags: string[]) => void;
  onTopicIds: (ids: string[]) => void;
  tags: string[];
  topicIds: string[];
  /** The class's topics; none for My bank or a class without topics. */
  topics: Topic[];
}

/** The bank's sections in one Filter (Epo 2026-11-15): Topic when the class
 * has topics, then Tags. */
export const bankFilterSections = ({
  bankTags,
  onTags,
  onTopicIds,
  tags,
  topicIds,
  topics,
}: BankFilterProps): FilterSection[] => [
  ...(topics.length > 0
    ? [
        {
          key: 'topics',
          label: m.quiz_editor_topic(),
          onToggle: (value: string) => onTopicIds(toggleValue(topicIds, value)),
          options: topics.map((topic) => ({
            label: topic.name,
            value: topic.id,
          })),
          selected: topicIds,
        },
      ]
    : []),
  {
    emptyLabel: m.common_nothing_yet(),
    key: 'tags',
    label: m.common_tags(),
    onToggle: (value: string) => onTags(toggleValue(tags, value)),
    options: bankTags.map((tag) => ({ label: tag, value: tag })),
    selected: tags,
  },
];

/** A bank list's one Filter button, as Practice's (Epo 2026-11-15). */
export function BankFilter(props: BankFilterProps) {
  const { onTags, onTopicIds } = props;
  return (
    <FilterPopover
      filters={bankFilterSections(props)}
      onResetFilters={() => {
        onTopicIds([]);
        onTags([]);
      }}
    />
  );
}
