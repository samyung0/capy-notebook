import { Link } from '@tanstack/react-router';
import { Panel } from '@/components/app/layout';
import { Button } from '@/components/ui/Button';
import { m } from '@/i18n';
import { ErrorState } from './ErrorState';

/** Non-disclosing empty state for private/missing shared resources. */
export function WorkspaceError({
  title = m.error_private_title(),
  description = m.error_private_body(),
  backTo,
  backLabel = m.error_action_go_back(),
}: {
  title?: string;
  backTo?: string;
  backLabel?: string;
  description?: string;
}) {
  return (
    <Panel sectionClassName="items-center justify-center h-full">
      <ErrorState
        action={
          backTo ? (
            <Link preload="intent" to={backTo}>
              <Button iconLeft="chevronLeft" variant="ghost">
                {backLabel}
              </Button>
            </Link>
          ) : undefined
        }
        description={description}
        testId="private-or-unavailable"
        title={title}
        variant="page"
      />
    </Panel>
  );
}
