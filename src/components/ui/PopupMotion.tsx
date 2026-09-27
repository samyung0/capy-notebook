import { Slot } from 'radix-ui';
import {
  type ComponentProps,
  type Ref,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { cn } from '@/lib/cn';

/** Keeps a closing popup at its last anchor without animating its positioning transform. */
export function PopupMotion({
  asChild = false,
  open,
  children,
  style,
  positionRef,
  positionClassName,
  className,
  onExited,
  ...props
}: Omit<ComponentProps<'div'>, 'ref'> & {
  open: boolean;
  asChild?: boolean;
  positionRef?: Ref<HTMLDivElement>;
  positionClassName?: string;
  onExited?: () => void;
}) {
  const [present, setPresent] = useState(open);
  const [lastOpen, setLastOpen] = useState({ children, style });
  const animationRef = useRef<HTMLDivElement>(null);

  if (open && !present) setPresent(true);
  if (open && (lastOpen.children !== children || lastOpen.style !== style)) {
    setLastOpen({ children, style });
  }

  useLayoutEffect(() => {
    if (open || !present) return;
    let cancelled = false;
    const animations = animationRef.current?.getAnimations() ?? [];
    if (animations.length === 0) {
      setPresent(false);
      onExited?.();
      return;
    }
    // Reduced motion has no animation; fast reopen cancels this removal.
    Promise.allSettled(animations.map((animation) => animation.finished)).then(
      () => {
        if (!cancelled) {
          setPresent(false);
          onExited?.();
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [open, present, onExited]);

  if (!open && !present) return null;
  const Content = asChild ? Slot.Root : 'div';
  return (
    <div
      aria-hidden={!open || undefined}
      className={positionClassName}
      inert={!open}
      ref={positionRef}
      style={open ? style : lastOpen.style}
    >
      <Content
        {...props}
        className={cn(
          'motion-popup motion-blur-in data-[state=closed]:[animation-fill-mode:forwards]',
          className
        )}
        data-state={open ? 'open' : 'closed'}
        ref={animationRef}
      >
        {open ? children : lastOpen.children}
      </Content>
    </div>
  );
}
