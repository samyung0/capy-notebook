import { type LinkProps, useNavigate } from '@tanstack/react-router';
import { memo } from 'react';
import type { SourceFile, SubmittedPaper } from '@/api/types';
import { ItemCard, itemMenuIcon } from '@/components/app/ItemCard';
import type { ListView } from '@/components/app/ListToolbar';
import { Menu } from '@/components/ui/Menu';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { assignmentPage } from '@/features/study/assignments/assignmentPage';
import { m } from '@/i18n';
import { fileIconName } from '@/lib/fileIcons';
import { formatFileSize } from './fileUtils';

/** A paper opens its results; a hand-in, its assignment's page. */
const resultLink = (item: SubmittedPaper): LinkProps =>
  item.attemptId
    ? {
        params: { attemptId: item.attemptId },
        to: '/quizzes/attempts/$attemptId',
      }
    : assignmentPage({
        id: item.assignmentId,
        workspaceId: item.workspaceId ?? '',
      });

/** A file the caller handed in (Epo 2026-11-08, mock F1), listed once marked
 * and its assignment closed with grades out so it can be deleted; its marks
 * stay. It opens its results. */
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
              label: m.canvas_open_result(),
              onClick: () => void navigate(resultLink(item)),
            },
            {
              danger: true,
              icon: 'trash',
              label: m.submissions_delete(),
              onClick: () => onDelete(item),
            },
          ]}
          triggerIcon={itemMenuIcon(view)}
        />
      }
      details={`${item.quizName} · ${formatFileSize(item.bytes)}`}
      icon={fileIconName(item as Pick<SourceFile, 'kind' | 'name'>)}
      link={resultLink(item)}
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
