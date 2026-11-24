import { useNavigate } from '@tanstack/react-router';
import { useStudyTopics } from '@/api/hooks';
import type { SummaryTopic } from '@/api/types';
import { InlineErrorState } from '@/components/app/ErrorState';
import { SkeletonList } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { unexpectedErrorId } from '@/lib/errors';
import { studyLink } from '../studyRoutes';
import { LabelChip, TopicSquares } from '../topicLabels';

/** Study's Overview, whoever practises (boards G5, M1; Study's own page until
 * Epo 2026-11-13): their standing per topic, each topic's label, what it rests
 * on and every question's result, grey when not attempted. A row opens the
 * topic's questions, each practised there (Epo 2026-11-22: the row is the
 * practise button). Not drawn without a topic. */
export function TopicsSection({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const { data, error, isError, isPending, refetch } = useStudyTopics(
    workspaceId,
    { errorBoundary: false }
  );
  const open = (topic: SummaryTopic) =>
    navigate(
      studyLink(workspaceId, 'summary', { topic: topic.topicId ?? 'others' })
    );
  if (isPending) return <SkeletonList count={4} rowHeight={44} />;
  if (isError || !data)
    return (
      <InlineErrorState
        errorId={unexpectedErrorId(error)}
        message={m.summary_error()}
        onRetry={() => void refetch()}
      />
    );
  if (!data.topics.length) return null;
  return (
    <section>
      <h2 className="t-subtitle">{m.summary_topics()}</h2>
      <ul className="mt-1">
        {data.topics.map((topic) => (
          <TopicRow
            key={topic.topicId ?? topic.group}
            onOpen={() => void open(topic)}
            topic={topic}
          />
        ))}
      </ul>
    </section>
  );
}

/** Where Make my own practice starts: a weak topic with nothing unseen left,
 * then the weak topic with the fewest right. */
export function weakestTopicId(topics: SummaryTopic[]) {
  const weak = topics.filter((t) => t.label === 'needs_practice' && t.topicId);
  return (
    weak.find((t) => t.unattempted === 0) ??
    [...weak].sort((a, b) => a.right - b.right)[0]
  )?.topicId;
}

function TopicRow({
  onOpen,
  topic,
}: {
  onOpen: () => void;
  topic: SummaryTopic;
}) {
  const evidence =
    topic.asked > 0
      ? m.summary_right({ asked: topic.asked, right: topic.right })
      : '';
  return (
    <li>
      <button
        className="grid w-full grid-cols-[minmax(0,1fr)] items-center gap-x-3 border-divider border-b py-2 text-left outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset md:min-h-11 md:grid-cols-[minmax(0,1fr)_132px_110px_130px] md:py-1"
        onClick={onOpen}
        type="button"
      >
        <span className="truncate font-semibold">
          {topic.group === 'others' ? m.topic_other_files() : topic.name}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-2 md:contents">
          <span>
            <LabelChip label={topic.label} />
          </span>
          <span className="t-meta text-fg-muted">{evidence}</span>
          <TopicSquares className="hidden md:flex" topic={topic} />
        </span>
      </button>
    </li>
  );
}
