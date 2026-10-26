import { useNavigate } from '@tanstack/react-router';
import type { ProgressItem, StudyPlan } from '@/api/types';
import type { OpenItem } from '@/features/materials/openItem';

/** Opens a plan's item where it lives: in this workspace through the page's
 * own opener, elsewhere by navigating there. */
export function usePlanLinks(
  workspaceId: string | undefined,
  onOpenItem?: (item: OpenItem) => void
) {
  const navigate = useNavigate();
  return {
    openItem: (
      item: Pick<ProgressItem, 'id' | 'type'>,
      inWorkspace: string
    ) => {
      if (inWorkspace === workspaceId && onOpenItem) {
        onOpenItem({ id: item.id, kind: item.type });
        return;
      }
      void navigate({
        params: { workspaceId: inWorkspace },
        search:
          item.type === 'file' ? { file: item.id } : { material: item.id },
        to: '/workspaces/$workspaceId',
      });
    },
    openPlan: (plan: StudyPlan) =>
      void navigate({
        params: { workspaceId: plan.workspaceId },
        search: { plan: plan.id },
        to: '/workspaces/$workspaceId',
      }),
  };
}
