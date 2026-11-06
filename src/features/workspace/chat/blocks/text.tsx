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

/** How long an answer's words stay unseen for its Markdown code. */
const HOLD_MS = 2000;
/** The idle load's latest start, for a page that never goes idle. */
const IDLE_LIMIT_MS = 5000;
/** Without requestIdleCallback (Safari): this long after the open. */
const IDLE_FALLBACK_MS = 2000;

/** Streamdown loads at idle after a workspace opens, with the first answer to
 * draw, or ahead of it on intent, never in the page's first load (about 118 KB
 * gzipped). Until then: nothing yet, 'slow' past the hold, 'failed' if it
 * couldn't load. */
let body:
  | typeof import('./proseBody').ProseBody
  | 'slow'
  | 'failed'
  | undefined;
const waiting = new Set<() => void>();
const settle = (next: typeof body) => {
  body = next;
  for (const notify of waiting) notify();
};

let importing: Promise<void> | undefined;
const importBody = () => {
  importing ??= import('./proseBody').then(
    (module) => settle(module.ProseBody),
    (error: unknown) => {
      importing = undefined;
      throw error;
    }
  );
  return importing;
};

/** On intent: offline it asks for nothing, since the browser would keep the
 * failure until a reload, and a failure says nothing. Only an answer that needs
 * the code says it couldn't load (`loadProse`). */
export function preloadProse() {
  if (navigator.onLine === false) return;
  importBody().catch(() => undefined);
}

/** After a workspace opens, when the page is first idle (Q681): saved chats then
 * read formatted offline. Offline then, it waits for the connection. Returns the
 * cancel. */
export function preloadProseWhenIdle() {
  const go = () => {
    if (navigator.onLine === false)
      addEventListener('online', preloadProse, { once: true });
    else preloadProse();
  };
  if (typeof requestIdleCallback !== 'function') {
    const timer = setTimeout(go, IDLE_FALLBACK_MS);
    return () => {
      clearTimeout(timer);
      removeEventListener('online', preloadProse);
    };
  }
  const idle = requestIdleCallback(go, { timeout: IDLE_LIMIT_MS });
  return () => {
    cancelIdleCallback(idle);
    removeEventListener('online', preloadProse);
  };
}

let needed: Promise<void> | undefined;

/** For an answer on screen. */
export function loadProse() {
  needed ??= (async () => {
    const hold = setTimeout(() => {
      if (!body) settle('slow');
    }, HOLD_MS);
    try {
      await importBody();
    } catch (error) {
      settle('failed');
      // Online it's a release that removed the file, which a reload fixes. Offline
      // the page says so already; back online it tries once more, and the
      // browser may keep the failed import until a reload (error-handling.md).
      if (navigator.onLine === false)
        addEventListener(
          'online',
          () => {
            needed = undefined;
            void loadProse();
          },
          { once: true }
        );
      else showErrorToast(error);
    } finally {
      clearTimeout(hold);
    }
  })();
  return needed;
}

const subscribe = (notify: () => void) => {
  waiting.add(notify);
  return () => waiting.delete(notify);
};
const readBody = () => body;

/** Streamdown's component once loaded, else what the wait has come to. */
export const useProseBody = () =>
  useSyncExternalStore(subscribe, readBody, readBody);

/** A chat answer's Markdown (`ProseBody`). Its words hold their place unseen for
 * a moment, so no raw Markdown flashes and little moves when the code lands. Past
 * the hold, or if it can't load, they show as they are, which is still the answer. */
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
      {typeof Body === 'function' ? (
        <Body text={text} />
      ) : (
        <p
          aria-busy={Body !== 'failed' || undefined}
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
