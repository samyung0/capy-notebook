import { useNavigate, useSearch } from '@tanstack/react-router';
import { PageHeader, PagePanel } from '@/components/app/layout';
import { TabContent } from '@/components/app/tabPanel';
import { Tabs } from '@/components/ui/Tabs';
import { AllResults } from '@/features/study/AllResults';
import { LearningOverviewTab } from '@/features/study/LearningOverview';
import { PastReviews } from '@/features/study/PastReviews';
import { m } from '@/i18n';
import type { LearningTab } from '@/lib/tabSearch';

export default function Learning() {
  const { tab = 'overview' } = useSearch({ strict: false }) as {
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
          { label: m.learning_tab_overview(), value: 'overview' },
          { label: m.learning_tab_past(), value: 'past' },
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
          {tab === 'past' ? <PastReviews /> : <LearningOverviewTab />}
        </TabContent>
      )}
    </PagePanel>
  );
}
