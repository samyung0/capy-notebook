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
import { m } from '@/i18n';
import { ToolbarButton } from './ToolbarButton';

export function WidgetSettingsDialog() {
  const enabled = useNoteEditorPrefs((state) => state.enabled);
  const setEnabled = useNoteEditorPrefs((state) => state.setEnabled);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(enabled);
  const _count = WIDGET_GROUPS.filter((group) => draft[group.id]).length;

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
        label={m.editor_prefs_settings()}
        onClick={() => setOpen(true)}
      >
        <Settings2 />
      </ToolbarButton>
      <DialogContent className="max-w-2xl">
        <DialogTitle className="pb-2">{m.editor_prefs_title()}</DialogTitle>
        <p className="mb-2.5">{m.editor_prefs_body()}</p>
        <div className="mb-2.5 flex items-center justify-end">
          {/* <span className="font-medium text-fg text-sm">
            {count} of {WIDGET_GROUPS.length} visible
          </span> */}
          <div className="flex">
            <Button
              onClick={() => setAll(true)}
              size="sm"
              variant="ghost-hover"
            >
              {m.action_all()}
            </Button>
            <Button
              onClick={() => setAll(false)}
              size="sm"
              variant="ghost-hover"
            >
              {m.action_none()}
            </Button>
          </div>
        </div>
        <div className="grid max-h-[52vh] grid-cols-1 gap-2 overflow-auto pr-1 sm:grid-cols-2">
          {WIDGET_GROUPS.map((group) => (
            <label
              className="flex items-center justify-between gap-3 rounded-card border border-line p-4 py-2.5"
              key={group.id}
            >
              <span className="inline-flex min-w-0 flex-col gap-0.5">
                <span className="block font-semibold">{group.label}</span>
                <span className="block text-fg-secondary leading-tight">
                  {group.description}
                </span>
              </span>
              <Switch
                checked={draft[group.id]}
                onCheckedChange={() =>
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
            {m.action_cancel()}
          </Button>
          <Button
            onClick={() => {
              setEnabled(draft);
              setOpen(false);
            }}
            variant="accent"
          >
            {m.action_apply()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
