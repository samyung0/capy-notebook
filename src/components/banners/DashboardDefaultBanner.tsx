import { m } from '@/i18n';
import { Card } from '../ui/Card';
import { Icon } from '../ui/Icon';

export default function DefaultBanner() {
  return (
    <Card
      className="relative block min-h-fit overflow-hidden bg-tint-accent-1 hover:bg-tint-accent-1"
      radius="card-lg"
    >
      <div className="relative z-10 flex flex-col gap-1 xl:max-w-[80%]">
        <p className="t-subtitle font-bold text-tint-accent-1-fg">
          {m.dashboard_banner_title()}
        </p>
        <p className="mt-1 text-tint-accent-1-fg">
          {m.dashboard_banner_body()}
        </p>
      </div>
      <Icon
        className="absolute -top-3 -right-4 text-tint-accent-1-fg/15"
        name="sparkles"
        size={120}
        strokeWidth={1.5}
      />
    </Card>
  );
}
