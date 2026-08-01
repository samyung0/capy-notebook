import { useState } from 'react';
import { USE_MSW } from '@/api/auth';
import { useIntegrations } from '@/api/hooks';
import { Button } from '@/components/ui/Button';
import { m } from '@/i18n';
import { useProviderConnect } from '@/lib/useProviderConnect';

const DISMISS_KEY = 'evo_cloud_connect_dismissed';

export function CloudConnectBanner() {
  const { data: integrations } = useIntegrations();
  const connectProvider = useProviderConnect();
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISS_KEY) === '1'
  );

  if (dismissed || USE_MSW) return null;
  if (integrations?.google && integrations?.microsoft) return null;

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  }

  function connect() {
    void connectProvider(integrations?.google ? 'microsoft' : 'google');
  }

  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface px-4 py-3">
      <div>
        <p className="t-subtitle font-bold">{m.cloud_connect_title()}</p>
        <p className="mt-1">{m.cloud_connect_body()}</p>
      </div>
      <div className="flex gap-2">
        <Button onClick={dismiss} size="sm" variant="ghost">
          {m.cloud_connect_dismiss()}
        </Button>
        <Button onClick={connect} size="sm">
          {m.cloud_connect_action()}
        </Button>
      </div>
    </div>
  );
}
