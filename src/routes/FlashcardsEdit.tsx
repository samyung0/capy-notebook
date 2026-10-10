import {
  linkOptions,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { useMaterial } from '@/api/hooks';
import { isMissing } from '@/api/queryClient';
import { ErrorState } from '@/components/app/ErrorState';
import { PanelWithInvertedRadius } from '@/components/app/layout';
import { TopInsetBar } from '@/components/app/TopInsetBar';
import { TabContent } from '@/components/app/tabPanel';
import { Skeleton } from '@/components/ui/feedback';
import { FlashcardsEditor } from '@/features/flashcards/FlashcardsEditor';
import {
  type FlashcardsElement,
  flashcardsElementToCards,
} from '@/features/materials/document';
import { SourcesLine } from '@/features/materials/MaterialAttributionFooter';
import { blockHomeCrumb, QuizPageHeader } from '@/features/quizzes/QuizPage';
import { m } from '@/i18n';

/** `/flashcards/$flashcardSetId/edit`: the card grid on its own page, where a
 * note's embedded set is edited, as the quiz edit page edits a quiz. */
export default function FlashcardsEdit() {
  const params = useParams({ strict: false });
  const setId = (params as { flashcardSetId: string }).flashcardSetId;
  const navigate = useNavigate();
  const { returnTo } = useSearch({
    from: '/auth-shell/flashcards/$flashcardSetId/edit',
  });
  // Other failures without data go to the error boundary.
  const { data: material, error } = useMaterial(setId, {
    errorBoundary: 'unlessMissing',
  });
  const block = material?.content.value.find(
    (node): node is FlashcardsElement => node.type === 'flashcards'
  );

  return (
    <PanelWithInvertedRadius
      header={
        <QuizPageHeader
          className="px-6 pt-6 pb-2 sm:px-6 sm:pt-6 lg:px-6 xl:px-6"
          onBack={() =>
            void navigate({ href: returnTo ?? '/files?tab=blocks' })
          }
          title={m.flashcards_edit()}
          topBar={<TopInsetBar className="hidden shrink-0 lg:flex" />}
          trail={
            material
              ? [
                  blockHomeCrumb(material),
                  {
                    label: material.title,
                    link: linkOptions({
                      params: { flashcardSetId: setId },
                      to: '/flashcards/$flashcardSetId',
                    }),
                  },
                ]
              : []
          }
        />
      }
    >
      <TabContent>
        {isMissing(error) ? (
          <ErrorState
            description={m.error_private_body()}
            testId="private-or-unavailable"
            title={m.error_private_title()}
            variant="page"
          />
        ) : material ? (
          <>
            <FlashcardsEditor
              cards={block ? flashcardsElementToCards(block) : []}
              key={setId}
              revision={material.revision}
              setId={setId}
              showTitle={false}
              title={material.parentMaterialId ? '' : material.title}
            />
            <SourcesLine
              className="mt-16 pb-4"
              provenance={material.provenance}
            />
          </>
        ) : (
          <Skeleton className="h-64 w-full" />
        )}
      </TabContent>
    </PanelWithInvertedRadius>
  );
}
