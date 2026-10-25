import type { ReactNode } from 'react';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { m } from '@/i18n';

export interface TabAction {
  disabled?: boolean;
  icon: IconName;
  label: string;
  onClick: () => void;
}

/**
 * The row above a workspace panel: its title (a PanelTitleMenu where the
 * panel switches views) and, on the right, the view's own actions and the
 * settings gear. Below sm the actions and the gear fold into a
 * dots menu so only two icons stay in view.
 */
export function PanelTabRow({
  title,
  actions,
  onOpenSettings,
}: {
  title: ReactNode;
  actions: TabAction[];
  onOpenSettings?: () => void;
}) {
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
    // pt-2.5 in h-12.25 centres the row 29.5px down, level with the centre
    // header (60px less its 1px border).
    <div className="relative flex h-12.25 shrink-0 items-center gap-1 pt-2.5 pr-2 pl-1.5 sm:pl-4.5">
      {typeof title === 'string' ? (
        <h2 className="t-subtitle ml-1 min-w-0 flex-1 truncate">{title}</h2>
      ) : (
        <div className="min-w-0 flex-1">{title}</div>
      )}
      <div className="flex shrink-0 items-center gap-0">
        <div className="hidden items-center sm:flex">
          {actions.map((action) => (
            <ToolbarButton
              disabled={action.disabled}
              key={action.label}
              label={action.label}
              onClick={action.onClick}
            >
              <Icon name={action.icon} />
            </ToolbarButton>
          ))}
        </div>
        {onOpenSettings && (
          <ToolbarButton
            className="hidden sm:inline-flex"
            label={m.workspace_settings()}
            onClick={onOpenSettings}
          >
            <Icon name="settings" />
          </ToolbarButton>
        )}
        {folded.length > 0 && (
          <div className="sm:hidden">
            <Menu
              items={folded}
              trigger={
                <ToolbarButton label={m.a11y_more_actions()}>
                  <Icon name="moreVertical" />
                </ToolbarButton>
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
