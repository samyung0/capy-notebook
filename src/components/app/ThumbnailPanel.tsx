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
import { MermaidPreview } from '@/features/materials/preview/MermaidPreview';
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

/** The card's 16:11 thumbnail, or the 44px tile of a recents row. Falls back
 * to the kind icon when there is nothing to draw or the image fails; a failed
 * image is not retried. */
export const ThumbnailPanel = memo(function ThumbnailPanel({
  icon,
  fileKind,
  thumbnailUrl,
  preview,
  pill,
  small = false,
}: Thumbnail & { icon: FileIconName; small?: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string>();
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
        // Previews arrive as open JSON; one without its source keeps the icon.
        if (preview.source)
          body = <MermaidPreview fallback={fallback} source={preview.source} />;
    }
  }
  return (
    <div
      aria-hidden
      className={cn(
        'relative shrink-0 overflow-hidden bg-(--surface-canvas)',
        small
          ? 'pv-small size-11 rounded-[9px] border border-divider'
          : '@container aspect-[16/11] rounded-[13px]'
      )}
    >
      {body ?? fallback}
      {pill && !small && (
        <span className="absolute @min-[188px]:top-2 top-1.5 @min-[188px]:right-2 right-1.5 whitespace-nowrap rounded-full bg-tint-accent-1 @min-[188px]:px-[9px] px-[7px] @min-[188px]:py-1 py-[3px] font-bold @min-[188px]:text-[11px] text-[9.5px] text-tint-accent-1-fg leading-none">
          {pill}
        </span>
      )}
    </div>
  );
});
