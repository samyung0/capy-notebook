import { type ReactNode, useContext } from 'react';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import type { FlashcardContent } from '@/features/materials/blocks';
import {
  AssetUrlContext,
  RemovedMedia,
  useResolvedAsset,
} from '@/features/materials/MediaAssetView';
import { cn } from '@/lib/cn';

/** The front as the grid, previews and study show it: the text, centred,
 * its image under it. A grid tile's image takes over half the tile. */
export function CardFront({
  card,
  className,
  size = 'tile',
}: {
  card: Pick<FlashcardContent, 'front' | 'image'>;
  className?: string;
  size?: 'tile' | 'compact' | 'large';
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        size === 'tile' ? 'gap-2' : 'gap-3',
        className
      )}
    >
      <p
        className={cn(
          'whitespace-pre-line break-words',
          size === 'large' && 't-large-card-title',
          (size === 'tile' || size === 'compact') && 't-card-title'
        )}
      >
        {card.front}
      </p>
      {card.image && (
        <CardImage
          assetId={card.image.assetId}
          className={cn(
            size === 'tile' && 'max-h-[58%]',
            size === 'compact' && 'h-20',
            size === 'large' && 'h-30'
          )}
        />
      )}
    </div>
  );
}

/** A card's image is a private asset of its set, loaded like a quiz image:
 * from the page's override (a local pick, a signed-out share route) or a
 * signed link resolved per render. */
export function CardImage({
  assetId,
  className,
}: {
  assetId: string;
  className?: string;
}) {
  const src = useContext(AssetUrlContext)?.(assetId);
  return src ? (
    <img
      alt=""
      className={cn('max-w-full object-contain', className)}
      src={src}
    />
  ) : (
    <ResolvedCardImage assetId={assetId} className={className} />
  );
}

function ResolvedCardImage({
  assetId,
  className,
}: {
  assetId: string;
  className?: string;
}) {
  const [asset] = useResolvedAsset(assetId);
  if (asset.status === 'error' && asset.kind === 'removed')
    return (
      <RemovedMedia
        className={cn(
          'min-h-0 gap-2 overflow-hidden px-3 py-2 text-xs',
          className
        )}
      />
    );
  return asset.status === 'ready' ? (
    <img
      alt=""
      className={cn('max-w-full object-contain', className)}
      src={asset.url}
    />
  ) : (
    <span aria-hidden className={cn('block aspect-video', className)} />
  );
}

/** The back keeps its line breaks. */
export function CardBack({ card }: { card: Pick<FlashcardContent, 'back'> }) {
  return (
    <p className="max-w-[52ch] whitespace-pre-line break-words text-center leading-relaxed">
      {card.back}
    </p>
  );
}

/** A turned card: the front's text as a centred header pinned to the top, so
 * a long front never moves the answer, which is centred in the rest. The
 * image stays on the front; `image` (the edit grid) shows it small under the
 * header's text. A tile caps the front's and the back's heights, each
 * scrolling without a scrollbar, edges fading. */
export function CardBackFace({
  card,
  className,
  image,
  size,
}: {
  card: Pick<FlashcardContent, 'back' | 'front'>;
  className?: string;
  image?: FlashcardContent['image'];
  size: 'large' | 'compact' | 'tile';
}) {
  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div
        className={cn(
          'shrink-0 border-divider border-b text-center font-bold text-fg-secondary',
          size === 'large' && 'px-7 pt-5.5 pb-4 text-base',
          size === 'compact' && 'px-5 pt-3.5 pb-2.5 text-sm',
          size === 'tile' &&
            'scroll-fade-y overflow-y-auto px-4.5 pt-4 pb-3 text-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          size === 'tile' && (image ? 'max-h-36' : 'max-h-22')
        )}
      >
        <p className="whitespace-pre-line break-words">{card.front}</p>
        {image && (
          <CardImage assetId={image.assetId} className="mx-auto mt-2 h-12" />
        )}
      </div>
      <div
        className={cn(
          // Safe centring: a long answer starts at its first line and scrolls.
          'items-center-safe flex min-h-0 flex-1 justify-center overflow-auto',
          size === 'large' && 'p-7 text-lg',
          size === 'compact' && 'p-5',
          size === 'tile' &&
            'scroll-fade-y max-h-52 px-3 py-4 text-[15px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
        )}
      >
        <CardBack card={card} />
      </div>
    </div>
  );
}

