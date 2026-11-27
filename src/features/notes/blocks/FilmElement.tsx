import {
  PlateElement,
  type PlateElementProps,
  useEditorRef,
  useReadOnly,
  useSelected,
} from 'platejs/react';
import { BlockToolbar } from '@/components/ui/BlockToolbar';
import { FilmEmbed, useOpenFilm } from '@/features/films/FilmEmbed';
import type { FilmElement as FilmNode } from '@/features/materials/document';
import { EditorIcon } from '@/features/notes/EditorIcon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { ToolbarButton } from '../toolbar/ToolbarButton';
import { useOptionalNoteBlockDialogs } from './dialogContext';

/** A note's film (Epo 2026-11-27, mock A): the film at the column's width, no
 * frame, playing in place in View and Edit. Selected in Edit it shows Open,
 * Replace and Delete above its top right. */
export function FilmElement(props: PlateElementProps) {
  const editor = useEditorRef();
  const readOnly = useReadOnly();
  const selected = useSelected();
  const { fileId } = props.element as unknown as FilmNode;
  const active = !readOnly && selected;
  return (
    <PlateElement {...props} className="relative my-4">
      <div
        className={cn(
          active && 'outline-2 outline-solid-accent-1 outline-offset-2'
        )}
        contentEditable={false}
        // Pressing the film selects its block; its own controls still play.
        onMouseDown={(event) => {
          if (readOnly || (event.target as Element).closest('[role=toolbar]'))
            return;
          const at = editor.api.findPath(props.element);
          if (at) editor.tf.select(editor.api.start(at));
        }}
      >
        <FilmEmbed fileId={fileId} />
        {active && <FilmToolbar element={props.element} fileId={fileId} />}
      </div>
      {/* Slate's void spacer, kept positioned as the other voids keep it. */}
      <span className="absolute top-0 left-0">{props.children}</span>
    </PlateElement>
  );
}

function FilmToolbar({
  element,
  fileId,
}: {
  element: PlateElementProps['element'];
  fileId: string;
}) {
  const editor = useEditorRef();
  const dialogs = useOptionalNoteBlockDialogs();
  const open = useOpenFilm(fileId);
  const id = (element as unknown as FilmNode).id;
  return (
    <BlockToolbar className="absolute -top-10 right-0 z-10">
      {open && (
        <ToolbarButton
          className="w-fit gap-1.5 px-1.5"
          label={m.action_open()}
          onClick={open}
          tooltipSide="top"
        >
          <EditorIcon name="externalLink" />
          <span>{m.action_open()}</span>
        </ToolbarButton>
      )}
      {dialogs && (
        <ToolbarButton
          className="w-fit gap-1.5 px-1.5"
          label={m.editor_film_replace()}
          onClick={() => dialogs.pickFilm(editor, { id })}
          tooltipSide="top"
        >
          <EditorIcon name="refresh" />
          <span>{m.editor_film_replace()}</span>
        </ToolbarButton>
      )}
      <ToolbarButton
        label={m.action_delete()}
        onClick={() => {
          const at = editor.api.findPath(element);
          if (at) editor.tf.removeNodes({ at });
        }}
        tooltipSide="top"
        variant="danger-light"
      >
        <EditorIcon name="trash" />
      </ToolbarButton>
    </BlockToolbar>
  );
}
