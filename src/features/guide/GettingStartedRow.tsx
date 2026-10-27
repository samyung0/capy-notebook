import { useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useMe, useWorkspaces } from '@/api/hooks';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import type { WorkspaceOpenSearch } from '@/features/materials/openItem';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import {
  GETTING_STARTED_STEPS,
  type GettingStarted,
  type GettingStartedStep,
  hideGettingStarted,
  useGettingStarted,
} from './gettingStarted';
import { startTour } from './tourStore';

const STEP_LABEL: Record<GettingStartedStep, () => string> = {
  chat: m.getting_started_step_chat,
  plan: m.getting_started_step_plan,
  upload: m.getting_started_step_upload,
};

const STEP_SEARCH: Record<GettingStartedStep, WorkspaceOpenSearch> = {
  chat: { chat: 'new' },
  plan: { study: true },
  upload: { add: 'upload' },
};

/** A small progress ring, drawn in the text colour, in the size of a row icon. */
function ProgressRing({ done, total }: { done: number; total: number }) {
  const r = 7.5;
  const length = 2 * Math.PI * r;
  return (
    <svg
      aria-hidden
      className="shrink-0"
      height={19}
      viewBox="0 0 19 19"
      width={19}
    >
      <circle
        cx={9.5}
        cy={9.5}
        fill="none"
        r={r}
        stroke="currentColor"
        strokeOpacity={0.18}
        strokeWidth={2}
      />
      <circle
        cx={9.5}
        cy={9.5}
        fill="none"
        r={r}
        stroke="currentColor"
        strokeDasharray={`${(length * done) / total} ${length}`}
        strokeLinecap="round"
        strokeWidth={2}
        transform="rotate(-90 9.5 9.5)"
      />
    </svg>
  );
}

/**
 * The sidebar's Get started row (human/miscellaneous.md 2026-10-26): shown
 * only in the browser that ran onboarding, until closed or every step is
 * done. Its popover lists the steps; a step's row is its action, in the
 * workspace on screen or else the latest one.
 */
export function GettingStartedRow(props: RowProps) {
  const { data: me } = useMe({ errorBoundary: false });
  const list = useGettingStarted(me?.id);
  return list ? <ListPopover {...props} list={list} /> : null;
}

type RowProps = {
  /** The sidebar's own row look. */
  className: string;
  /** Set in the phone drawer, which closes on navigation. */
  onNavigate?: () => void;
};

function ListPopover({
  className,
  list,
  onNavigate,
}: RowProps & { list: GettingStarted }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { workspaceId } = useParams({ strict: false }) as {
    workspaceId?: string;
  };
  // Shared with the dashboard's list.
  const { data: workspaces } = useWorkspaces(
    { sort: 'accessed' },
    { errorBoundary: false }
  );
  const target = workspaceId ?? workspaces?.[0]?.id;
  const total = GETTING_STARTED_STEPS.length;
  const done = list.done.length;
  const go = (search: WorkspaceOpenSearch) => {
    setOpen(false);
    onNavigate?.();
    if (target)
      void navigate({
        params: { workspaceId: target },
        search,
        to: '/workspaces/$workspaceId',
      });
    else void navigate({ to: '/workspaces' });
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          className={cn(className, open && 'bg-page-hover')}
          // The tour's last step points here.
          data-getting-started-row
          type="button"
        >
          <ProgressRing done={done} total={total} />
          <span className="translate-y-px font-semibold" data-label>
            {m.getting_started_title()}
          </span>
          <span
            className="ml-auto translate-y-px text-fg-muted text-sm"
            data-label
          >
            {done}/{total}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={onNavigate ? 'start' : 'end'}
        className="w-75 gap-0 p-2"
        // The list itself takes focus, so × shows no focus ring on open.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus();
        }}
        side={onNavigate ? 'top' : 'right'}
        sideOffset={12}
      >
        {/* Header, rows and Start tour share one row height, so the gaps
            between them read even. */}
        <div className="flex h-9 items-center gap-2 pl-2">
          <p className="font-semibold">{m.getting_started_title()}</p>
          <span className="text-fg-muted text-sm">
            {m.getting_started_count({
              done: String(done),
              total: String(total),
            })}
          </span>
        </div>
        <ul>
          {GETTING_STARTED_STEPS.map((step) => {
            const finished = list.done.includes(step);
            return (
              <li key={step}>
                <button
                  className="group flex h-9 w-full cursor-pointer items-center gap-3 rounded-button px-2 text-left font-medium text-fg-muted hover:bg-surface-hover-bg hover:text-fg disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-fg-muted"
                  disabled={finished}
                  onClick={() => go(STEP_SEARCH[step])}
                  type="button"
                >
                  <span
                    className={cn(
                      'grid size-4.5 shrink-0 place-items-center rounded-full',
                      finished
                        ? 'bg-tint-success-fg text-surface'
                        : 'border-[1.5px] border-line-strong'
                    )}
                  >
                    {finished && (
                      <Icon name="tick" size={13} strokeWidth={2.6} />
                    )}
                  </span>
                  <span className={cn(finished && 'line-through')}>
                    {STEP_LABEL[step]()}
                  </span>
                  {!finished && (
                    <Icon
                      className="ml-auto opacity-0 group-hover:opacity-100"
                      name="navigationForward"
                    />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        {/* A quiet text action, apart from closing the popover. */}
        <button
          className="mt-2 mb-1 ml-2 w-fit cursor-pointer text-fg-muted text-xs hover:text-fg hover:underline"
          onClick={hideGettingStarted}
          type="button"
        >
          {m.getting_started_hide()}
        </button>
        {target && (
          <div className="mt-1 border-line border-t pt-1">
            {/* A full row, its icon in line with the step circles. */}
            <Button
              className="h-9 w-full justify-start gap-3 px-2"
              iconLeft="route"
              onClick={() => {
                setOpen(false);
                onNavigate?.();
                startTour(target);
              }}
              size="sm"
              variant="ghost-hover"
            >
              {m.getting_started_tour()}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
