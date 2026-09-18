import type { ReactNode } from 'react';
import type { IconName } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { AddSourceMode } from './AddSourceDialog';

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
    ? [
        {
          icon: 'upload',
          label: m.action_upload_or_import(),
          onClick: () => onAddSource('upload'),
        },
        {
          icon: 'newFile',
          label: m.action_new_file(),
          onClick: () => onAddSource('create'),
        },
        ...(onAddChapter
          ? [
              {
                icon: 'archive' as const,
                label: m.action_add_chapter(),
                onClick: onAddChapter,
              },
            ]
          : []),
      ]
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
  const iconButton = 'text-fg-muted';
  return (
    <div
      className={cn(
        'inset-shadow-[0_-1px_var(--color-divider)] flex shrink-0 gap-1 pr-2.5',
        title ? 'h-12 items-center pl-4.5' : 'items-end pt-1.5 pl-3'
      )}
    >
      {title ? (
        <h2 className="t-card-title min-w-0 flex-1 truncate">{title}</h2>
      ) : (
        tabs
      )}
      <div
        className={cn('flex shrink-0 items-center gap-0.5', !title && 'mb-1.5')}
      >
        {!compact &&
          actions.map((action) => (
            <IconButton
              className={iconButton}
              disabled={action.disabled}
              icon={action.icon}
              key={action.label}
              label={action.label}
              onClick={action.onClick}
              size="sm"
              tooltip
              variant="ghost-hover"
            />
          ))}
        {addItems.length > 0 && (
          <Menu
            items={addItems}
            trigger={
              <IconButton
                className={iconButton}
                icon="plusCircle"
                label={m.action_add_file()}
                size="sm"
                variant="ghost-hover"
              />
            }
          />
        )}
        {compact
          ? folded.length > 0 && (
              <Menu
                items={folded}
                trigger={
                  <IconButton
                    className={iconButton}
                    icon="moreVertical"
                    label={m.a11y_more_actions()}
                    size="sm"
                    variant="ghost-hover"
                  />
                }
              />
            )
          : onOpenSettings && (
              <IconButton
                className={iconButton}
                icon="settings"
                label={m.workspace_settings()}
                onClick={onOpenSettings}
                size="sm"
                tooltip
                variant="ghost-hover"
              />
            )}
      </div>
    </div>
  );
}
