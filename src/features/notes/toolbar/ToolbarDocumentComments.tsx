import { useEditorSelector } from 'platejs/react';
import type { MaterialDiscussion } from '@/api/types';
import { Popover, PopoverTrigger } from '@/components/ui/Popover';
import {
  DiscussionThreadsContent,
  documentThreads,
  useCollaborationActions,
} from '@/features/notes/Collaboration';
import { m } from '@/i18n';
import { EditorIcon } from '../EditorIcon';
import { ToolbarButton } from './ToolbarButton';

const NO_THREADS: MaterialDiscussion[] = [];

const sameThreads = (a: MaterialDiscussion[], b: MaterialDiscussion[]) =>
  a.length === b.length && a.every((thread, index) => thread === b[index]);

/** The note's document comments (Epo 2026-10-21): a count in the toolbar,
 * shown while there are any, opening them in the block threads' popover. */
export function ToolbarDocumentComments() {
  const actions = useCollaborationActions();
  const discussions = actions?.discussions ?? NO_THREADS;
  const threads = useEditorSelector(
    (editor) => documentThreads(editor.children, discussions),
    [discussions],
    { equalityFn: sameThreads }
  );
  if (threads.length === 0) return null;
  const count = String(threads.length);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <ToolbarButton
          className="w-auto min-w-8 px-1 text-fg-muted data-[state=open]:bg-surface-hover-bg"
          label={
            threads.length === 1
              ? m.editor_show_document_threads({ count })
              : m.editor_show_document_threads_plural({ count })
          }
        >
          <EditorIcon name="comment" />
          <span className="font-semibold text-xs">{count}</span>
        </ToolbarButton>
      </PopoverTrigger>
      <DiscussionThreadsContent
        align="end"
        discussions={threads}
        heading={m.editor_document_comments()}
        side="bottom"
      />
    </Popover>
  );
}
