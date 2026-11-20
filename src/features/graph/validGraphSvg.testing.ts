/* The static SVG subset a graph exports to (the note export, `graphSvg`): no
 * active content or external resources. Only tests check an export against
 * it; no graph stores one (Epo 2026-11-16). */

const svgStart = /^\s*<svg[\s>]/;
const svgEnd = /<\/svg>\s*$/;
const unsafeSvg =
  /<!|<\?|\bon\w+\s*=|javascript:|data:|<\s*\/?\s*(?:script|foreignObject|style|image|use|a|animate\w*|set)\b/i;
const svgReferences =
  /(?:[a-z]+:)?(?:href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const svgLocalReference = /^["']#[A-Za-z0-9_-]+["']$/;
const svgUrls = /url\s*\([^)]*\)/gi;
const svgLocalUrl = /^url\s*\(\s*["']?#[A-Za-z0-9_-]+["']?\s*\)$/i;
const svgEscapedStyle = /style\s*=\s*(?:"[^"<>]*\\|'[^'<>]*\\)/i;

export function validGraphSvg(svg: string): boolean {
  if (!(svgStart.test(svg) && svgEnd.test(svg))) return false;
  if (unsafeSvg.test(svg) || svgEscapedStyle.test(svg)) return false;
  for (const match of svg.matchAll(svgReferences))
    if (!svgLocalReference.test(match[1])) return false;
  for (const match of svg.matchAll(svgUrls))
    if (!svgLocalUrl.test(match[0])) return false;
  const allowed = new Set([
    'svg',
    'g',
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    'text',
    'tspan',
    'defs',
    'marker',
    'clipPath',
    'title',
    'desc',
  ]);
  return [...svg.matchAll(/<\/?([A-Za-z][\w:-]*)\b/g)].every((match) =>
    allowed.has(match[1])
  );
}
