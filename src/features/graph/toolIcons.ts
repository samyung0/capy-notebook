/* The graph tools' icons, 24 px line drawings in the board's maths style:
 * the canvas plane's tools and its objects list, and the question graph
 * editor's tools and rows, one set for both (Epo 2026-11-16). */

/** Each tool's icon, and each kind's in a row of the objects list. */
export const TOOL_ICONS: Record<string, string> = {
  // The constructions, which rows name by their points.
  angle:
    '<path d="M20 18H4l11-13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 18a6 6 0 0 0-2-4.6" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  arc: '<path d="M4 17a8 8 0 0 1 16 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="12" cy="17" r="1.8" fill="currentColor"/>',
  circle:
    '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/>',
  curve:
    '<path d="M4 6c2 9 5 13 8 13s6-5 8-14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="4.5" cy="7" r="2" fill="currentColor"/><circle cx="12" cy="19" r="2" fill="currentColor"/><circle cx="19.5" cy="7" r="2" fill="currentColor"/>',
  ellipse:
    '<ellipse cx="12" cy="12" rx="8.5" ry="6" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="20.5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="6" r="1.8" fill="currentColor"/><circle cx="3.5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="18" r="1.8" fill="currentColor"/>',
  erase:
    '<path d="m9 20 11-11-5-5L4 15l5 5Zm0 0h11M8 11l5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  formula:
    '<path d="M18 5H7l6 7-6 7h11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  function:
    '<path d="M9 20c1.6 0 2.2-1.4 2.5-3.2L13.6 6.4C13.9 4.8 14.6 4 16 4M8.5 10h6.5M14.5 14l5 5M19.5 14l-5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  label:
    '<path d="M5 6V4h14v2M12 4v16M9 20h6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  line: '<path d="M6 18 18 6" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="5" cy="19" r="2.2" fill="currentColor"/><circle cx="19" cy="5" r="2.2" fill="currentColor"/>',
  point:
    '<path d="M12 3v5M12 16v5M3 12h5M16 12h5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/>',
  polygon:
    '<path d="M12 4l8 15H4Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
  sector:
    '<path d="M12 19 4.5 11.5a10.6 10.6 0 0 1 15 0Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
  segment:
    '<path d="M6 18 18 6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9 11l4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="5" cy="19" r="2.2" fill="currentColor"/><circle cx="19" cy="5" r="2.2" fill="currentColor"/>',
  select:
    '<path d="M6 3.5 18.5 10.5l-5.8 1.6-2.7 5.9L6 3.5Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
  through:
    '<path d="M3 21 21 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="16" r="2.2" fill="currentColor"/><circle cx="16" cy="8" r="2.2" fill="currentColor"/>',
  vector:
    '<path d="M5 19 17.5 6.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M20 4l-1.4 6.6-5.2-5.2Z" fill="currentColor"/><circle cx="5" cy="19" r="2.2" fill="currentColor"/>',
};

/** One icon as an SVG string. */
export const toolIcon = (name: string) =>
  `<svg aria-hidden="true" height="24" viewBox="0 0 24 24" width="24">${TOOL_ICONS[name]}</svg>`;
