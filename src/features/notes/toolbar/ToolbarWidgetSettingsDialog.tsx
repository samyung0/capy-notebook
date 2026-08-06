import { Settings2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Switch } from '@/components/ui/Switch';
import {
  useNoteEditorPrefs,
  WIDGET_GROUPS,
  type WidgetGroupId,
} from '@/features/notes/noteEditorPrefs';
import { ToolbarButton } from './ToolbarButton';

export function WidgetSettingsDialog() {
  const enabled = useNoteEditorPrefs((state) => state.enabled);
  const setEnabled = useNoteEditorPrefs((state) => state.setEnabled);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(enabled);
  const count = WIDGET_GROUPS.filter((group) => draft[group.id]).length;

  const setAll = (value: boolean) => {
    const next = {} as Record<WidgetGroupId, boolean>;
    for (const group of WIDGET_GROUPS) {
      next[group.id] = value;
    }
    setDraft(next);
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (next) setDraft({ ...enabled });
        setOpen(next);
      }}
      open={open}
    >
      <ToolbarButton
        label="Editor command settings"
        onClick={() => setOpen(true)}
      >
        <Settings2 />
      </ToolbarButton>
      <DialogContent className="max-w-xl">
        <DialogTitle className="pb-2">Editor commands</DialogTitle>
        <p className="mb-4 text-fg-muted text-sm">
          Choose which toolbar groups appear in the editor and command menus.
          Existing document content always remains available.
        </p>
        <div className="mb-3 flex items-center justify-between">
          <span className="font-medium text-fg text-sm">
            {count} of {WIDGET_GROUPS.length} visible
          </span>
          <div className="flex gap-1">
            <Button onClick={() => setAll(true)} size="sm" variant="ghost">
              All
            </Button>
            <Button onClick={() => setAll(false)} size="sm" variant="ghost">
              None
            </Button>
          </div>
        </div>
        <div className="grid max-h-[52vh] grid-cols-1 gap-2 overflow-auto pr-1 sm:grid-cols-2">
          {WIDGET_GROUPS.map((group) => (
            <label
              className="flex items-center justify-between gap-3 rounded-card border border-line px-3 py-2"
              key={group.id}
            >
              <span className="min-w-0">
                <span className="block font-medium text-fg text-sm">
                  {group.label}
                </span>
                <span className="block text-fg-muted text-xs">
                  {group.description}
                </span>
              </span>
              <Switch
                checked={draft[group.id]}
                onChange={() =>
                  setDraft((current) => ({
                    ...current,
                    [group.id]: !current[group.id],
                  }))
                }
              />
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="ghost-hover">
            Cancel
          </Button>
          <Button
            onClick={() => {
              setEnabled(draft);
              setOpen(false);
            }}
            variant="accent"
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
