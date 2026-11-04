import { useNavigate, useSearch } from '@tanstack/react-router';
import { PageHeader, PagePanel } from '@/components/app/layout';
import { TabContent } from '@/components/app/tabPanel';
import { Tabs } from '@/components/ui/Tabs';
import { AllResults } from '@/features/study/AllResults';
import { ReviewTab } from '@/features/study/ReviewTab';
import { m } from '@/i18n';
import type { LearningTab } from '@/lib/tabSearch';

export default function Learning() {
  const { tab = 'review' } = useSearch({ strict: false }) as {
    tab?: LearningTab;
  };
  const navigate = useNavigate();
  return (
    <PagePanel header={<PageHeader title={m.nav_learning()} />}>
      <Tabs
        className="page-tabs-px"
        onChange={(next) =>
          navigate({
            replace: true,
            search: { tab: next as LearningTab },
            to: '/learning',
          })
        }
        tabs={[
          { label: m.learning_tab_review(), value: 'review' },
          { label: m.learning_tab_results(), value: 'results' },
        ]}
        value={tab}
      />
      {/* All results lays out as Files does: toolbar right under the tabs,
       * then the table in the list's padding. */}
      {tab === 'results' ? (
        <AllResults />
      ) : (
        <TabContent fill>
          <ReviewTab />
        </TabContent>
      )}
    </PagePanel>
  );
}
