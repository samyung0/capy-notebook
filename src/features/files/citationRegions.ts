import type { Region } from '@/api/types';

export const CITATION_REGION_SPACE = 'page-1000-topleft';

export interface NormalizedCitationRegion {
  bottom: number;
  left: number;
  page: number;
  right: number;
  sourceIndex: number;
  top: number;
}

function clampCoordinate(value: number) {
  return Math.min(1000, Math.max(0, value));
}

/** Drops malformed or unknown coordinate spaces before they reach CSS. */
export function normalizeCitationRegions(
  regions: readonly Region[] | undefined
): NormalizedCitationRegion[] {
  if (!regions) return [];

  return regions.flatMap((region, sourceIndex) => {
    if (
      region.space !== CITATION_REGION_SPACE ||
      !Number.isInteger(region.page) ||
      region.page < 1 ||
      region.bbox?.length !== 4 ||
      !region.bbox.every(Number.isFinite)
    ) {
      return [];
    }

    const [rawLeft, rawTop, rawRight, rawBottom] = region.bbox;
    const left = clampCoordinate(rawLeft);
    const top = clampCoordinate(rawTop);
    const right = clampCoordinate(rawRight);
    const bottom = clampCoordinate(rawBottom);
    if (right <= left || bottom <= top) return [];

    return [{ bottom, left, page: region.page, right, sourceIndex, top }];
  });
}
