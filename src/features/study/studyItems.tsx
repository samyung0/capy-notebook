import { useQuery } from '@tanstack/react-query';
import { useSetStudyItem, workspaceStudyQuery } from '@/api/hooks';
import type { StudyItem } from '@/api/types';
import { Icon } from '@/components/ui/Icon';
import type { MenuItem } from '@/components/ui/Menu';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

export type StudyState = StudyItem['state'];
export type StudyTarget = { kind: 'file' | 'material'; id: string };
/** What a file panel row shows of progress: its mark and its menu items. */
export type StudyRow = { state: StudyState | undefined; menuItems: MenuItem[] };

/** The requester's progress per file and material id, while progress is on. */
export function useStudyStates(workspaceId: string): {
  enabled: boolean;
  states: Map<string, StudyState>;
} {
  // A standalone material has no workspace and so no progress.
  const { data } = useQuery({
    ...workspaceStudyQuery(workspaceId),
    enabled: !!workspaceId,
  });
  const states = new Map<string, StudyState>();
  for (const item of data?.items ?? []) {
    const id = item.fileId ?? item.materialId;
    if (id) states.set(id, item.state);
  }
  return { enabled: !!data?.enabled, states };
}

/** Mark as read / unread and Stop / Start tracking for one item. */
export function useStudyActions(workspaceId: string) {
  const { mutate: setItem } = useSetStudyItem(workspaceId);
  function set(target: StudyTarget, state: 'done' | 'removed' | null) {
    // No state marks the item untouched again (unread, or tracked again).
    setItem({
      ...(target.kind === 'file'
        ? { fileId: target.id }
        : { materialId: target.id }),
      ...(state ? { state } : {}),
    });
  }
  function menuItems(
    target: StudyTarget,
    state: StudyState | undefined
  ): MenuItem[] {
    if (state === 'removed')
      return [
        {
          icon: 'view',
          label: m.study_start_tracking(),
          onClick: () => set(target, null),
        },
      ];
    return [
      state === 'done'
        ? {
            icon: 'bookOpenCheck',
            label: m.study_mark_unread(),
            onClick: () => set(target, null),
          }
        : {
            icon: 'bookOpenCheck',
            label: m.study_mark_read(),
            onClick: () => set(target, 'done'),
          },
      {
        icon: 'viewOff',
        label: m.study_stop_tracking(),
        onClick: () => set(target, 'removed'),
      },
    ];
  }
  return { menuItems, set };
}

/** A row's progress: a check once done, a half circle once started. */
export function StudyMark({
  state,
  className,
}: {
  state: StudyState | undefined;
  className?: string;
}) {
  if (state !== 'done' && state !== 'started') return null;
  return (
    <Icon
      aria-hidden={false}
      aria-label={
        state === 'done' ? m.study_state_done() : m.study_state_started()
      }
      className={cn(
        'shrink-0',
        state === 'done' ? 'text-tint-success-fg' : 'text-fg-muted',
        className
      )}
      name={state === 'done' ? 'circleCheck' : 'circleDashed'}
      role="img"
      size={14}
    />
  );
}
