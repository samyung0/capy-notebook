import { Link } from '@tanstack/react-router';
import { Panel } from '@/components/app/layout';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/feedback';

/** Non-disclosing empty state for private/missing shared resources. */
export function LoadingLarge({
  title = 'Loading...',
  backTo,
  backLabel = 'Go back',
}: {
  title?: string;
  backTo?: string;
  backLabel?: string;
}) {
  return (
    <Panel sectionClassName="items-center justify-center h-full">
      <div
        className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-4 px-6 text-center"
        data-testid="loading-large"
      >
        <span>
          <Spinner className="size-7" />
        </span>
        <h1 className="t-large-card-title">{title}</h1>
        {backTo && (
          <Link className="-translate-x-1" preload="intent" to={backTo}>
            <Button iconLeft="chevronLeft" variant="ghost">
              {backLabel}
            </Button>
          </Link>
        )}
      </div>
    </Panel>
  );
}
