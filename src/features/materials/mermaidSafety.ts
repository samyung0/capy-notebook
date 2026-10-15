import type { Mermaid, MermaidConfig } from 'mermaid';

/*
 * A diagram loads nothing from outside the page. Mermaid draws into a host
 * that is already in the document (it measures labels as it draws), so
 * anything that fetches does so while it draws: the source is made inert
 * before `mermaid.render`, not cleaned afterwards. Every surface (chat, note
 * blocks, mindmap and diagram files, shared-page islands, exports) draws
 * through `renderMermaid`, which applies all of this.
 */

/** Settings `renderMermaid` applies last, over the theme preset. */
export const MERMAID_SECURITY = {
  // HTML labels (and icons) keep no element or attribute that loads a file.
  dompurifyConfig: {
    FORBID_ATTR: ['background', 'poster', 'src', 'srcset'],
    FORBID_TAGS: [
      'audio',
      'feimage',
      'image',
      'img',
      'input',
      'picture',
      'source',
      'style',
      'track',
      'video',
    ],
  },
  // A diagram's front matter and %%{init}%% directives can't change these;
  // mermaid keeps its own locked keys (securityLevel and others) as well.
  secure: ['altFontFamily', 'dompurifyConfig', 'fontFamily', 'themeCSS'],
  securityLevel: 'strict',
} satisfies MermaidConfig;

/** A CSS function that loads an image: `url(` or `image-set(` (with any
 * vendor prefix). CSS fetches only when the bracket follows the name with no
 * space, so "the URL (a link)" in a label is left alone. The lookbehind keeps
 * `curl(` and the like from matching `url(`. */
