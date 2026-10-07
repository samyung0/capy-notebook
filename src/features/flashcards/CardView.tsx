import { type ReactNode, useContext } from 'react';
import type { FlashcardContent } from '@/features/materials/blocks';
import {
  AssetUrlContext,
  useResolvedAsset,
} from '@/features/materials/MediaAssetView';
import { cn } from '@/lib/cn';

/** The front as the grid, previews and study show it: the text, centred. */
export function CardFront({
  card,
  className,
  large = false,
}: {
  card: FlashcardContent;
  className?: string;
  large?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 text-center',
        className
      )}
    >
      <p
        className={cn(
          'whitespace-pre-line break-words',
          large ? 't-large-card-title' : 't-card-title'
        )}
      >
        {card.front}
      </p>
      {card.image && (
        <CardImage
          assetId={card.image.assetId}
          className={large ? 'h-30' : 'max-h-[38%]'}
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
export function CardBack({ card }: { card: FlashcardContent }) {
  return (
    <p className="max-w-[52ch] whitespace-pre-line break-words text-center leading-relaxed">
      {card.back}
    </p>
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
    <div className="group/tile relative aspect-[4/3]">
      <button
        aria-label={label}
        className="flex size-full items-center justify-center overflow-hidden rounded-card-lg border border-line bg-surface p-5 transition-shadow hover:shadow-card focus-visible:ring-2 focus-visible:ring-action"
        onClick={onOpen}
        type="button"
      >
        <CardFront card={card} className="size-full" />
      </button>
      {children}
    </div>
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
      <CardFront card={card} className="p-7" large />
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
