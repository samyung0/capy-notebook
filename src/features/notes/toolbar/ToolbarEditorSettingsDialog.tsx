import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/Dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { Tabs } from '@/components/ui/Tabs';
import { MermaidSwatch } from '@/features/materials/Mermaid';
import {
  MERMAID_THEME_LABEL,
  MERMAID_THEMES,
} from '@/features/materials/mermaidThemes';
import { EditorIcon } from '@/features/notes/EditorIcon';
import {
  useNoteEditorPrefs,
  WIDGET_GROUPS,
  type WidgetGroupId,
} from '@/features/notes/noteEditorPrefs';
import { m } from '@/i18n';
import { ToolbarButton } from './ToolbarButton';

export function EditorSettingsDialog() {
  const enabled = useNoteEditorPrefs((state) => state.enabled);
  const displayWidth = useNoteEditorPrefs((state) => state.displayWidth);
  const setEnabled = useNoteEditorPrefs((state) => state.setEnabled);
  const setDisplayWidth = useNoteEditorPrefs((state) => state.setDisplayWidth);
  const mermaidTheme = useNoteEditorPrefs((state) => state.mermaidTheme);
  const setMermaidTheme = useNoteEditorPrefs((state) => state.setMermaidTheme);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('general');
  const { control, handleSubmit, reset, setValue } = useForm({
    defaultValues: { displayWidth, enabled, mermaidTheme },
  });

  const changeOpen = (next: boolean) => {
    if (next) {
      reset({ displayWidth, enabled, mermaidTheme });
      setTab('general');
    }
    setOpen(next);
  };
  const setAll = (value: boolean) => {
    const next = {} as Record<WidgetGroupId, boolean>;
    for (const group of WIDGET_GROUPS) next[group.id] = value;
    setValue('enabled', next);
  };

  return (
    <Dialog onOpenChange={changeOpen} open={open}>
      <ToolbarButton
        label={m.editor_prefs_settings()}
        onClick={() => changeOpen(true)}
      >
        <EditorIcon name="preferences" />
      </ToolbarButton>
      <DialogContent className="max-w-2xl">
        <DialogTitle>{m.editor_prefs_title()}</DialogTitle>
        <form
          onSubmit={handleSubmit((draft) => {
            setEnabled(draft.enabled);
            setDisplayWidth(draft.displayWidth);
            setMermaidTheme(draft.mermaidTheme);
            setOpen(false);
          })}
        >
          <Tabs
            className="mt-2.5"
            onChange={setTab}
            tabs={[
              { label: m.settings_tab_general(), value: 'general' },
              { label: m.editor_prefs_commands(), value: 'commands' },
            ]}
            value={tab}
          />
          <div className="mt-1 px-3 py-5">
            {tab === 'general' ? (
              <div className="grid gap-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label className="font-semibold" htmlFor="note-display-width">
                    {m.editor_prefs_display_size()}
                  </label>
                  <Controller
                    control={control}
                    name="displayWidth"
                    render={({ field }) => (
                      <Select
                        onValueChange={field.onChange}
                        value={field.value}
                      >
                        <SelectTrigger
                          className="w-44"
                          id="note-display-width"
                          onBlur={field.onBlur}
                          ref={field.ref}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="half">
                            {m.editor_prefs_half_width()}
                          </SelectItem>
                          <SelectItem value="full">
                            {m.editor_prefs_full_width()}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label className="font-semibold" htmlFor="note-mermaid-theme">
                    {m.editor_prefs_mermaid_theme()}
                  </label>
                  <Controller
                    control={control}
                    name="mermaidTheme"
                    render={({ field }) => (
                      <Select
                        onValueChange={field.onChange}
                        value={field.value}
                      >
                        <SelectTrigger
                          className="w-44"
                          id="note-mermaid-theme"
                          onBlur={field.onBlur}
                          ref={field.ref}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {MERMAID_THEMES.map((theme) => (
                            <SelectItem key={theme} value={theme}>
                              <span className="flex items-center gap-2">
                                <MermaidSwatch theme={theme} />
                                {MERMAID_THEME_LABEL[theme]()}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
              </div>
            ) : (
              <>
                <p className="mb-2.5">{m.editor_prefs_body()}</p>
                <div className="mb-2.5 flex justify-end">
                  <Button
                    onClick={() => setAll(true)}
                    size="sm"
                    type="button"
                    variant="ghost-hover"
                  >
                    {m.action_all()}
                  </Button>
                  <Button
                    onClick={() => setAll(false)}
                    size="sm"
                    type="button"
                    variant="ghost-hover"
                  >
                    {m.action_none()}
                  </Button>
                </div>
                <div className="grid max-h-[52vh] grid-cols-1 gap-2 overflow-auto pr-1 sm:grid-cols-2">
                  {WIDGET_GROUPS.map((group) => (
                    <label
                      className="flex items-center justify-between gap-3 rounded-card border border-line p-4 py-2.5"
                      htmlFor={`note-command-${group.id}`}
                      key={group.id}
                    >
                      <span className="inline-flex min-w-0 flex-col gap-0.5">
                        <span className="block font-semibold">
                          {group.label}
                        </span>
                        <span className="block text-fg-secondary leading-tight">
                          {group.description}
                        </span>
                      </span>
                      <Controller
                        control={control}
                        name={`enabled.${group.id}`}
                        render={({ field }) => (
                          <Switch
                            checked={field.value}
                            id={`note-command-${group.id}`}
                            onBlur={field.onBlur}
                            onCheckedChange={field.onChange}
                            ref={field.ref}
                          />
                        )}
                      />
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button
              onClick={() => setOpen(false)}
              size="lg"
              type="button"
              variant="ghost-hover"
            >
              {m.action_cancel()}
            </Button>
            <Button size="lg" type="submit" variant="accent">
              {m.action_apply()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
