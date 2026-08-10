import { Link } from '@tanstack/react-router';
import { Panel } from '@/components/app/layout';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';

/** Non-disclosing empty state for private/missing shared resources. */
export function WorkspaceError({
  title = 'This item is private or unavailable.',
  description = 'You may not have access, or the link may no longer be valid.',
  backTo,
  backLabel = 'Go back',
}: {
  title?: string;
  backTo?: string;
  backLabel?: string;
  description?: string;
}) {
  return (
    <Panel sectionClassName="items-center justify-center h-full">
      <div
        className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-4 px-6 text-center"
        data-testid="private-or-unavailable"
      >
        <span className="flex size-15 items-center justify-center rounded-card-lg bg-tint-error text-tint-error-fg">
          <Icon className="size-7" name="warning" />
        </span>
        <h1 className="t-large-card-title mt-1">{title}</h1>
        <p className="t-subtitle font-medium">{description}</p>
        {backTo && (
          <Link className="mt-4" preload="intent" to={backTo}>
            <Button iconLeft="chevronLeft" variant="ghost">
              {backLabel}
            </Button>
          </Link>
        )}
      </div>
    </Panel>
  );
}
