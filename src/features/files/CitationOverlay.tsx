import type { NormalizedCitationRegion } from './citationRegions';

export function CitationOverlay({
  regions,
}: {
  regions: readonly NormalizedCitationRegion[];
}) {
  if (!regions.length) return null;

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-10">
      {regions.map((region) => (
        <span
          className="absolute rounded-sm border-2 border-solid-warning bg-tint-warning/45 shadow-sm"
          data-citation-region-index={region.sourceIndex}
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
