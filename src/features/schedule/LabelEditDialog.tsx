import { useState } from 'react';
import type { Label, UserColor } from '@/api/types';
import { Button, Input, SimpleDialog, Text } from '@/components/ui';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { USER_COLORS, userColorPair } from '@/lib/userColor';

export interface LabelFormValues {
  color: UserColor;
  name: string;
}

export function LabelEditDialog({
  label,
  open,
  onClose,
  onSave,
}: {
  label: Label;
  open: boolean;
  onClose: () => void;
  onSave: (patch: LabelFormValues) => void;
}) {
  const [name, setName] = useState(label.name);
  const [color, setColor] = useState<UserColor>(label.color);

  return (
    <SimpleDialog
      footer={
        <>
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={!name.trim()}
            onClick={() => {
              onSave({ color, name: name.trim() });
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
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <Text tone="muted" variant="label">
            Name
          </Text>
          <Input
            autoFocus
            onChange={(e) => setName(e.target.value)}
            value={name}
          />
        </label>

        <div className="flex flex-col gap-1.5">
          <Text tone="muted" variant="label">
            Color
          </Text>
          <div className="flex gap-2">
            {USER_COLORS.map((c) => {
              const p = userColorPair(c);
              return (
                <button
                  aria-label={c}
                  className={cn(
                    'h-8 w-8 rounded-pill transition-transform',
                    color === c &&
                      'ring-2 ring-action ring-offset-2 ring-offset-surface'
                  )}
                  key={c}
                  onClick={() => setColor(c)}
                  style={{ background: p.bg }}
                  type="button"
                />
              );
            })}
          </div>
        </div>
      </div>
    </SimpleDialog>
  );
}
