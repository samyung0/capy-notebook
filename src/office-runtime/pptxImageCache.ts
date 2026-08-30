export const MAX_PPTX_IMAGE_CACHE_ENTRIES = 24;

type ImageSource = CanvasImageSource;
type ImagePromise = Promise<ImageSource | null>;
type ReleaseImage = (source: ImageSource) => void;

export class PptxImageCache {
  private readonly entries = new Map<string, ImagePromise>();
  private readonly maxEntries: number;
  private readonly releaseImage: ReleaseImage;

  constructor(
    maxEntries = MAX_PPTX_IMAGE_CACHE_ENTRIES,
    releaseImage: ReleaseImage = closeImage
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('PPTX image cache size must be a positive integer');
    }
    this.maxEntries = maxEntries;
    this.releaseImage = releaseImage;
  }

  get(assetId: string): ImagePromise | undefined {
    const image = this.entries.get(assetId);
    if (!image) return;
    this.entries.delete(assetId);
    this.entries.set(assetId, image);
    return image;
  }

  set(assetId: string, image: ImagePromise): void {
    const previous = this.entries.get(assetId);
    if (previous) this.releaseWhenReady(previous);
    this.entries.delete(assetId);
    this.entries.set(assetId, image);
    this.evict();
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    const images = [...this.entries.values()];
    this.entries.clear();
    for (const image of images) this.releaseWhenReady(image);
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) return;
      this.entries.delete(oldest[0]);
      this.releaseWhenReady(oldest[1]);
    }
  }

  private releaseWhenReady(image: ImagePromise): void {
    void image.then(
      (source) => {
        if (source) this.releaseImage(source);
      },
      () => undefined
    );
  }
}

function closeImage(source: ImageSource): void {
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
    source.close();
  }
}
