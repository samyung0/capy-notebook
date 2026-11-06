/** GeoGebra's tick step: 100px worth of units rounded down to 1, 2 or 5 × 10ⁿ. Apart
 * from the graph editor, so the drawing board's previews take it without the editor's
 * imports. */
export function tickStep(pixelsPerUnit: number) {
  const units = 100 / pixelsPerUnit;
  const power = 10 ** Math.floor(Math.log10(units));
  const n = units / power;
  return (n > 5 ? 5 : n > 2 ? 2 : 1) * power;
}
