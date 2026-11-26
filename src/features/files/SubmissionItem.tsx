import { type LinkProps, useNavigate } from '@tanstack/react-router';
import { memo } from 'react';
import type { SourceFile, SubmittedPaper } from '@/api/types';
import { ItemCard } from '@/components/app/ItemCard';
import type { ListView } from '@/components/app/ListToolbar';
import { Menu } from '@/components/ui/Menu';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { assignmentsLink } from '@/features/study/studyRoutes';
import { m } from '@/i18n';
import { fileIconName } from '@/lib/fileIcons';
import { formatFileSize } from './fileUtils';

const assignmentLink = (item: SubmittedPaper): LinkProps =>
  assignmentsLink(item.workspaceId, { assignment: item.assignmentId });

/** A hand-in file the caller added but never handed in before its assignment
 * closed (Epo 2026-11-25): free, so listed for them to delete. Handed-in work
 * is on its assignment's page instead. It opens the assignment. */
export const SubmissionItem = memo(function SubmissionItem({
  item,
  onDelete,
  pickKey,
  selected,
  view,
  workspaceIconId,
}: {
  item: SubmittedPaper;
  onDelete: (item: SubmittedPaper) => void;
  pickKey: string;
  selected: boolean;
  view: ListView;
  workspaceIconId?: string;
}) {
  const navigate = useNavigate();
  return (
    <ItemCard
      actions={
        <Menu
          items={[
            {
              icon: 'navigationForward',
              label: m.assignment_open(),
              onClick: () => void navigate(assignmentLink(item)),
            },
            {
              danger: true,
              icon: 'trash',
              label: m.submissions_delete(),
              onClick: () => onDelete(item),
            },
          ]}
        />
      }
      details={`${item.quizName} · ${formatFileSize(item.bytes)}`}
      icon={fileIconName(item as Pick<SourceFile, 'kind' | 'name'>)}
      link={assignmentLink(item)}
      meta={relativeTime(item.createdAt)}
      pickKey={pickKey}
      selected={selected}
      title={item.name}
      view={view}
      workspace={item.workspaceName}
      workspaceIconId={workspaceIconId}
    />
  );
});
