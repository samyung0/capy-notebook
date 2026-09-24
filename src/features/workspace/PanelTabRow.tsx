import type { ReactNode } from 'react';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { AddSourceMode } from './AddSourceDialog';
import { addSourceMenuItems } from './addSourceMenuItems';

export interface TabAction {
  disabled?: boolean;
  icon: IconName;
  label: string;
  onClick: () => void;
}

/**
 * The row above a workspace panel: the Files / Chat / Generate tabs (or a
 * plain title when Files is pinned as its own panel) and, on the right, the
 * active tab's own actions, the plus menu and the settings gear. Below lg the
 * actions and the gear fold into a dots menu so only two icons stay in view.
 */
export function PanelTabRow({
  tabs,
  title,
  actions,
  compact,
  onAddSource,
  onAddChapter,
  onOpenSettings,
}: {
  tabs?: ReactNode;
  title?: string;
  actions: TabAction[];
  compact: boolean;
  onAddSource?: (mode: AddSourceMode) => void;
  onAddChapter?: () => void;
  onOpenSettings?: () => void;
}) {
  const addItems: MenuItem[] = onAddSource
    ? addSourceMenuItems(onAddSource, onAddChapter)
    : [];
  const folded: MenuItem[] = [
    ...actions,
    ...(onOpenSettings
      ? [
          {
            icon: 'settings' as const,
            label: m.workspace_settings(),
            onClick: onOpenSettings,
          },
        ]
      : []),
  ];
  return (
    <div
      className={cn(
        'relative flex shrink-0 items-center gap-1 pt-2.5 pr-2 pl-4.5',
        title
          ? 'h-12'
          : 'before:pointer-events-none before:absolute before:right-2 before:bottom-0 before:left-4.5 before:h-px before:bg-divider'
      )}
    >
      {title ? (
        <h2 className="t-subtitle ml-1 min-w-0 flex-1 truncate">{title}</h2>
      ) : (
        tabs
      )}
      <div
        className={cn('flex shrink-0 items-center gap-0', !title && 'mb-1.5')}
      >
        {!compact &&
          actions.map((action) => (
            <ToolbarButton
              disabled={action.disabled}
              key={action.label}
              label={action.label}
              onClick={action.onClick}
            >
              <Icon name={action.icon} />
            </ToolbarButton>
          ))}
        {addItems.length > 0 && (
          <Menu
            items={addItems}
            trigger={
              <ToolbarButton label={m.action_add_file()}>
                <Icon name="plusCircle" />
              </ToolbarButton>
            }
          />
        )}
        {compact
          ? folded.length > 0 && (
              <Menu
                items={folded}
                trigger={
                  <ToolbarButton label={m.a11y_more_actions()}>
                    <Icon name="moreVertical" />
                  </ToolbarButton>
                }
              />
            )
          : onOpenSettings && (
              <ToolbarButton
                label={m.workspace_settings()}
                onClick={onOpenSettings}
              >
                <Icon name="settings" />
              </ToolbarButton>
            )}
      </div>
    </div>
  );
}
