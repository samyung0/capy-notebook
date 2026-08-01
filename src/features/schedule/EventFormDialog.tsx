import { useState } from 'react';
import type { Label } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Input, InputTitle } from '@/components/ui/Input';
import { SimpleDialog } from '@/components/ui/Dialog';
import { cn } from '@/lib/cn';
import { userColorPair } from '@/lib/userColor';

export interface EventFormValues {
  end: string;
  labelIds: string[];
  location?: string;
  start: string;
  title: string;
}

export interface EventDraft {
  end?: string;
  // present when editing an existing event; absent when creating.
  id?: string;
  labelIds?: string[];
  location?: string;
  start?: string;
  title?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const toDateValue = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toTimeValue = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const combine = (dateStr: string, timeStr: string) =>
  new Date(`${dateStr}T${timeStr}`).toISOString();

function defaultStart() {
  const d = new Date();
  d.setHours(9, 0, 0, 0);
  return d;
}

export function EventFormDialog({
  open,
  onClose,
  labels,
  draft,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  labels: Label[];
  draft?: EventDraft;
  onSubmit: (v: EventFormValues) => void;
}) {
  const isEdit = !!draft?.id;
  const start = draft?.start ? new Date(draft.start) : defaultStart();
  const end = draft?.end
    ? new Date(draft.end)
    : new Date(start.getTime() + 60 * 60 * 1000);

  // TODO: use react-hook-form and zod-resolver, refer to workspaceFormEditDialog, relevant schema should be auto generated already

  const [title, setTitle] = useState(draft?.title ?? '');
  const [date, setDate] = useState(toDateValue(start));
  const [startTime, setStartTime] = useState(toTimeValue(start));
  const [endTime, setEndTime] = useState(toTimeValue(end));
  const [location, setLocation] = useState(draft?.location ?? '');
  const [labelIds, setLabelIds] = useState<string[]>(draft?.labelIds ?? []);

  const toggleLabel = (id: string) =>
    setLabelIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  const valid =
    title.trim() && date && startTime && endTime && endTime > startTime;

  return (
    <SimpleDialog
      footer={
        <>
          <Button onClick={onClose} size="lg" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={!valid}
            onClick={() => {
              onSubmit({
                end: combine(date, endTime),
                labelIds,
                location: location.trim() || undefined,
                start: combine(date, startTime),
                title: title.trim(),
              });
              onClose();
            }}
            size="lg"
          >
            {isEdit ? 'Save' : 'Create'}
          </Button>
        </>
      }
      onClose={onClose}
      open={open}
      title={isEdit ? 'Edit event' : 'New event'}
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <InputTitle>Title</InputTitle>
          <Input
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Event title"
            value={title}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <InputTitle>Date</InputTitle>
          <Input
            onChange={(e) => setDate(e.target.value)}
            type="date"
            value={date}
          />
        </label>

        <div className="flex gap-3">
          <label className="flex flex-1 flex-col gap-1.5">
            <InputTitle>Start</InputTitle>
            <Input
              onChange={(e) => setStartTime(e.target.value)}
              type="time"
              value={startTime}
            />
          </label>
          <label className="flex flex-1 flex-col gap-1.5">
            <InputTitle>End</InputTitle>
            <Input
              onChange={(e) => setEndTime(e.target.value)}
              type="time"
              value={endTime}
            />
          </label>
        </div>

        <label className="flex flex-col gap-1.5">
          <InputTitle>Location</InputTitle>
          <Input
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Optional"
            value={location}
          />
        </label>

        {labels.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <InputTitle>Labels</InputTitle>
            <div className="flex flex-wrap gap-1.5">
              {labels.map((l) => {
                const on = labelIds.includes(l.id);
                const p = userColorPair(l.color);
                return (
                  <button
                    className={cn(
                      'flex items-center gap-1.5 rounded-full border px-3 py-1 font-medium text-sm transition-colors',
                      on
                        ? 'border-transparent'
                        : 'border-line text-fg-muted hover:text-fg'
                    )}
                    key={l.id}
                    onClick={() => toggleLabel(l.id)}
                    style={on ? { background: p.bg, color: p.fg } : undefined}
                    type="button"
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ background: on ? p.fg : p.bg }}
                    />
                    {l.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </SimpleDialog>
  );
}
