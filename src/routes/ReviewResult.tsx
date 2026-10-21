import {
  Link,
  linkOptions,
  useNavigate,
  useParams,
} from '@tanstack/react-router';
import { useReviewResult } from '@/api/hooks';
import { ErrorState } from '@/components/app/ErrorState';
import { PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { TopInsetBar } from '@/components/app/TopInsetBar';
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
      <PanelWithInvertedRadius>
        <QueryPausedState className="h-full" />
      </PanelWithInvertedRadius>
    );
  if (isLoading)
    return (
      <PanelWithInvertedRadius>
        <div className="h-full p-6">
          <Skeleton className="h-full w-full" />
        </div>
      </PanelWithInvertedRadius>
    );
  if (isError || !data)
    return (
      <PanelWithInvertedRadius>
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
      </PanelWithInvertedRadius>
    );

  const s = data.session;
  return (
    <PanelWithInvertedRadius
      header={
        <QuizPageHeader
          meta={reviewResultMeta(s)}
          metaClassName="text-fg-secondary text-sm"
          onBack={toReview}
          title={groupName(s.group, s.chapterName) || s.workspaceName}
          topBar={<TopInsetBar className="hidden shrink-0 xl:flex" />}
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
      <TabContent wide>
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
    </PanelWithInvertedRadius>
  );
}
