import { type ReactNode, useContext } from 'react';
import { Card } from '@/components/ui/Card';
import type { FlashcardContent } from '@/features/materials/blocks';
import {
  AssetUrlContext,
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
  card: FlashcardContent;
  className?: string;
  size?: 'tile' | 'panel' | 'compact' | 'large';
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        size === 'tile' || size === 'panel' ? 'gap-2' : 'gap-3',
        className
      )}
    >
      <p
        className={cn(
          'whitespace-pre-line break-words',
          size === 'large' && 't-large-card-title',
          size === 'panel' && 't-subtitle',
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
            size === 'panel' && 'h-14',
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
 * image stays on the front. A tile (result lists) caps the front's and the
 * back's heights, each scrolling without a scrollbar, edges fading. */
export function CardBackFace({
  card,
  className,
  size,
}: {
  card: Pick<FlashcardContent, 'back' | 'front'>;
  className?: string;
  size: 'large' | 'compact' | 'panel' | 'tile';
}) {
  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <p
        className={cn(
          'shrink-0 whitespace-pre-line break-words border-divider border-b text-center font-bold text-fg-secondary',
          size === 'large' && 'px-7 pt-5.5 pb-4 text-base',
          size === 'compact' && 'px-5 pt-3.5 pb-2.5 text-sm',
          size === 'panel' && 'px-4 pt-2.5 pb-2 text-xs',
          size === 'tile' &&
            'scroll-fade-y max-h-22 overflow-y-auto px-4.5 pt-4 pb-3 text-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
        )}
      >
        {card.front}
      </p>
      <div
        className={cn(
          'flex min-h-0 flex-1 items-center justify-center overflow-auto',
          size === 'large' && 'p-7 text-lg',
          size === 'compact' && 'p-5',
          size === 'panel' && 'px-4 py-2.5',
          size === 'tile' &&
            'scroll-fade-y items-center-safe max-h-52 px-3 py-4 text-[15px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
        )}
      >
        <CardBack card={card} />
      </div>
    </div>
  );
}

/** A grid tile showing only the front. `children` sits over the corner (the
 * edit toolbar). */
export function CardTile({
  card,
  onOpen,
  label,
  children,
}: {
  card: FlashcardContent;
  onOpen: () => void;
  label: string;
  children?: ReactNode;
}) {
  return (
    // The Card lifts on hover like the Add card tile, the toolbar with it.
    <Card
      className="group/tile relative aspect-[4/3] gap-0 p-0"
      interactive
      radius="card-lg"
      theme="transparent"
    >
      <button
        aria-label={label}
        className="flex size-full items-center justify-center overflow-hidden rounded-card-lg border border-line bg-surface p-5 focus-visible:ring-2 focus-visible:ring-action"
        onClick={onOpen}
        type="button"
      >
        <CardFront card={card} className="size-full" />
      </button>
      {children}
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
        'grid min-h-115 grid-rows-2 overflow-hidden rounded-card-lg border border-line bg-surface',
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

/** Three columns in a wide pane, fewer as it narrows. */
export function CardGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
      {children}
    </div>
  );
}
