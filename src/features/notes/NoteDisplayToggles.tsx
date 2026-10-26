import { EditorIcon } from '@/features/notes/EditorIcon';
import { useNoteEditorPrefs } from '@/features/notes/noteEditorPrefs';
import { currentNoteFont, setNoteFont } from '@/features/notes/noteFont';
import { ToolbarButton } from '@/features/notes/toolbar/ToolbarButton';
import { m } from '@/i18n';
import { useTheme } from '@/theme/theme';

/** Shortcuts to the width and font picks of Editor settings, in the top right
 * corner of a note's scroll area in View and Edit. Each flips between the two
 * choices; the note itself shows which one is on. The scroll area must be
 * `relative` so they scroll away with the note's top. */
export function NoteDisplayToggles() {
  const displayWidth = useNoteEditorPrefs((state) => state.displayWidth);
  const setDisplayWidth = useNoteEditorPrefs((state) => state.setDisplayWidth);
  const { style } = useTheme();
  return (
    <div className="absolute top-2 right-3 z-10 flex gap-0.5">
      <ToolbarButton
        label={m.editor_toggle_font()}
        onClick={() =>
          setNoteFont(currentNoteFont(style) === 'fustat' ? 'system' : 'fustat')
        }
      >
        <EditorIcon name="text" />
      </ToolbarButton>
      {/* Half width only narrows the note from md up. */}
      <ToolbarButton
        className="hidden md:inline-flex"
        label={m.editor_toggle_width()}
        onClick={() =>
          setDisplayWidth(displayWidth === 'half' ? 'full' : 'half')
        }
      >
        <EditorIcon name="width" />
      </ToolbarButton>
    </div>
  );
}
