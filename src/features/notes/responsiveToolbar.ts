export interface ResponsiveToolbarGroup {
  width: number;
}

/**
 * Hides groups from right to left until the toolbar fits.
 *
 * Every group passed here is expendable: anything that has to stay reachable at
 * any width belongs outside the container this measures, because hiding is only
 * half the story — whatever survives can still be clipped by the container's
 * overflow once the remaining groups no longer fit.
 */
export function getHiddenToolbarGroupIndexes(
  groups: readonly ResponsiveToolbarGroup[],
  availableWidth: number
): Set<number> {
  const hidden = new Set<number>();
  let requiredWidth = groups.reduce((total, group) => total + group.width, 0);

  for (
    let index = groups.length - 1;
    index >= 0 && requiredWidth > availableWidth;
    index -= 1
  ) {
    hidden.add(index);
    requiredWidth -= groups[index].width;
  }

  return hidden;
}
