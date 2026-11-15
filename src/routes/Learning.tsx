import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { PERSONAL_BANK } from '@/api/itemBanks';
import { PageBody, PageHeader, PagePanel } from '@/components/app/layout';
import { TabContent } from '@/components/app/tabPanel';
import { PageButton } from '@/components/ui/Button';
import { Tabs } from '@/components/ui/Tabs';
import { ItemBankList } from '@/features/itemBanks/ItemBankList';
import { LearningOverviewTab } from '@/features/study/LearningOverview';
import { StudyHistory } from '@/features/study/StudyHistory';
import { m } from '@/i18n';
import type { LearningTab } from '@/lib/tabSearch';

export default function Learning() {
  const { tab = 'overview' } = useSearch({ strict: false }) as {
    tab?: LearningTab;
  };
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  return (
    <PagePanel
      header={
        <PageHeader
          // My bank's New question (Epo 2026-11-14, mock BankPage).
          actions={
            tab === 'bank' && (
              <PageButton iconLeft="plus" onClick={() => setCreating(true)}>
                {m.bank_new_question()}
              </PageButton>
            )
          }
          className="justify-between"
          title={m.nav_study()}
        />
      }
    >
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
          { label: m.learning_tab_history(), value: 'history' },
          { label: m.question_ui_question_bank(), value: 'bank' },
        ]}
        value={tab}
      />
      {/* History lays out as Files does: toolbar right under the tabs, then
       * the table in the list's padding. */}
      {tab === 'history' ? (
        <StudyHistory />
      ) : tab === 'bank' ? (
        <PageBody className="pt-0 sm:pt-0">
          <ItemBankList
            bank={PERSONAL_BANK}
            creating={creating}
            onCreatingChange={setCreating}
          />
        </PageBody>
      ) : (
        <TabContent fill>
          <LearningOverviewTab />
        </TabContent>
      )}
    </PagePanel>
  );
}
