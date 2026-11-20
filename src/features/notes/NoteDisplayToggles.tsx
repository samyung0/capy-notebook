import { buttonVariants } from '@/components/ui/Button';
import { EditorIcon } from '@/features/notes/EditorIcon';
import { useNoteEditorPrefs } from '@/features/notes/noteEditorPrefs';
import { ToolbarButton } from '@/features/notes/toolbar/ToolbarButton';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** In the top right corner of a note's scroll area in View and Edit: Edit's
 * toolbar toggle, a pencil (Epo 2026-11-17, was a bolt), and the width pick of
 * Editor settings, flipping between its two choices. The font pick lives in
 * Editor settings alone (Epo 2026-11-17). The scroll area must be `relative`
 * so they scroll away with the note's top. */
export function NoteDisplayToggles({
  toolbar,
}: {
  /** The toolbar toggle; Edit passes it, View has no toolbar. */
  toolbar?: { shown: boolean; onToggle: () => void } | null;
}) {
  const displayWidth = useNoteEditorPrefs((state) => state.displayWidth);
  const setDisplayWidth = useNoteEditorPrefs((state) => state.setDisplayWidth);
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
          <EditorIcon name="pencil" />
        </ToolbarButton>
      )}
      {/* Half width only narrows the note from md up; the pencil's margin
       * spaces them, as a flex gap would also space the hidden button's
       * tooltip span. */}
      <ToolbarButton
        className={cn(
          buttonVariants({ size: null, variant: 'ghost-hover' }),
          'hidden text-fg-muted hover:text-fg-muted md:inline-flex'
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
