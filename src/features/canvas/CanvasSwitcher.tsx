import { type ComponentProps, useRef } from 'react';
import type { CanvasListItem } from '@/api/canvas';
import { ListEnd } from '@/components/app/ListEnd';
import { Button } from '@/components/ui/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { FileIcon } from '@/components/ui/FileIcon';
import { Icon } from '@/components/ui/Icon';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { materialIconName } from '@/lib/fileIcons';
import { iconUrl } from '@/lib/icon-catalog';

/** The Canvas page's top left panel (Epo 2026-11-10, mock KNPB4pYUhSSYUJvuKN1ct7
 * B): every canvas there is, the person's own first, then each workspace's
 * under its icon and name, then New canvas, and the shown one's Rename and
 * Delete (not in the mock's first round: a canvas of one's own has no other
 * place for them). The list comes a page at a time as it is scrolled, in a
 * box of its own above the actions (Epo 2026-11-10). Rows are sized as the
 * workspace Files panel's (FileListItem: 30px, a 16px icon, one truncated
 * line), with the time a canvas was saved at their end; the menu is as wide as
 * its trigger (Epo 2026-11-12). */
export function CanvasSwitcher({
  canvases,
  current,
  frozen,
  onDelete,
  onNew,
  onOpen,
  onOpenChange,
  onRename,
  paging,
}: {
  canvases: CanvasListItem[];
  /** The one of the person's own that the page shows. */
  current: CanvasListItem | undefined;
  /** A frozen account makes and renames nothing; it may still delete. */
  frozen: boolean;
  onDelete: () => void;
  onNew: () => void;
  onOpen: (canvas: CanvasListItem) => void;
  onOpenChange: (open: boolean) => void;
  onRename: () => void;
  /** The list's next page, loaded as its end comes on screen. */
  paging: Omit<ComponentProps<typeof ListEnd>, 'className' | 'root'>;
}) {
  const list = useRef<HTMLDivElement>(null);
  const own = canvases.filter(({ workspaceId }) => !workspaceId);
  const shared = canvases.filter(({ workspaceId }) => workspaceId);
  const row = (canvas: CanvasListItem) => (
    <CanvasMenuItem
      className={cn(canvas.id === current?.id && 'bg-overlay-hover text-fg')}
      key={canvas.id}
      onSelect={() => onOpen(canvas)}
    >
      {canvas.workspaceIconId ? (
        <img
          alt=""
          className="size-4 shrink-0 rounded-[4px]"
          src={iconUrl(canvas.workspaceIconId)}
        />
      ) : (
        <FileIcon className="size-4" name={materialIconName('canvas')} />
      )}
      <span className="min-w-0 flex-1 truncate">
        {canvas.workspaceName || canvas.title}
      </span>
      <span className="shrink-0 font-normal text-fg-muted text-xs">
        {relativeTime(canvas.updatedAt)}
      </span>
    </CanvasMenuItem>
  );
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        {/* One width, the menu's too; a phone's fills its row. As tall as the
            board's ☰ button at every width (Epo 2026-11-12). */}
        <Button
          className="w-full min-w-0 justify-between bg-surface px-3.5 sm:w-60"
          iconRight="chevronDown"
          variant="outline"
        >
          <span className="min-w-0 truncate">
            {current?.title ?? m.workspace_section_canvas()}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="flex max-h-[70dvh] w-(--radix-dropdown-menu-trigger-width) min-w-0 flex-col p-1"
        collisionPadding={8}
      >
        {/* The list scrolls by itself, so the actions under it stay in reach
            however many pages it loads. */}
        <div className="min-h-0 flex-1 overflow-y-auto" ref={list}>
          {own.map(row)}
          {shared.length > 0 && (
            <DropdownMenuLabel>{m.canvas_in_workspaces()}</DropdownMenuLabel>
          )}
          {shared.map(row)}
          <ListEnd {...paging} root={list} />
        </div>
        {!(frozen && !current) && (
          <DropdownMenuSeparator className="mx-1.5 my-1 bg-overlay-line" />
        )}
        {!frozen && (
          <CanvasMenuItem onSelect={onNew}>
            <Icon name="plus" />
            <span className="min-w-0 truncate">{m.canvas_new()}</span>
          </CanvasMenuItem>
        )}
        {current && !frozen && (
          <CanvasMenuItem onSelect={onRename}>
            <Icon name="pencil" />
            <span className="min-w-0 truncate">{m.action_rename()}</span>
          </CanvasMenuItem>
        )}
        {current && (
          <CanvasMenuItem
            className="text-tint-error-fg data-[highlighted]:bg-tint-error data-[highlighted]:text-tint-error-fg"
            onSelect={onDelete}
          >
            <Icon name="trash" />
            <span className="min-w-0 truncate">{m.action_delete()}</span>
          </CanvasMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A row of the menu, at the Files panel's row size. */
function CanvasMenuItem({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuItem>) {
  return (
    <DropdownMenuItem
      className={cn(
        'min-h-7.5 py-1 font-medium text-fg-secondary data-[highlighted]:text-fg [&_svg]:size-4',
        className
      )}
      {...props}
    />
  );
}
