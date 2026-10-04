import { Button } from '@/components/ui/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Icon, type IconName } from '@/components/ui/Icon';
import { m } from '@/i18n';

export type WorkspaceTool = 'files' | 'chat' | 'generate';

export function WorkspaceToolMenu({
  tools,
  value,
  onChange,
  pinned,
  onTogglePinned,
  onOpenSettings,
}: {
  tools: { value: WorkspaceTool; label: string; icon: IconName }[];
  value: WorkspaceTool;
  onChange: (tool: WorkspaceTool) => void;
  pinned: boolean;
  onTogglePinned?: () => void;
  onOpenSettings?: () => void;
}) {
  const active = tools.find((tool) => tool.value === value);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={m.workspace_tools()}
          className="min-w-0 gap-2"
          data-slot="workspace-tool-menu-trigger"
          size="sm"
          variant="ghost-hover"
        >
          {active && <Icon name={active.icon} />}
          <span data-slot="workspace-tool-label">{active?.label}</span>
          <span
            aria-hidden
            className="rounded-sm border border-line px-1 text-fg-muted text-xs"
          >
            {tools.length}
          </span>
          <Icon className="text-fg-muted" name="chevronDown" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {tools.map((tool) => (
          <DropdownMenuItem
            aria-current={tool.value === value ? 'true' : undefined}
            key={tool.value}
            onSelect={() => onChange(tool.value)}
          >
            <Icon name={tool.icon} />
            <span className="flex-1">{tool.label}</span>
            {tool.value === value && <Icon name="check" />}
          </DropdownMenuItem>
        ))}
        {(onTogglePinned || onOpenSettings) && <DropdownMenuSeparator />}
        {onTogglePinned && (
          <DropdownMenuItem onSelect={onTogglePinned}>
            <Icon name="panelLeft" />
            {pinned ? m.workspace_unpin_files() : m.workspace_pin_files()}
          </DropdownMenuItem>
        )}
        {onOpenSettings && (
          <DropdownMenuItem onSelect={onOpenSettings}>
            <Icon name="settings" />
            {m.workspace_settings()}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
