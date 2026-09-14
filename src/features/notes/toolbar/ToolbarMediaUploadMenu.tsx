import {
  ChevronDown,
  ExternalLink,
  FileAudio,
  FilePlus,
  FileText,
  Image,
} from 'lucide-react';
import { useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { useNoteBlockDialogs } from '@/features/notes/blocks/dialogContext';
import { insertMediaPlaceholder } from '@/features/notes/insertMediaPlaceholder';
import type { AnyEditor } from '@/features/notes/toolbar/NoteToolbar';
import { ToolbarButton } from '@/features/notes/toolbar/ToolbarButton';
import {
  MenuRow,
  ToolbarMenuContent,
} from '@/features/notes/toolbar/ToolbarMenuRow';
import { insertYouTubeEmbed } from '@/features/notes/youtube';
import { m } from '@/i18n';

export function MediaUploadMenu({ editor }: { editor: AnyEditor }) {
  const dialogs = useNoteBlockDialogs();
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton className="w-fit" label={m.editor_media_upload()}>
          <FilePlus />
          <ChevronDown className="size-3! text-fg-secondary" />
        </ToolbarButton>
      </DropdownMenuTrigger>
      <ToolbarMenuContent
        align="start"
        className="w-42 gap-0.5 bg-surface p-1 shadow-pop"
      >
        <MenuRow
          icon={<Image />}
          label={m.editor_upload_image()}
          onSelect={() => insertMediaPlaceholder(editor, 'img')}
        />
        <MenuRow
          icon={<FileAudio />}
          label={m.editor_upload_audio()}
          onSelect={() => insertMediaPlaceholder(editor, 'audio')}
        />
        <MenuRow
          icon={<FileText />}
          label={m.editor_upload_file()}
          onSelect={() => insertMediaPlaceholder(editor, 'file')}
        />
        <MenuRow
          icon={<ExternalLink />}
          label={m.editor_youtube_embed()}
          onSelect={() =>
            dialogs.openYouTube(undefined, (videoId) => {
              insertYouTubeEmbed(editor, videoId);
            })
          }
        />
      </ToolbarMenuContent>
    </DropdownMenu>
  );
}
