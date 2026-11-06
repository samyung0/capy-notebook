import { type ReactNode, useEffect, useSyncExternalStore } from 'react';
import { showErrorToast } from '@/api/queryClient';
import { Icon } from '@/components/ui/Icon';
import {
  CALLOUT_CONTAINER_CLASS,
  CALLOUT_ICON,
  CALLOUT_VARIANT_CLASS,
  type CalloutVariant,
} from '@/features/notes/richBlockConfig';
import { cn } from '@/lib/cn';

/** Streamdown loads with the first answer to draw, or ahead of it on intent,
 * not with the page (about 118 KB gzipped). 'failed': it couldn't load. */
let body: typeof import('./proseBody').ProseBody | 'failed' | undefined;
let loading: Promise<void> | undefined;
const waiting = new Set<() => void>();
const settle = (next: typeof body) => {
  body = next;
  for (const notify of waiting) notify();
};

const load = () =>
  import('./proseBody').then(
    (module) => settle(module.ProseBody),
    (error: unknown) => {
      settle('failed');
      // Online it's a release that removed the file, which a reload fixes. Offline
      // the page says so already; back online it tries once more, and the
      // browser may keep the failed import until a reload (error-handling.md).
      if (navigator.onLine) showErrorToast(error);
      else
        addEventListener(
          'online',
          () => {
            loading = load();
          },
          { once: true }
        );
    }
  );

export function loadProse() {
  loading ??= load();
  return loading;
}

const subscribe = (notify: () => void) => {
  waiting.add(notify);
  return () => waiting.delete(notify);
};
const readBody = () => body;

/** Streamdown's component once loaded. */
export const useProseBody = () =>
  useSyncExternalStore(subscribe, readBody, readBody);

/** A chat answer's Markdown (`ProseBody`). Until its code is here the words hold
 * their place unseen, so no raw Markdown flashes and little moves when it lands;
 * if it can't load they show as they are, which is still the answer. */
export function Prose({
  text,
  className,
  muted,
}: {
  text: string;
  className?: string;
  muted?: boolean;
}) {
  const Body = useProseBody();
  useEffect(() => {
    if (!Body) void loadProse();
  }, [Body]);
  return (
    <div
      className={cn(
        'streamdown-body max-w-none',
        muted && 'text-fg-secondary',
        className
      )}
    >
      {Body && Body !== 'failed' ? (
        <Body text={text} />
      ) : (
        <p
          className={cn('whitespace-pre-wrap', !Body && 'invisible')}
          data-prose={Body ?? 'loading'}
        >
          {text}
        </p>
      )}
    </div>
  );
}

export interface CalloutProps {
  kind: CalloutVariant;
  text: string;
  title: string;
}

export function Callout({ props }: { props: CalloutProps }) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 px-3 py-2.5',
        CALLOUT_CONTAINER_CLASS,
        CALLOUT_VARIANT_CLASS[props.kind]
      )}
    >
      <Icon className="mt-px" name={CALLOUT_ICON[props.kind]} size={16} />
      <div className="min-w-0 flex-1">
        <p className="mb-1 font-semibold text-[13.5px]" data-copy="strong">
          {props.title}
        </p>
        <Prose className="text-fg text-sm" text={props.text} />
      </div>
    </div>
  );
}

export function Reveal({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <details className="group">
      <summary
        className="flex w-fit cursor-pointer list-none items-center gap-1.5 font-semibold text-link text-sm hover:text-link-hover [&::-webkit-details-marker]:hidden"
        data-copy="strong"
      >
        <Icon
          className="transition-transform group-open:rotate-90"
          name="chevronRight"
          size={12}
        />
        {title}
      </summary>
      <div className="mt-3 flex flex-col gap-4 pl-3 text-fg-secondary text-sm">
        {children}
      </div>
    </details>
  );
}
