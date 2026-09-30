import { useNavigate, useSearch } from '@tanstack/react-router';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { TabContent } from '@/components/app/tabPanel';
import { Tabs } from '@/components/ui/Tabs';
import { DetailsTab } from '@/features/billing/DetailsTab';
import { SubscriptionTab } from '@/features/billing/SubscriptionTab';
import { UsageTab } from '@/features/billing/UsageTab';
import { m } from '@/i18n';
import type { BillingTab } from '@/lib/tabSearch';

export default function Billing() {
  const navigate = useNavigate();
  const { tab = 'usage' } = useSearch({ from: '/auth-shell/billing' });

  return (
    <PanelWithInvertedRadius>
      <PageHeader title={m.billing_title()} />
      <Tabs
        className="px-6"
        onChange={(value) => {
          void navigate({
            replace: true,
            search: { tab: value as BillingTab },
            to: '/billing',
          });
        }}
        tabs={[
          { label: m.billing_tab_usage(), value: 'usage' },
          { label: m.billing_tab_details(), value: 'details' },
          { label: m.subscription_title(), value: 'subscription' },
        ]}
        value={tab}
      />
      <TabContent>
        {tab === 'details' ? (
          <DetailsTab />
        ) : tab === 'subscription' ? (
          <SubscriptionTab />
        ) : (
          <UsageTab />
        )}
      </TabContent>
    </PanelWithInvertedRadius>
  );
}