/** A card in a grid, as the results, the edit grid and View list it: turned
 * (front header over the back) or, with `face="front"`, the front alone; its
 * number at the bottom left and `aside` (rating chips, the edit toolbar) at
 * the bottom right. `onOpen` makes it a button that lifts on hover. */
export function CardTile({
  card,
  n,
  face = 'turned',
  aside,
  label,
  onOpen,
}: {
  card: Pick<FlashcardContent, 'back' | 'front' | 'image'>;
  n: number;
  face?: 'turned' | 'front';
  aside?: ReactNode;
  label?: string;
  onOpen?: () => void;
}) {
  const body = (
    <>
      {face === 'front' ? (
        <CardFront
          card={card}
          className="scroll-fade-y justify-center-safe h-32 overflow-y-auto px-5 pt-5 [scrollbar-width:none] sm:h-43 [&::-webkit-scrollbar]:hidden"
        />
      ) : (
        <CardBackFace
          card={card}
          className="flex-1"
          image={onOpen ? card.image : undefined}
          size="tile"
        />
      )}
      <span className="flex h-9 shrink-0 items-center px-3.5 pb-3 font-bold text-[13px] text-fg-muted">
        {n}
      </span>
    </>
  );
  return (
    <Card
      asChild
      border="solid"
      className="group/tile relative gap-0 overflow-hidden p-0 sm:min-h-52"
      interactive={!!onOpen}
      radius="flashcard"
    >
      <li>
        {onOpen ? (
          <button
            aria-label={label}
            className="flex flex-1 flex-col rounded-flashcard focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset"
            onClick={onOpen}
            type="button"
          >
            {body}
          </button>
        ) : (
          body
        )}
        {aside && (
          <div className="absolute right-3.5 bottom-3 flex min-h-6 items-center gap-1 whitespace-nowrap">
            {aside}
          </div>
        )}
      </li>
    </Card>
  );
}

/** Front on the top half, back on the bottom half. */
export function CardSides({
  card,
  className,
}: {
  card: FlashcardContent;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'grid min-h-115 grid-rows-2 overflow-hidden rounded-flashcard border border-line bg-surface',
        className
      )}
    >
      <CardFront card={card} className="p-7" size="large" />
      <div className="flex items-center justify-center overflow-auto border-divider border-t p-7">
        <CardBack card={card} />
      </div>
    </div>
  );
}

/** Tiles in columns of 350px or more that share the width; one column on
 * phones. */
export function CardGrid({ children }: { children: ReactNode }) {
  return (
    <ol className="grid grid-cols-1 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(350px,1fr))] sm:gap-3.5">
      {children}
    </ol>
  );
}

/** A small card showing only its front, drawn as Quick review's cards are;
 * a note's flashcards block lists its cards this way and a click opens the
 * card's dialog (Epo 2026-10-25). A long front is cut at the padding; an
 * image-only front shows an image mark. */
export function CompactCardTile({
  card,
  label,
  onOpen,
}: {
  card: Pick<FlashcardContent, 'front' | 'image'>;
  label?: string;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        aria-label={label}
        className="flex h-29.5 w-full flex-col rounded-tile border border-line bg-surface frosted:bg-(--frost-fill) p-3 text-left transition-[border-color] duration-(--motion-duration-quick) hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset"
        onClick={onOpen}
        type="button"
      >
        {card.front.trim() ? (
          <span className="min-h-0 flex-1 overflow-hidden whitespace-pre-line break-words font-semibold text-sm">
            {card.front}
          </span>
        ) : (
          card.image && <Icon className="text-fg-muted" name="image" />
        )}
      </button>
    </li>
  );
}

/** The compact grid's last tile: a dashed card of the same size and hover. */
export function CompactAddTile({
  label,
  onAdd,
}: {
  label: string;
  onAdd: () => void;
}) {
  return (
    <li>
      <button
        className="flex h-29.5 w-full flex-col items-center justify-center gap-2 rounded-tile border border-line border-dashed text-fg-muted transition-[border-color] duration-(--motion-duration-quick) hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset"
        onClick={onAdd}
        type="button"
      >
        <Icon name="plus" size={24} />
        <span className="t-meta">{label}</span>
      </button>
    </li>
  );
}

/** As many compact tiles of 144px (160px past phones) as fit, sharing the
 * width. A note is at least two columns wide, so a tile stays under about
 * one and a half times its minimum. A fixed maximum would set the column
 * count instead: auto-fill counts columns by the larger size. */
export function CompactCardGrid({ children }: { children: ReactNode }) {
  return (
    <ol className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] sm:gap-3">
      {children}
    </ol>
  );
}
