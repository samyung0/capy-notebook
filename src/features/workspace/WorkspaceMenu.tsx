import { useNavigate } from '@tanstack/react-router';
import { useWorkspaces } from '@/api/hooks';
import type { Workspace } from '@/api/types';
import { BASE_BUTTON_STYLE, Button } from '@/components/ui/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Icon, type IconName } from '@/components/ui/Icon';
import { ButtonTooltip } from '@/components/ui/Tooltip';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { iconUrl } from '@/lib/icon-catalog';

function FooterItem({
  icon,
  label,
  onSelect,
  disabled,
}: {
  icon: IconName;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenuItem
      className={cn(
        BASE_BUTTON_STYLE,
        'h-7.5 w-full cursor-pointer justify-start gap-1.75 px-2.5 text-fg hover:bg-surface-hover-bg/80 data-[highlighted]:bg-surface-hover-bg/80'
      )}
      disabled={disabled}
      onSelect={onSelect}
    >
      <Icon name={icon} size={15} />
      {label}
    </DropdownMenuItem>
  );
}

/**
 * The workspace name in the viewer header: a menu listing the other
 * workspaces, with settings (or clone, for a visitor) fixed at the bottom.
 * This replaces the old header card and its back link.
 */
export function WorkspaceMenu({
  workspace,
  onOpenSettings,
  onClone,
  cloning = false,
}: {
  workspace: Workspace;
  onOpenSettings?: () => void;
  onClone?: () => void;
  cloning?: boolean;
}) {
  const navigate = useNavigate();
  const { data: workspaces } = useWorkspaces(
    { sort: 'accessed' },
    { errorBoundary: false }
  );
  const list = workspaces?.some((w) => w.id === workspace.id)
    ? workspaces
    : [workspace, ...(workspaces ?? [])];
  return (
    <DropdownMenu modal={false}>
      <ButtonTooltip label={m.workspace_switch()} side="bottom">
        <DropdownMenuTrigger asChild>
          <Button
            className="group/ws-trigger flex h-9 min-w-0 items-center gap-2 px-2"
            iconRight="chevronDown"
            iconRightClassName="text-fg-muted transition-transform duration-(--motion-duration-fast) ease-(--motion-ease-in-out) group-data-[state=open]/ws-trigger:rotate-180"
            variant="gray"
          >
            <img
              alt=""
              className="size-5 shrink-0 -translate-y-px rounded-md"
              src={iconUrl(workspace.iconId)}
            />
            <span className="t-body min-w-0 truncate font-semibold">
              {workspace.name}
            </span>
          </Button>
        </DropdownMenuTrigger>
      </ButtonTooltip>
      <DropdownMenuContent align="start" className="w-72 p-1.5">
        <div className="max-h-80 overflow-y-auto">
          {list.map((w) => (
            <DropdownMenuItem
              aria-current={w.id === workspace.id ? 'true' : undefined}
              className="cursor-pointer gap-2.5 px-2 py-2 font-semibold"
              key={w.id}
              onSelect={() => {
                if (w.id === workspace.id) return;
                navigate({
                  params: { workspaceId: w.id },
                  to: '/workspaces/$workspaceId',
                });
              }}
            >
              <img
                alt=""
                className="size-5.5 shrink-0 rounded-md"
                src={iconUrl(w.iconId)}
              />
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
              {w.id === workspace.id && <Icon name="check" size={16} />}
            </DropdownMenuItem>
          ))}
        </div>
        {(onOpenSettings || onClone) && <DropdownMenuSeparator />}
        {onOpenSettings && (
          <FooterItem
            icon="settings"
            label={m.workspace_settings()}
            onSelect={onOpenSettings}
          />
        )}
        {onClone && (
          <FooterItem
            disabled={cloning}
            icon="clone"
            label={cloning ? m.action_cloning() : m.action_clone_workspace()}
            onSelect={onClone}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
