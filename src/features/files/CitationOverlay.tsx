import type { NormalizedCitationRegion } from './citationRegions';

/** Cited boxes stay laid out (the viewer scrolls to them) but show only while
 * `flashing`. Under reduced motion the box holds instead of pulsing. */
export function CitationOverlay({
  flashing,
  regions,
}: {
  flashing: boolean;
  regions: readonly NormalizedCitationRegion[];
}) {
  if (!regions.length) return null;

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-10">
      {regions.map((region) => (
        <span
          className="absolute rounded-sm border-2 border-solid-warning bg-tint-warning/45 opacity-0 shadow-sm data-flash:animate-[citation-flash_1600ms_ease-out_both] data-flash:opacity-100"
          data-citation-region-index={region.sourceIndex}
          data-flash={flashing || undefined}
          key={region.sourceIndex}
          style={{
            height: `${(region.bottom - region.top) / 10}%`,
            left: `${region.left / 10}%`,
            top: `${region.top / 10}%`,
            width: `${(region.right - region.left) / 10}%`,
          }}
        />
      ))}
    </div>
  );
}
