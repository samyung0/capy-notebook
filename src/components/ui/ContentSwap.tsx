import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

/** Only the copy key triggers motion; emphasis and unrelated rerenders stay live. */
export function ContentSwap({
  children,
  contentKey,
  kind = 'text',
  className,
}: {
  children: ReactNode;
  contentKey: string;
  kind?: 'text' | 'icon';
  className?: string;
}) {
  const [snapshot, setSnapshot] = useState({
    content: children,
    key: contentKey,
  });
  const [outgoing, setOutgoing] = useState<ReactNode>(null);
  const [revision, setRevision] = useState(0);
  const incomingRef = useRef<HTMLSpanElement>(null);

  if (snapshot.key !== contentKey) {
    setOutgoing(snapshot.content);
    setSnapshot({ content: children, key: contentKey });
    setRevision(revision + 1);
  } else if (snapshot.content !== children) {
    setSnapshot({ content: children, key: contentKey });
  }

  useLayoutEffect(() => {
    if (revision === 0) return;
    let cancelled = false;
    const animations = incomingRef.current?.getAnimations() ?? [];
    if (animations.length === 0) {
      setOutgoing(null);
      return;
    }
    Promise.allSettled(animations.map((animation) => animation.finished)).then(
      () => {
        if (!cancelled) setOutgoing(null);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [revision]);

  return (
    <span className={cn('inline-grid min-w-0', className)}>
      {outgoing != null && (
        <span
          aria-hidden
          className={cn(
            'motion-copy-out pointer-events-none col-start-1 row-start-1 min-w-0',
            kind === 'icon' &&
              '[animation-duration:var(--motion-duration-fast)]'
          )}
          inert
          key={`out-${revision}`}
        >
          {outgoing}
        </span>
      )}
      <span
        className={cn(
          'col-start-1 row-start-1 min-w-0',
          revision > 0 &&
            (kind === 'icon' ? 'motion-icon-in' : 'motion-text-in')
        )}
        key={revision}
        ref={incomingRef}
      >
        {children}
      </span>
    </span>
  );
}
