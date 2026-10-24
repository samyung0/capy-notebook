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

const AUDIO_REGION_SPACE = 'audio-ms';

/** Where a cited transcript passage starts in its recording, in
 * milliseconds; undefined for any other citation. */
export function audioStartMs(
  regions: readonly Region[] | null | undefined
): number | undefined {
  const start = regions?.find(
    (region) => region.space === AUDIO_REGION_SPACE
  )?.start_ms;
  return start !== undefined && start >= 0 ? start : undefined;
}

/** A recording position as m:ss, or h:mm:ss past the first hour. */
export function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}
