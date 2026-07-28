import { useState } from 'react';
import type { Task } from '@/api/types';
import { Button, Input, SimpleDialog } from "@/components/ui";
import { m } from "@/i18n";

export function TaskEditDialog({
  task,
  open,
  onClose,
  onSave,
}: {
  task: Task;
  open: boolean;
  onClose: () => void;
  onSave: (patch: Pick<Task, "title">) => void;
}) {
  const [title, setTitle] = useState(task.title);

  return (
    <SimpleDialog
      footer={
        <>
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={!title.trim()}
            onClick={() => {
              onSave({ title: title.trim() });
              onClose();
            }}
          >
            Save
          </Button>
        </>
      }
      onClose={onClose}
      open={open}
      title={m.action_edit()}
    >
      <label className="flex flex-col gap-1.5">
        <p className="t-label text-fg-muted">Title</p>
        <Input
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
          value={title}
        />
      </label>
    </SimpleDialog>
  );
}
