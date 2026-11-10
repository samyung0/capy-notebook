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
 * box of its own above the actions (Epo 2026-11-10). */
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
    <DropdownMenuItem
      className={cn(
        'min-h-11 cursor-pointer gap-2.5 px-2 py-1',
        canvas.id === current?.id && 'bg-overlay-hover'
      )}
      key={canvas.id}
      onSelect={() => onOpen(canvas)}
    >
      {canvas.workspaceIconId ? (
        <img
          alt=""
          className="size-7 shrink-0 rounded-[7px]"
          src={iconUrl(canvas.workspaceIconId)}
        />
      ) : (
        <span className="grid size-7 shrink-0 place-items-center">
          <FileIcon className="size-5" name={materialIconName('canvas')} />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate font-semibold">
        {canvas.workspaceName || canvas.title}
      </span>
      <span className="t-meta shrink-0 text-fg-muted">
        {relativeTime(canvas.updatedAt)}
      </span>
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          className="w-full min-w-0 justify-between gap-2 bg-surface sm:w-[300px]"
          variant="outline"
        >
          <span className="min-w-0 truncate">
            {current?.title ?? m.workspace_section_canvas()}
          </span>
          <Icon name="chevronDown" size={18} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="flex max-h-[70dvh] w-(--radix-dropdown-menu-trigger-width) min-w-64 flex-col p-1.5"
      >
        {/* The list scrolls by itself, so the actions under it stay in reach
            however many pages it loads. */}
        <div className="min-h-0 flex-1 overflow-y-auto" ref={list}>
          {own.map(row)}
          {shared.length > 0 && (
            <DropdownMenuLabel className="t-meta px-2 pt-2 pb-0.5 font-normal text-fg-muted">
              {m.canvas_in_workspaces()}
            </DropdownMenuLabel>
          )}
          {shared.map(row)}
          <ListEnd {...paging} root={list} />
        </div>
        {!(frozen && !current) && <DropdownMenuSeparator />}
        {!frozen && (
          <DropdownMenuItem
            className="min-h-11 cursor-pointer gap-2.5 px-2 py-1 font-semibold"
            onSelect={onNew}
          >
            <span className="grid size-7 shrink-0 place-items-center">
              <Icon name="plus" size={18} />
            </span>
            {m.canvas_new()}
          </DropdownMenuItem>
        )}
        {current && !frozen && (
          <DropdownMenuItem
            className="min-h-11 cursor-pointer gap-2.5 px-2 py-1"
            onSelect={onRename}
          >
            <span className="grid size-7 shrink-0 place-items-center">
              <Icon name="pencil" size={18} />
            </span>
            {m.action_rename()}
          </DropdownMenuItem>
        )}
        {current && (
          <DropdownMenuItem
            className="min-h-11 cursor-pointer gap-2.5 px-2 py-1 text-danger"
            onSelect={onDelete}
          >
            <span className="grid size-7 shrink-0 place-items-center">
              <Icon name="trash" size={18} />
            </span>
            {m.action_delete()}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
