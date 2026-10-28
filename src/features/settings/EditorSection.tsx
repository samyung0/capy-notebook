import { SectionTitle, SettingRow } from '@/components/app/tabPanel';
import { Switch } from '@/components/ui/Switch';
import { useNoteEditorPrefs } from '@/features/notes/noteEditorPrefs';
import { m } from '@/i18n';

/** Settings → Customizations → Editor: whether co-editors' cursors, pointers
 * and selected blocks show, in notes and Office files alike. Saved on this
 * device (Epo 2026-10-28, Q542). */
export function EditorSection() {
  const showOthers = useNoteEditorPrefs((state) => state.showOthers);
  const setShowOthers = useNoteEditorPrefs((state) => state.setShowOthers);
  return (
    <>
      <div className="border-divider border-t" />
      <SectionTitle title={m.settings_editor_title()} />
      <SettingRow
        hint={m.settings_show_others_hint()}
        title={m.settings_show_others()}
      >
        <Switch
          aria-label={m.settings_show_others()}
          checked={showOthers}
          onCheckedChange={setShowOthers}
        />
      </SettingRow>
    </>
  );
}
