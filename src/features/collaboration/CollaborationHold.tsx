import { createContext, type ReactNode, useContext } from 'react';
import { cn } from '@/lib/cn';
import { useCollaborationHeld } from './held';

const EditorScope = createContext(false);

/**
 * Marks an editor's subtree. Its dialogs, menus, popovers and floating
 * toolbars portal out of `CollaborationHold`'s inert wrapper, so the shared
 * overlay components consult `useEditorHeld` and go inert themselves.
 */
export function EditorHoldScope({ children }: { children: ReactNode }) {
  return <EditorScope.Provider value>{children}</EditorScope.Provider>;
}

/** Whether an overlay opened from an editor takes no input right now. */
export function useEditorHeld() {
  const scoped = useContext(EditorScope);
  const held = useCollaborationHeld();
  return scoped && held;
}

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
    <EditorHoldScope>
      <div
        aria-busy={held || undefined}
        className={cn(className, held && 'cursor-progress')}
        data-collaboration-held={held || undefined}
      >
        <div className="contents" inert={held}>
          {children}
        </div>
      </div>
    </EditorHoldScope>
  );
}
