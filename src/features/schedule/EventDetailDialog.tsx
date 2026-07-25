import type { CalendarEvent, Label } from '@/api/types';
import {
  Badge,
  Dialog,
  DialogContent,
  DialogTitle,
  Icon,
  IconButton,
} from '@/components/ui';
import { fmtTime } from './dateUtils';

export function EventDetailDialog({
  event,
  labels,
  onClose,
  onEdit,
}: {
  event: CalendarEvent | null;
  labels: Label[];
  onClose: () => void;
  onEdit?: (event: CalendarEvent) => void;
}) {
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open={!!event}>
      <DialogContent className="max-w-md">
        {event && (
          <>
            <DialogTitle className="pr-20 pb-4">
              <span className="min-w-0 truncate">{event.title}</span>
            </DialogTitle>
            <IconButton
              className="absolute top-4 right-14"
              icon="write"
              label="Edit"
              onClick={() => onEdit?.(event)}
              size="md"
              variant="ghost-hover"
            />

            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Icon className="size-4 -translate-y-px" name="clock" />{' '}
                {fmtTime(event.start)} – {fmtTime(event.end)}
              </div>
              {event.location && (
                <div className="flex items-center gap-2">
                  <Icon className="size-4 -translate-y-px" name="location" />{' '}
                  {event.location}
                </div>
              )}
              {event.labelIds.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {event.labelIds.map((id) => {
                    const l = labels.find((x) => x.id === id);
                    return l ? (
                      <Badge key={id} size="sm" tone="neutral">
                        # {l.name}
                      </Badge>
                    ) : null;
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
