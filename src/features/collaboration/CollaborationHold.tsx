import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useCollaborationHeld } from './held';

/**
 * An editor that takes no input while the tab holds back its collaboration
 * messages (Epo 2026-10-18: pacing, an update's pieces, a timeout): its
 * content is inert, busy, and shows a loading cursor until they are sent.
 * `className` lays out the wrapper; the content keeps its own layout.
 */
export function CollaborationHold({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const held = useCollaborationHeld();
  return (
    <div
      aria-busy={held || undefined}
      className={cn(className, held && 'cursor-progress')}
      data-collaboration-held={held || undefined}
    >
      <div className="contents" inert={held}>
        {children}
      </div>
    </div>
  );
}
