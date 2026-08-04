import { useState } from 'react';
import type { Task } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Input, InputTitle } from '@/components/ui/Input';
import { m } from '@/i18n';

export function TaskEditDialog({
  task,
  open,
  onClose,
  onSave,
}: {
  task: Task;
  open: boolean;
  onClose: () => void;
  onSave: (patch: Pick<Task, 'title'>) => void;
}) {
  const [title, setTitle] = useState(task.title);

  return (
    <SimpleDialog
      footer={
        <>
          <Button onClick={onClose} size="lg" variant="ghost-hover">
            Cancel
          </Button>
          <Button
            disabled={!title.trim()}
            onClick={() => {
              onSave({ title: title.trim() });
              onClose();
            }}
            size="lg"
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
        <InputTitle>Title</InputTitle>
        <Input
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
          value={title}
        />
      </label>
    </SimpleDialog>
  );
}
