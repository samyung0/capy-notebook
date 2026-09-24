import { useState } from 'react';
import { Popover, PopoverTrigger } from '@/components/ui/Popover';
import { useNoteBlockDialogs } from '@/features/notes/blocks/dialogContext';
import { EditorIcon } from '@/features/notes/EditorIcon';
import { insertMediaPlaceholder } from '@/features/notes/insertMediaPlaceholder';
import type { AnyEditor } from '@/features/notes/toolbar/NoteToolbar';
import { ToolbarButton } from '@/features/notes/toolbar/ToolbarButton';
import {
  ToolbarPopoverContent,
  ToolbarPopoverRow,
} from '@/features/notes/toolbar/ToolbarPopover';
import { insertYouTubeEmbed } from '@/features/notes/youtube';
import { m } from '@/i18n';

export function MediaUploadMenu({ editor }: { editor: AnyEditor }) {
  const dialogs = useNoteBlockDialogs();
  const [open, setOpen] = useState(false);
  return (
    <Popover modal={false} onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <ToolbarButton label={m.editor_media_upload()}>
          <EditorIcon name="filePlus" />
        </ToolbarButton>
      </PopoverTrigger>
      <ToolbarPopoverContent
        align="start"
        className="w-42 gap-0.5 p-1"
        open={open}
      >
        <ToolbarPopoverRow
          icon={<EditorIcon name="image" />}
          label={m.editor_upload_image()}
          onClick={() => insertMediaPlaceholder(editor, 'img')}
        />
        <ToolbarPopoverRow
          icon={<EditorIcon name="fileAudio" />}
          label={m.editor_upload_audio()}
          onClick={() => insertMediaPlaceholder(editor, 'audio')}
        />
        <ToolbarPopoverRow
          icon={<EditorIcon name="fileText" />}
          label={m.editor_upload_file()}
          onClick={() => insertMediaPlaceholder(editor, 'file')}
        />
        <ToolbarPopoverRow
          icon={<EditorIcon name="externalLink" />}
          label={m.editor_youtube_embed()}
          onClick={() =>
            dialogs.openYouTube(undefined, (videoId) => {
              insertYouTubeEmbed(editor, videoId);
            })
          }
        />
      </ToolbarPopoverContent>
    </Popover>
  );
}
