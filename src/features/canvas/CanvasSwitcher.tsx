import { type ComponentProps, useRef, useState } from 'react';
import type { CanvasListItem } from '@/api/canvas';
import { ListEnd } from '@/components/app/ListEnd';
import { Button } from '@/components/ui/Button';
import { FileIcon } from '@/components/ui/FileIcon';
import { Icon } from '@/components/ui/Icon';
import { Popover, PopoverTrigger } from '@/components/ui/Popover';
import { Separator } from '@/components/ui/Separator';
import {
  ToolbarPopoverButton,
  ToolbarPopoverContent,
  ToolbarPopoverGroup,
  ToolbarPopoverItem,
} from '@/components/ui/ToolbarPopover';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { materialIconName } from '@/lib/fileIcons';
import { iconUrl } from '@/lib/icon-catalog';

/** The canvas picker at the board's top left (Epo 2026-11-10, mock
 * KNPB4pYUhSSYUJvuKN1ct7 B), on the account's Canvas page and in a workspace's
 * Canvas tab (Epo 2026-11-12): the canvases there are (on the account's page
 * the person's own first, then each workspace's under its icon), then New
 * canvas, and the shown one's Rename and Delete. The list comes a page at a
 * time as it is scrolled, in a box of its own above the actions (Epo
 * 2026-11-10). It is the editor's popover (ToolbarPopover, as Plate's All
 * blocks), with the time a canvas was saved at each row's end, as wide as its
 * trigger (Epo 2026-11-12). */
export function CanvasSwitcher({
  canvases,
  current,
  frozen,
  inWorkspace = false,
  onDelete,
  onNew,
  onOpen,
  onOpenChange,
  onRename,
  paging,
}: {
  canvases: CanvasListItem[];
  /** The one the page shows. */
  current: CanvasListItem | undefined;
  /** A frozen account makes and renames nothing; it may still delete. */
  frozen: boolean;
  /** A workspace's Canvas tab: its canvases alone, no workspace icons. */
  inWorkspace?: boolean;
  onDelete: () => void;
  onNew: () => void;
  onOpen: (canvas: CanvasListItem) => void;
  onOpenChange: (open: boolean) => void;
  onRename: () => void;
  /** The list's next page, loaded as its end comes on screen. */
  paging: Omit<ComponentProps<typeof ListEnd>, 'className' | 'root'>;
}) {
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const toggle = (next: boolean) => {
    setOpen(next);
    onOpenChange(next);
  };
  /** Each row closes the menu, then acts. */
  const pick = (action: () => void) => () => {
    toggle(false);
    action();
  };
  // On the account's page a workspace's canvases follow the person's own.
  const own = inWorkspace
    ? canvases
    : canvases.filter(({ workspaceId }) => !workspaceId);
  const shared = inWorkspace
    ? []
    : canvases.filter(({ workspaceId }) => workspaceId);
  const row = (canvas: CanvasListItem) => (
    <ToolbarPopoverButton
      aria-current={canvas.id === current?.id || undefined}
      className={cn(canvas.id === current?.id && 'bg-surface-hover-bg')}
      key={canvas.id}
      onClick={pick(() => onOpen(canvas))}
    >
      {canvas.workspaceIconId && !inWorkspace ? (
        <img
          alt=""
          className="size-4.5 shrink-0 rounded-[4px]"
          src={iconUrl(canvas.workspaceIconId)}
        />
      ) : (
        <FileIcon className="size-4.5" name={materialIconName('canvas')} />
      )}
      <span className="min-w-0 flex-1 truncate">{canvas.title}</span>
      <span className="shrink-0 font-normal text-fg-muted text-xs">
        {relativeTime(canvas.updatedAt)}
      </span>
    </ToolbarPopoverButton>
  );
  return (
    <Popover onOpenChange={toggle} open={open}>
      <PopoverTrigger asChild>
        {/* One width, the menu's too; a phone's fills its row. 32px at every
            width, as tall as the board's ☰ button and a phone's Back (Epo
            2026-11-12). */}
        <Button
          className="h-8 w-full min-w-0 justify-between bg-surface px-3.5 sm:w-60"
          iconRight="chevronDown"
          variant="outline"
        >
          <span className="min-w-0 truncate">
            {current?.title ?? m.workspace_section_canvas()}
          </span>
        </Button>
      </PopoverTrigger>
      <ToolbarPopoverContent
        align="start"
        alignWidthToTrigger
        className="max-h-[70dvh] min-w-0"
        collisionPadding={8}
      >
        {/* The list scrolls by itself, so the actions under it stay in reach
            however many pages it loads. */}
        <div className="min-h-0 flex-1 overflow-y-auto" ref={list}>
          {own.map(row)}
          {shared.length > 0 && (
            <ToolbarPopoverGroup label={m.canvas_in_workspaces()}>
              {shared.map(row)}
            </ToolbarPopoverGroup>
          )}
          <ListEnd {...paging} root={list} />
        </div>
        {!(frozen && !current) && <Separator className="my-1" />}
        {!frozen && (
          <ToolbarPopoverItem
            icon={<Icon name="plus" />}
            label={m.canvas_new()}
            onClick={pick(onNew)}
          />
        )}
        {current && !frozen && (
          <ToolbarPopoverItem
            icon={<Icon name="pencil" />}
            label={m.action_rename()}
            onClick={pick(onRename)}
          />
        )}
        {current && (
          <ToolbarPopoverItem
            className="text-tint-error-fg hover:bg-tint-error hover:text-tint-error-fg"
            icon={<Icon name="trash" />}
            label={m.action_delete()}
            onClick={pick(onDelete)}
          />
        )}
      </ToolbarPopoverContent>
    </Popover>
  );
}
