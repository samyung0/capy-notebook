import {
  Link,
  linkOptions,
  useNavigate,
  useParams,
} from '@tanstack/react-router';
import { useReviewResult } from '@/api/hooks';
import { ErrorState } from '@/components/app/ErrorState';
import { PagePanel } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { TabContent } from '@/components/app/tabPanel';
import { ErrorAction } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { QuizPageHeader } from '@/features/quizzes/QuizPageHeader';
import {
  ReviewResultBody,
  reviewResultMeta,
} from '@/features/study/ReviewResult';
import { groupName } from '@/features/study/reviewText';
import { m } from '@/i18n';
import { unexpectedErrorId } from '@/lib/errors';
import { waitsForConnection } from '@/lib/online';

/** A review session's result, under Learning / Review. */
export default function ReviewResult() {
  const { sessionId } = useParams({ strict: false }) as { sessionId: string };
  const navigate = useNavigate();
  const { data, error, fetchStatus, isLoading, isError } = useReviewResult(
    sessionId,
    { errorBoundary: false }
  );
  const toReview = () =>
    void navigate({ search: { tab: 'review' }, to: '/learning' });

  if (waitsForConnection(fetchStatus, data))
    return (
      <PagePanel>
        <QueryPausedState className="h-full" />
      </PagePanel>
    );
  if (isLoading)
    return (
      <PagePanel>
        <div className="h-full p-6">
          <Skeleton className="h-full w-full" />
        </div>
      </PagePanel>
    );
  if (isError || !data)
    return (
      <PagePanel>
        <ErrorState
          action={
            <ErrorAction asChild back>
              <Link preload="intent" search={{ tab: 'review' }} to="/learning">
                {m.quiz_back()}
              </Link>
            </ErrorAction>
          }
          errorId={unexpectedErrorId(error)}
          title={m.review_result_unavailable()}
          variant="page"
        />
      </PagePanel>
    );

  const s = data.session;
  return (
    <PagePanel
      header={
        <QuizPageHeader
          meta={reviewResultMeta(s)}
          metaClassName="text-fg-secondary text-sm"
          onBack={toReview}
          title={groupName(s.group, s.chapterName) || s.workspaceName}
          trail={[
            { label: m.nav_learning(), link: linkOptions({ to: '/learning' }) },
            {
              label: m.learning_tab_review(),
              link: linkOptions({ search: { tab: 'review' }, to: '/learning' }),
            },
          ]}
        />
      }
    >
      <TabContent>
        <ReviewResultBody
          onAgain={() =>
            navigate({
              params: { workspaceId: s.workspaceId },
              search: {
                chapterId: s.chapterId,
                from: 'review',
                group: s.group,
                reviewMode: s.mode,
              },
              to: '/learning/review/$workspaceId',
            })
          }
          result={data}
        />
      </TabContent>
    </PagePanel>
  );
}
