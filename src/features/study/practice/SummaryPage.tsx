import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useStudyTopics, useWorkspace } from '@/api/hooks';
import type { SummaryTopic } from '@/api/types';
import { InlineErrorState } from '@/components/app/ErrorState';
import { Button } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { unexpectedErrorId } from '@/lib/errors';
import { LabelChip, topicSquares } from '../topicLabels';
import { MakePractice } from './MakePractice';
import { studyView } from './studyView';
import { PracticeFrame } from './TopicPractice';

const RESULT: Record<string, string> = {
  partial: 'bg-solid-warning',
  right: 'bg-solid-success',
  unattempted: 'bg-fg-muted/30',
  wrong: 'bg-solid-error',
};

/** Study → Summary (boards G5, M1), for whoever practises here: each topic's
 * label, what it rests on and every question's result, grey when not attempted, with Practise. Assignments'
 * overall joins it once they exist; a section with nothing to show is not
 * drawn. */
export function SummaryPage({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const { data: ws } = useWorkspace(workspaceId);
  const { data, error, isError, isPending, refetch } = useStudyTopics(
    workspaceId,
    { errorBoundary: false }
  );
  const [making, setMaking] = useState(false);
  const practise = (topic: SummaryTopic) =>
    navigate({
      search: {
        group: topic.group,
        study: 'practice' as const,
        topicId: topic.topicId,
      },
      to: '.',
    });
  return (
    <PracticeFrame>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2.25">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
          <h1 className="t-page-title">{m.study_panel_summary()}</h1>
          <span className="t-meta text-fg-muted">{ws?.name}</span>
        </div>
        <Button iconLeft="plus" onClick={() => setMaking(true)}>
          {m.practice_make_own()}
        </Button>
      </div>
      {isPending ? (
        <SkeletonList count={4} rowHeight={44} />
      ) : isError || !data ? (
        <InlineErrorState
          errorId={unexpectedErrorId(error)}
          message={m.summary_error()}
          onRetry={() => void refetch()}
        />
      ) : data.enabled ? (
        data.topics.length > 0 && (
          <section className="mt-5">
            <h2 className="t-subtitle">{m.summary_topics()}</h2>
            <ul className="mt-1">
              {data.topics.map((topic) => (
                <TopicRow
                  key={topic.topicId ?? topic.group}
                  onPractise={() => practise(topic)}
                  topic={topic}
                />
              ))}
            </ul>
          </section>
        )
      ) : (
        <div className="mt-8 flex flex-col items-start gap-3">
          <p className="text-fg-secondary">{m.summary_hidden()}</p>
          <Button
            onClick={() =>
              navigate({ search: { settings: 'study' as const }, to: '.' })
            }
            variant="outline"
          >
            {m.workspace_settings()}
          </Button>
        </div>
      )}
      {making && (
        <MakePractice
          initialTopicId={weakestTopicId(data?.topics ?? [])}
          onClose={() => setMaking(false)}
          onlyYou={!studyView(ws).canEdit}
          workspaceId={workspaceId}
        />
      )}
    </PracticeFrame>
  );
}

/** Where Make my own practice starts: a weak topic with nothing unseen left,
 * then the weak topic with the fewest right. */
function weakestTopicId(topics: SummaryTopic[]) {
  const weak = topics.filter((t) => t.label === 'needs_practice' && t.topicId);
  return (
    weak.find((t) => t.unattempted === 0) ??
    [...weak].sort((a, b) => a.right - b.right)[0]
  )?.topicId;
}

function TopicRow({
  onPractise,
  topic,
}: {
  onPractise: () => void;
  topic: SummaryTopic;
}) {
  const evidence =
    topic.asked > 0
      ? m.summary_right({ asked: topic.asked, right: topic.right })
      : '';
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-divider border-b py-2 md:min-h-11 md:grid-cols-[minmax(0,1fr)_132px_110px_130px_72px] md:py-1">
      <span className="truncate font-semibold">
        {topic.group === 'others' ? m.topic_other_files() : topic.name}
      </span>
      <span className="col-start-1 row-start-2 mt-1 flex flex-wrap items-center gap-2 md:contents">
        <span>
          <LabelChip label={topic.label} />
        </span>
        <span className="t-meta text-fg-muted">{evidence}</span>
        <span aria-hidden className="hidden gap-[3px] md:flex">
          {topicSquares(topic).map((result, i) => (
            <span
              className={cn('size-2 shrink-0 rounded-[1px]', RESULT[result])}
              key={`${i}-${result}`}
            />
          ))}
        </span>
      </span>
      <Button
        className="col-start-2 row-span-2 row-start-1 justify-self-end md:col-start-auto md:row-span-1 md:row-start-auto"
        onClick={onPractise}
        size="sm"
        variant="outline"
      >
        {m.practice_practise()}
      </Button>
    </li>
  );
}
