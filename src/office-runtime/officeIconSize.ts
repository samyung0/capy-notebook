/** Chevrons, check marks and the table edge's + in its 20px box keep the
 * smaller size the editor asks for. */
const KEEP_SIZE = new Set([
  'arrow_drop_down',
  'check',
  'chevronDown',
  'expand_more',
  'keyboard_arrow_right',
  'table-insert',
]);

/** Every other Office icon draws at 18px, Capy's smallest icon in a control. */
export function officeIconSize(name: string, size: number): number {
  return KEEP_SIZE.has(name) ? Math.min(size, 18) : 18;
}
