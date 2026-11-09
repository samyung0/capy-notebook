import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
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

/** What a strip looks like, for a place that draws it itself. */
export interface FileBannerStrip {
  actions: FileBannerAction[];
  closeable: boolean;
  inline: boolean;
  kind?: string;
  message: string;
  onClose: () => void;
  testId?: string;
  tone: 'neutral' | 'error';
}

export type BannerOutlet = (strip: FileBannerStrip | null) => void;

const StripStack = createContext<{
  outlet: BannerOutlet | null;
  push: (id: string) => () => void;
  setOutlet: (outlet: BannerOutlet | null) => void;
  top: string | undefined;
} | null>(null);

/**
 * Sends the stack's shown strip to `outlet` instead of drawing it, while one is
 * given: an Office editor draws it under its ribbon, which is in its frame.
 */
export function useBannerOutlet(outlet: BannerOutlet | null) {
  const setOutlet = useContext(StripStack)?.setOutlet;
  useEffect(() => {
    if (!(setOutlet && outlet)) return;
    setOutlet(outlet);
    return () => {
      setOutlet(null);
      outlet(null);
    };
  }, [outlet, setOutlet]);
}

/**
 * Shows only the newest strip mounted inside it (a strip whose message
 * changes counts as new); closing or unmounting it reveals the one before.
 */
export function BannerStack({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<string[]>([]);
  const [outlet, setOutletState] = useState<BannerOutlet | null>(null);
  // A function in state is called as an updater: the setter wraps it.
  const setOutlet = useCallback(
    (next: BannerOutlet | null) => setOutletState(() => next),
    []
  );
  const push = useCallback((id: string) => {
    setIds((list) => [...list.filter((other) => other !== id), id]);
    return () => setIds((list) => list.filter((other) => other !== id));
  }, []);
  const value = useMemo(
    () => ({ outlet, push, setOutlet, top: ids.at(-1) }),
    [ids, outlet, push, setOutlet]
  );
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
  const showing = shown && (!stack || stack.top === id);
  const outlet = showing ? stack?.outlet : null;
  // Every render: actions close over their view's state.
  useEffect(() => {
    outlet?.({
      actions,
      closeable,
      inline,
      kind,
      message,
      onClose: () => setClosed(message),
      testId,
      tone,
    });
  });
  useEffect(() => {
    if (!outlet) return;
    return () => outlet(null);
  }, [outlet]);
  if (!showing || outlet) return null;
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
        // Less inset on phones.
        'flex shrink-0 gap-3 border-b pr-1.5 pl-3 text-fg text-sm sm:pr-2 sm:pl-4',
        inline ? 'h-9 items-center' : 'items-start py-1',
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
