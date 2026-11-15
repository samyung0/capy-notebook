import { useState } from 'react';
import { PageButton } from '@/components/ui/Button';
import { PracticeFrame, StudyTabs } from '@/features/study/practice/studyPage';
import { m } from '@/i18n';
import { ItemBankList } from './ItemBankList';

/** A class's Question bank, the fourth tab of its staff's Study (Epo
 * 2026-11-14, mock A): New question in the header, then the bank. */
export function WorkspaceBankPage({ workspaceId }: { workspaceId: string }) {
  const [creating, setCreating] = useState(false);
  return (
    <PracticeFrame>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2.25">
        <h1 className="t-page-title">{m.workspace_tab_study()}</h1>
        <PageButton iconLeft="plus" onClick={() => setCreating(true)}>
          {m.bank_new_question()}
        </PageButton>
      </div>
      <StudyTabs staff value="bank" />
      <ItemBankList
        bank={workspaceId}
        creating={creating}
        onCreatingChange={setCreating}
      />
    </PracticeFrame>
  );
}