const IMAGE_FUNCTION = /(?<![\w\u0080-￿-])url\(|image-set\(/;
/** Mermaid's own directive pattern: it cuts directives out before parsing,
 * which joins the text on either side. */
const DIRECTIVE =
  /%{2}{\s*(?:(\w+)\s*:|(\w+))\s*(?:(\w+)|((?:(?!}%{2}).|\r?\n)*))?\s*(?:}%{2})?/gi;
/** Mermaid's entity placeholders, which its drawn SVG turns back into the
 * character references below. */
const PLACEHOLDER = /ﬂ°°|ﬂ°|¶ß/g;
const PLACEHOLDER_TEXT: Record<string, string> = {
  '¶ß': ';',
  'ﬂ°': '&',
  'ﬂ°°': '&#',
};
/** Mermaid's `#…;` entities, which become references in the drawn SVG. */
const MERMAID_ENTITY = /#(\w+);/g;
/** A numeric entity name (`#123;`), told from a named one. */
const DIGITS = /^\d+$/;
/** Character references. Of the named ones only these spell part of an
 * image function, a joined `;` or an escape. */
const REFERENCE = /&#x([\da-f]+);?|&#(\d+);?|&(lpar|bsol|semi);/gi;
const NAMED: Record<string, string> = { bsol: '\\', lpar: '(', semi: ';' };
/** YAML `\U` (8 digits), JSON and YAML `\u` (4) and YAML `\x` (2), CSS hex
 * escapes with their one trailing space, YAML's escaped line break and any
 * escaped character. Case matters: CSS reads `\u` and `\U` as the letter. */
const ESCAPE =
  /\\(?:U([\dA-Fa-f]{8})|u([\dA-Fa-f]{4})|x([\dA-Fa-f]{2})|([\dA-Fa-f]{1,6})\s?|\r?\n[ \t]*|([\s\S]))/g;

function codePoint(digits: string, radix: number) {
  const value = Number.parseInt(digits, radix);
  return value > 0x10_ff_ff ? '�' : String.fromCodePoint(value);
}

function references(text: string) {
  return text.replace(
    REFERENCE,
    (_, hex?: string, decimal?: string, name?: string) =>
      hex
        ? codePoint(hex, 16)
        : decimal
          ? codePoint(decimal, 10)
          : NAMED[(name ?? '').toLowerCase()]
  );
}

function decodeOnce(text: string) {
  // References are read both before and after mermaid's entities, so either
  // reading of a mixed spelling is caught.
  return references(
    references(
      text.replace(PLACEHOLDER, (placeholder) => PLACEHOLDER_TEXT[placeholder])
    ).replace(MERMAID_ENTITY, (_, name: string) =>
      DIGITS.test(name) ? `&#${name};` : `&${name};`
    )
  ).replace(
    ESCAPE,
    (
      _,
      long?: string,
      short?: string,
      byte?: string,
      css?: string,
      char?: string
    ) => {
      const digits = long ?? short ?? byte ?? css;
      return digits ? codePoint(digits, 16) : (char ?? '');
    }
  );
}

/** The text the way the browser finally reads it, decoded until nothing
 * changes; decoding more than the browser does only drops more. */
function decoded(text: string) {
  let current = text;
  for (
    let next = decodeOnce(current);
    next !== current;
    next = decodeOnce(next)
  )
    current = next;
  return current.toLowerCase();
}

/** Whether the text names a CSS image function, read with and without
 * mermaid's directives and with the `;` mermaid drops from style lines. */
function namesImageFunction(text: string) {
  return [text, text.replace(DIRECTIVE, '')].some((variant) => {
    const view = decoded(variant);
    return (
      IMAGE_FUNCTION.test(view) || IMAGE_FUNCTION.test(view.replaceAll(';', ''))
    );
  });
}

/**
 * The source with every line that names a CSS image function blanked (so
 * error line numbers still match): `style`, `classDef`, `linkStyle` and the
 * other style statements, a theme or config value, or an inline style in a
 * label. One spelled across lines refuses the whole diagram.
 */
export function withoutImageFunctions(code: string) {
  const kept = code
    .split('\n')
    .map((line) => (namesImageFunction(line) ? '' : line))
    .join('\n');
  if (namesImageFunction(kept))
    throw new Error('The diagram names an image to load.');
  return kept;
}

/** The syntax that can give mermaid an image URL: shape data (`@{ … }`, an
 * image node's `img`) and a sequence actor's `properties` and `details`
 * (its `icon`). */
const IMAGE_SYNTAX = /@\{|\b(?:properties|details)\b/i;
const IMG_FIELD = /(["']?)img\1\s*:\s*(?:"[^"\n]*"|'[^'\n]*'|[^,}\n]*),?/g;
const ACTOR_PROPERTIES = /^[^\S\n]*(?:properties|details)\b.*$/gim;

interface Drawn {
  img?: unknown;
  properties?: { icon?: unknown };
}
interface ImageDb {
  getActors?: () => { values(): Iterable<Drawn | string> };
  getVertices?: () => { values(): Iterable<Drawn> };
}

async function drawsImage(mermaid: Mermaid, source: string) {
  // The parsed diagram's db, read only for the fields an image can reach.
  const db = (await mermaid.mermaidAPI.getDiagramFromText(source))
    .db as unknown as ImageDb;
  return [
    ...(db.getVertices?.().values() ?? []),
    ...(db.getActors?.().values() ?? []),
  ].some(
    (item) =>
      typeof item === 'object' && Boolean(item.img || item.properties?.icon)
  );
}

/**
 * The source without image nodes' `img` fields and sequence actors'
 * `properties` and `details` lines, when mermaid's own parse says the
 * diagram draws an image; one it still draws after that is refused.
 */
export async function withoutImages(mermaid: Mermaid, source: string) {
  if (!IMAGE_SYNTAX.test(source) || !(await drawsImage(mermaid, source)))
    return source;
  const without = source.replace(IMG_FIELD, '').replace(ACTOR_PROPERTIES, '');
  if (await drawsImage(mermaid, without))
    throw new Error('The diagram draws an image from a URL.');
  return without;
}

const LINK = /<a[\s>]/;

/** Every link in a drawn diagram opens in a new tab that cannot reach this
 * one (Epo 2026-10-15). The template parses the SVG without loading
 * anything. */
export function withSafeLinks(svg: string) {
  if (!LINK.test(svg)) return svg;
  const template = document.createElement('template');
  template.innerHTML = svg;
  for (const link of template.content.querySelectorAll('a')) {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }
  return template.innerHTML;
}
