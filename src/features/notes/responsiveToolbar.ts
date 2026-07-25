export interface ResponsiveToolbarGroup {
  persistent?: boolean;
  width: number;
}

/** Hides groups from right to left until the toolbar fits. */
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
    const group = groups[index];
    if (group.persistent) continue;

    hidden.add(index);
    requiredWidth -= group.width;
  }

  return hidden;
}
