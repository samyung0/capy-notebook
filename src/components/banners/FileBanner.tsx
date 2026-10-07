import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { useHorizontalWheelScroll } from '@/lib/useHorizontalWheelScroll';

export interface FileBannerAction {
  disabled?: boolean;
  label: string;
  onClick: () => void;
}

const StripStack = createContext<{
  push: (id: string) => () => void;
  top: string | undefined;
} | null>(null);

/**
 * Shows only the newest strip mounted inside it (a strip whose message
 * changes counts as new); closing or unmounting it reveals the one before.
 */
export function BannerStack({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<string[]>([]);
  const push = useCallback((id: string) => {
    setIds((list) => [...list.filter((other) => other !== id), id]);
    return () => setIds((list) => list.filter((other) => other !== id));
  }, []);
  const value = useMemo(() => ({ push, top: ids.at(-1) }), [ids, push]);
  return <StripStack.Provider value={value}>{children}</StripStack.Provider>;
}

/**
 * Flat strip under a file or material header. Closing hides it until the
 * message changes or the page remounts it; nothing is remembered. `inline`
 * keeps it one row high: the message scrolls sideways and the actions take
 * the close button's place. `closeable={false}` leaves the button out.
 * Inside a `BannerStack` only the newest strip shows. `kind` names the
 * strip's state for tests (`data-kind`).
 */
export function FileBanner({
  message,
  tone = 'neutral',
  actions = [],
  closeable = true,
  inline = false,
  kind,
  testId,
}: {
  message: string;
  tone?: 'neutral' | 'error';
  actions?: FileBannerAction[];
  closeable?: boolean;
  inline?: boolean;
  kind?: string;
  testId?: string;
}) {
  const [closed, setClosed] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useHorizontalWheelScroll(scrollRef);
  const id = useId();
  const stack = useContext(StripStack);
  const push = stack?.push;
  const shown = closed !== message;
  // `message` re-pushes a changed strip so it counts as the newest.
  useLayoutEffect(
    () => (push && shown ? push(id) : undefined),
    [push, id, shown, message]
  );
  if (!shown || (stack && stack.top !== id)) return null;
  const buttons = actions.map((action) => (
    <Button
      className="h-7 px-2 underline underline-offset-3 hover:bg-fg/5"
      disabled={action.disabled}
      key={action.label}
      onClick={action.onClick}
      size="sm"
      variant="ghost"
    >
      {action.label}
    </Button>
  ));
  const close = closeable && (
    <IconButton
      className="shrink-0 rounded-md opacity-75 hover:bg-fg/5 hover:opacity-100"
      icon="x"
      label={m.action_close()}
      onClick={() => setClosed(message)}
      size="xs"
    />
  );
  return (
    <div
      className={cn(
        'flex shrink-0 gap-3 border-b pr-2 pl-4 text-fg text-sm',
        inline ? 'h-10 items-center' : 'items-start py-2',
        tone === 'error'
          ? 'border-solid-error/40 bg-tint-error'
          : 'border-divider bg-surface-hover-bg'
      )}
      data-kind={kind}
      data-testid={testId}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      {inline ? (
        <>
          <div
            className="scroll-fade-x min-w-0 flex-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            ref={scrollRef}
          >
            {message}
          </div>
          {buttons.length ? (
            <div className="flex shrink-0 gap-1">{buttons}</div>
          ) : (
            close
          )}
        </>
      ) : (
        <>
          <div className="min-w-0 flex-1 pt-0.5">
            <p>{message}</p>
            {buttons.length > 0 && (
              <div className="mt-1 -mr-8.5 flex flex-wrap justify-end gap-1">
                {buttons}
              </div>
            )}
          </div>
          {close}
        </>
      )}
    </div>
  );
}
