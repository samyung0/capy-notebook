import { useState } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/Tooltip';
import { m } from '@/i18n';

/** A member's storage is full (Epo 2026-11-08): they can't upload files, new
 * assignments' included (Q722). Hover or tap says so. Only on Study → Members,
 * to class staff (Q720), never on an assignment's pages. */
export function StorageFullChip() {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip onOpenChange={setOpen} open={open}>
      <TooltipTrigger
        className="t-meta inline-flex h-5.5 shrink-0 cursor-help items-center whitespace-nowrap rounded-md bg-tint-error px-1.75 font-semibold text-tint-error-fg outline-none focus-visible:ring-2 focus-visible:ring-action"
        onClick={(event) => {
          // A tap toggles it; it never opens the member's row.
          event.stopPropagation();
          setOpen((was) => !was);
        }}
        render={<button type="button" />}
      >
        {m.members_storage_full()}
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-left">
        {m.members_storage_full_hint()}
      </TooltipContent>
    </Tooltip>
  );
}
