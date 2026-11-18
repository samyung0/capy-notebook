import { type ComponentProps, useRef, useState } from 'react';
import type { CanvasListItem } from '@/api/canvas';
import { ListEnd } from '@/components/app/ListEnd';
import { Button } from '@/components/ui/Button';
import { FileIcon } from '@/components/ui/FileIcon';
import { Icon } from '@/components/ui/Icon';
import { Popover, PopoverTrigger } from '@/components/ui/Popover';
import { Separator } from '@/components/ui/Separator';
import { Switch } from '@/components/ui/Switch';
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
 * canvas, and the shown one's Rename, sharing switch and Delete. The list
 * comes a page at a time as it is scrolled, in a box of its own above the
 * actions (Epo 2026-11-10). It is the editor's popover (ToolbarPopover, as
 * Plate's All blocks), with the time a canvas was saved at each row's end, as
 * wide as its trigger (Epo 2026-11-12).
 *
 * Sharing (Epo 2026-11-18, mock F2dZxe8XvcW1FAiqMf81NA B): a canvas the person shared with its
 * workspace has the people mark before its time, another member's reads
 * "Ben · 3d", a private one neither; the shown canvas's "Shared with
 * workspace" switch sits between Rename and Delete. */
export function CanvasSwitcher({
  canvases,
  current,
  frozen,
  inWorkspace = false,
  manage,
  onDelete,
  onNew,
  onOpen,
  onOpenChange,
  onRename,
  onShare,
  paging,
  shared = false,
  sharing = false,
}: {
  canvases: CanvasListItem[];
  /** The one the page shows. */
  current: CanvasListItem | undefined;
  /** A frozen account makes, renames and shares nothing; it may still delete. */
  frozen: boolean;
  /** A workspace's Canvas tab: its canvases alone, no workspace icons. */
  inWorkspace?: boolean;
  /** The person may rename and delete the shown canvas (`canvasRights`). */
  manage: boolean;
  onDelete: () => void;
  onNew: () => void;
  onOpen: (canvas: CanvasListItem) => void;
  onOpenChange: (open: boolean) => void;
  onRename: () => void;
  /** Shares the shown canvas with its workspace, or takes it back; none when
   * the person may not (`canvasRights`). */
  onShare?: (shared: boolean) => void;
  /** The list's next page, loaded as its end comes on screen. */
  paging: Omit<ComponentProps<typeof ListEnd>, 'className' | 'root'>;
  /** What the switch shows. */
  shared?: boolean;
  /** A change of it is on its way. */
  sharing?: boolean;
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
  const inWorkspaces = inWorkspace
    ? []
    : canvases.filter(({ workspaceId }) => workspaceId);
  const managed = !!current && manage;
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
      {canvas.shared && canvas.own && (
        // A button's contents have no roles of their own: the row's name
        // says it.
        <span
          className="inline-flex shrink-0 text-fg-muted"
          title={m.canvas_shared_with_workspace()}
        >
          <Icon aria-hidden name="members" />
          <span className="sr-only">{m.canvas_shared_with_workspace()}</span>
        </span>
      )}
      <span className="shrink-0 font-normal text-fg-muted text-xs">
        {canvas.creatorName
          ? m.canvas_row_by({
              name: canvas.creatorName,
              time: relativeTime(canvas.updatedAt),
            })
          : relativeTime(canvas.updatedAt)}
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
          {inWorkspaces.length > 0 && (
            <ToolbarPopoverGroup label={m.canvas_in_workspaces()}>
              {inWorkspaces.map(row)}
            </ToolbarPopoverGroup>
          )}
          <ListEnd {...paging} root={list} />
        </div>
        {(!frozen || managed) && <Separator className="my-1" />}
        {!frozen && (
          <ToolbarPopoverItem
            icon={<Icon name="plus" />}
            label={m.canvas_new()}
            onClick={pick(onNew)}
          />
        )}
        {managed && !frozen && (
          <ToolbarPopoverItem
            icon={<Icon name="pencil" />}
            label={m.action_rename()}
            onClick={pick(onRename)}
          />
        )}
        {current && onShare && !frozen && (
          // The row is the control and stays open; the switch shows its state.
          <ToolbarPopoverButton
            aria-busy={sharing}
            aria-checked={shared}
            onClick={() => {
              if (!sharing) onShare(!shared);
            }}
            role="switch"
          >
            <span className="flex size-4.5 shrink-0 items-center justify-center">
              <Icon name="members" />
            </span>
            <span className="min-w-0 flex-1 whitespace-nowrap">
              {m.canvas_shared_with_workspace()}
            </span>
            <Switch
              aria-hidden
              checked={shared}
              className="pointer-events-none"
              readOnly
              size="sm"
              tabIndex={-1}
            />
          </ToolbarPopoverButton>
        )}
        {managed && (
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
