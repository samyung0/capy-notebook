/** MathLive's HTML commands put raw CSS (`\style`, `\htmlStyle`), classes,
 * ids and data attributes (`\class`, `\htmlClass`, `\cssId`, `\htmlId`,
 * `\htmlData`) and links (`\href`, `\url`) into the page, and `\csname` builds
 * any command from its letters. They are a documented MathLive feature and
 * stay raw in every version, so a read-only render (MathPreview, shared-note
 * SSR) draws them as text: the command shows as `\name` and its arguments as
 * plain groups. `\\` is a line break, so `\\style` stays a break and a word
 * while `\\\style` is a break and the command.
 *
 * MathLive 0.111's strict-grammar CSS validation drops the invalid colours,
 * borders, backgrounds and font families the other commands (`\color`,
 * `\colorbox`, `\bbox`, `\enclose`, `\fontfamily`, …) once let through, and
 * its `\enclose`/`\href`/`\htmlData` quoting fixes close the SVG-overlay and
 * attribute-breakout paths, so only these commands still need drawing as text.
 * The stored LaTeX is unchanged. */
const HTML_COMMANDS =
  /(?<!\\)((?:\\\\)*)\\(style|htmlStyle|class|htmlClass|cssId|htmlId|htmlData|href|url|csname)(?![a-zA-Z])/g;

export const inertTex = (tex: string) =>
  tex.replace(HTML_COMMANDS, '$1\\backslash\\mathrm{$2}');
