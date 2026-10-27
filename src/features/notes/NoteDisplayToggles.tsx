import { buttonVariants } from '@/components/ui/Button';
import { EditorIcon } from '@/features/notes/EditorIcon';
import { useNoteEditorPrefs } from '@/features/notes/noteEditorPrefs';
import { currentNoteFont, setNoteFont } from '@/features/notes/noteFont';
import { ToolbarButton } from '@/features/notes/toolbar/ToolbarButton';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { useTheme } from '@/theme/theme';

/** Shortcuts to the width and font picks of Editor settings, in the top right
 * corner of a note's scroll area in View and Edit. Each flips between the two
 * choices; the note itself shows which one is on. The scroll area must be
 * `relative` so they scroll away with the note's top. */
export function NoteDisplayToggles({
  toolbar,
}: {
  /** The toolbar toggle; Edit passes it, View has no toolbar. */
  toolbar?: { shown: boolean; onToggle: () => void } | null;
}) {
  const displayWidth = useNoteEditorPrefs((state) => state.displayWidth);
  const setDisplayWidth = useNoteEditorPrefs((state) => state.setDisplayWidth);
  const { style } = useTheme();
  return (
    // The rightmost icon is centred on the first line's comment-thread
    // button's bubble (Collaboration.tsx): 40px gutter, ml-0.5 and px-1.5 put
    // it 23px from the edge, less half the 30px (32px from sm) button.
    <div className="absolute top-0 right-2 z-10 flex sm:right-1.75">
      {/* All look like that thread button: muted, filled on hover. */}
      {toolbar && (
        <ToolbarButton
          active={toolbar.shown}
          className={cn(
            buttonVariants({ size: null, variant: 'ghost-hover' }),
            'mr-0.5 text-fg-muted hover:text-fg-muted'
          )}
          label={
            toolbar.shown ? m.editor_toolbar_hide() : m.editor_toolbar_show()
          }
          onClick={toolbar.onToggle}
        >
          <EditorIcon name="tools" />
        </ToolbarButton>
      )}
      <ToolbarButton
        className={cn(
          buttonVariants({ size: null, variant: 'ghost-hover' }),
          'text-fg-muted hover:text-fg-muted'
        )}
        label={m.editor_toggle_font()}
        onClick={() =>
          setNoteFont(currentNoteFont(style) === 'fustat' ? 'system' : 'fustat')
        }
      >
        <EditorIcon name="text" />
      </ToolbarButton>
      {/* Half width only narrows the note from md up. Its gap is a margin: a
       * flex gap would also space the hidden button's tooltip span. */}
      <ToolbarButton
        className={cn(
          buttonVariants({ size: null, variant: 'ghost-hover' }),
          'hidden text-fg-muted hover:text-fg-muted md:ml-0.5 md:inline-flex'
        )}
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
