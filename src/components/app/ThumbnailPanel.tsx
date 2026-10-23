import { memo, type ReactNode, useState } from 'react';
import type { FileKind, FileTextPreview, MaterialPreview } from '@/api/types';
import { FileIcon, type FileIconName } from '@/components/ui/FileIcon';
import {
  CardsLive,
  NoteLive,
  QuizLive,
  TableLive,
  TextLive,
} from '@/features/materials/preview/LivePreview';
import {
  MermaidPreview,
  useMermaidDrawing,
} from '@/features/materials/preview/MermaidPreview';
import { cn } from '@/lib/cn';

/** What a row offers its thumbnail: a file's page-1 image or opening text,
 * or a material's stored live preview. */
export interface Thumbnail {
  /** A file row's kind: picks the image crop and the dark-mode dim. */
  fileKind?: FileKind;
  /** The row's own question or card count, shown even without a preview. */
  pill?: string;
  preview?: FileTextPreview | MaterialPreview;
  thumbnailUrl?: string;
}

/** Pages render dark text on white, so the dark theme dims them; photos keep
 * their brightness. */
const PAGE_KINDS: FileKind[] = ['pdf', 'doc', 'slides', 'sheet'];

/** The card's 16:11 thumbnail, or the 40px tile of a recents row (a shorter 16:10 card when `dense`). Falls back
 * to the kind icon when there is nothing to draw or the image fails (a recents
 * row then shows the bare icon); a failed image is not retried. */
export const ThumbnailPanel = memo(function ThumbnailPanel({
  icon,
  fileKind,
  thumbnailUrl,
  preview,
  pill,
  small = false,
  dense = false,
}: Thumbnail & { icon: FileIconName; small?: boolean; dense?: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  // Previews arrive as open JSON. A diagram draws only when its source
  // parses; one that does not is a failed preview, like a broken image.
  const mermaid = useMermaidDrawing(
    preview && 'source' in preview && typeof preview.source === 'string'
      ? preview.source
      : undefined
  );
  const fallback = (
    <div className="absolute inset-0 grid place-items-center">
      <FileIcon className={small ? 'size-5' : 'size-[34px]'} name={icon} />
    </div>
  );
  let body: ReactNode = null;
  if (thumbnailUrl && thumbnailUrl !== failedUrl) {
    body = (
      <img
        alt=""
        className={cn(
          'size-full object-cover',
          fileKind === 'slides' || fileKind === 'image'
            ? 'object-center'
            : 'object-top',
          fileKind && PAGE_KINDS.includes(fileKind) && 'dark:brightness-[.86]'
        )}
        decoding="async"
        height={138}
        loading="lazy"
        onError={() => setFailedUrl(thumbnailUrl)}
        src={thumbnailUrl}
        width={200}
      />
    );
  } else if (preview && 'text' in preview) {
    // Only CSV and TSV sheets carry text; workbooks have page images.
    if (preview.text.trim())
      body =
        fileKind === 'sheet' ? (
          <TableLive text={preview.text} />
        ) : (
          <TextLive markdown={fileKind === 'md'} text={preview.text} />
        );
  } else if (preview) {
    switch (preview.kind) {
      case 'note':
        if (preview.blocks.length) body = <NoteLive blocks={preview.blocks} />;
        break;
      case 'quiz':
        if (preview.first) body = <QuizLive question={preview.first} />;
        break;
      case 'flashcards':
        if (preview.first)
          body = (
            <CardsLive
              count={preview.cardCount}
              front={preview.first.front}
              hasImage={preview.first.hasImage}
            />
          );
        break;
      default:
        if (mermaid) body = <MermaidPreview drawing={mermaid} />;
    }
  }
  return (
    <div
      aria-hidden
      className={cn(
        'relative shrink-0 overflow-hidden',
        small
          ? 'pv-small size-10 rounded-[9px]'
          : cn(
              '@container rounded-[13px] bg-(--surface-canvas)',
              dense ? 'aspect-[16/10]' : 'aspect-[16/11]'
            ),
        // A recents row's bare kind icon sits without the tile.
        small && body && 'border border-divider bg-(--surface-canvas)'
      )}
    >
      {body ?? fallback}
      {/* Top left: the grid card's ⋯ takes the top right. */}
      {pill && !small && (
        <span className="absolute @min-[188px]:top-2 top-1.5 @min-[188px]:left-2 left-1.5 whitespace-nowrap rounded-full bg-tint-accent-1 @min-[188px]:px-[9px] px-[7px] @min-[188px]:py-1 py-[3px] font-bold @min-[188px]:text-[11px] text-[9.5px] text-tint-accent-1-fg leading-none">
          {pill}
        </span>
      )}
    </div>
  );
});
