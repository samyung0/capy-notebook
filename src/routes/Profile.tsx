import { useMe } from '@/api/hooks';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { Avatar, Badge, Card, Icon } from "@/components/ui";
import { m } from "@/i18n";

export default function Profile() {
  const { data: me } = useMe();
  return (
    <PanelWithInvertedRadius>
      <PageHeader title={m.profile_menu_profile()} />
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="mx-auto max-w-2xl">
          <Card className="flex items-center gap-5 p-5.5" radius="card-lg">
            <Avatar name={me?.name} size={72} src={me?.avatarUrl} />
            <div className="min-w-0">
              <p className="t-large-card-title">{me?.name ?? "—"}</p>
              <p>{me?.email}</p>
              {me?.classLabel && (
                <Badge className="mt-2" size="sm" tone="accent-1">
                  {me.classLabel}
                </Badge>
              )}
            </div>
          </Card>
          <Card className="mt-4 flex items-center gap-3 p-5.5" radius="card-lg">
            <span className="flex h-11 w-11 items-center justify-center rounded-card bg-tint-warning text-tint-warning-fg">
              <Icon name="sparkles" size={20} />
            </span>
            <div>
              <p className="t-card-title">{me?.streak ?? 0}-day streak</p>
              <p className="t-meta text-fg-muted">
                Keep logging in to grow it.
              </p>
            </div>
          </Card>
        </div>
      </div>
    </PanelWithInvertedRadius>
  );
}
