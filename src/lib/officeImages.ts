import { unzipSync, type Zippable, zipSync } from 'fflate';
import { fitImage, ImageUnreadableError } from '@/lib/fitImage';

/** A DOCX, PPTX or XLSX upload with its pictures compressed and the pictures
 * nothing can show removed with what shows them (Epo 2026-10-24, Q337):
 * EMF, WMF, SVG (its PNG fallback stays), formats the compressor does not
 * try and pictures it cannot decode; `removed` counts those removed where
 * they showed. `file` is the picked file itself when nothing changed. The
 * import worker does the same (pipeline/pipeline/ingest/images.py). */
export interface OfficeImagesResult {
  file: File;
  removed: number;
}

/** The archive the browser opens at most, as the upload analysis probe
 * (sourceAnalysisCore.ts) and the server checks; a larger one is sent as it
 * is and the server refuses it. */
const MAX_ENTRIES = 4096;
const MAX_EXPANDED = 256 << 20;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** What a part's bytes are, by signature: an EMF or WMF picture, a raster
 * format the compressor tries, or null for anything else (SVG, HD Photo,
 * PICT, EPS...), which is removed. */
export function pictureKind(bytes: Uint8Array, path: string) {
  const at = (offset: number, ...values: number[]) =>
    values.every((value, i) => bytes[offset + i] === value);
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (
    ['emf', 'wmf', 'emz', 'wmz'].includes(ext) ||
    (at(0, 1, 0, 0, 0) && at(40, 0x20, 0x45, 0x4d, 0x46)) ||
    at(0, 0xd7, 0xcd, 0xc6, 0x9a) ||
    ((at(0, 1, 0) || at(0, 2, 0)) && at(2, 9, 0))
  )
    return 'vector';
  // An SVG by name, whatever it holds (the checks refuse it by name).
  if (['svg', 'svgz'].includes(ext)) return null;
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x42, 0x4d)) return 'image/bmp';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
    return 'image/webp';
  if (at(0, 0x49, 0x49, 0x2a, 0) || at(0, 0x4d, 0x4d, 0, 0x2a))
    return 'image/tiff';
  return null;
}

const SVG_ROOT =
  /^(?:\s|<\?[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*<svg[\s>/]/;

/** An SVG, by name or by its root element in the first 4 KiB, as the server
 * checks read it. */
function isSvg(bytes: Uint8Array, path: string) {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'svg' || ext === 'svgz') return true;
  // The decoder drops a byte-order mark.
  return SVG_ROOT.test(decoder.decode(bytes.subarray(0, 4096)));
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);
const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** A relationship target as a part name: relative to its source part's
 * folder, or from the package root when it starts with "/". */
export function resolveTarget(sourceDir: string, target: string) {
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    // Kept as written.
  }
  const parts: string[] = [];
  const joined = decoded.startsWith('/') ? decoded : sourceDir + decoded;
  for (const segment of joined.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment && segment !== '.') parts.push(segment);
  }
  return parts.join('/');
}

interface Relationship {
  /** The whole element, to edit it in place. */
  element: string;
  id: string;
  /** The part it targets; null for an external target. */
  part: string | null;
  target: string;
  type: string;
}

const attribute = (element: string, name: string) =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`)
    .exec(element)
    ?.slice(1)
    .find((value) => value !== undefined) ?? '';

/** The part a relationships part describes: word/_rels/document.xml.rels
 * holds those of word/document.xml, _rels/.rels the package's. */
const RELS_DIR = /_rels\/$/;
const RELS_EXT = /\.rels$/;
const sourceOf = (rels: string) =>
  dirOf(rels).replace(RELS_DIR, '') + baseOf(rels).replace(RELS_EXT, '');

/** The relationship types whose targets are pictures: images (pictures,
 * fills, object previews, SVG) and HD Photo originals; audio and video stay
 * media. */
const PICTURE_TYPES = ['/image', '/hdphoto'];

function relationships(rels: string, xml: string): Relationship[] {
  const sourceDir = dirOf(sourceOf(rels));
  return [...xml.matchAll(/<Relationship\b[^>]*>/g)].map(([element]) => {
    const target = attribute(element, 'Target');
    return {
      element,
      id: attribute(element, 'Id'),
      part:
        attribute(element, 'TargetMode') === 'External'
          ? null
          : resolveTarget(sourceDir, target),
      target,
      type: attribute(element, 'Type'),
    };
  });
}

/** The elements that show a picture in a part, by part. The innermost one
 * around a reference to a removed picture goes with it (widened by `pick`):
 * DOCX drawings, VML pictures and objects (with their OLE parts); PPTX
 * pictures, picture fills and OLE frames; XLSX drawing anchors and sheet OLE
 * objects; chart and SmartArt picture fills; legacy VML shapes. */
const CHART_OR_DIAGRAM = /^(word|ppt|xl)\/(charts|diagrams)\//;

function containers(path: string): string[] | null {
  if (path.endsWith('.vml')) return ['v:shape'];
  if (!path.endsWith('.xml')) return null;
  if (CHART_OR_DIAGRAM.test(path)) return ['a:blipFill'];
  if (path.startsWith('word/')) return ['w:drawing', 'w:pict', 'w:object'];
  if (path.startsWith('ppt/')) return ['p:pic', 'a:blipFill', 'p:graphicFrame'];
  if (path.startsWith('xl/drawings/'))
    return ['xdr:twoCellAnchor', 'xdr:oneCellAnchor', 'xdr:absoluteAnchor'];
  if (path.startsWith('xl/worksheets/')) return ['oleObject'];
  return null;
}

/** The element to remove for a reference inside `stack` (open element names,
 * outermost first), or -1: the innermost container, widened to the object
 * that holds it (a DOCX object, a PPTX OLE frame, a slide background, or the
 * alternate content around an OLE frame or sheet object). */
const ALTERNATE = /^mc:(Choice|Fallback)$/;
const BESIDE_BLIP = /:(svgBlip|imgLayer)$/;

function pick(names: string[], stack: string[]) {
  // An SVG or HD Photo beside a picture's own blip: only the extension
  // holding it goes, and the picture stays.
  if (BESIDE_BLIP.test(stack.at(-1) ?? ''))
    for (let i = stack.length - 2; i >= 0; i--)
      if (stack[i].endsWith(':ext')) return i;
  let at = -1;
  for (let i = stack.length - 1; i >= 0 && at < 0; i--)
    if (names.includes(stack[i])) at = i;
  if (at < 0) return -1;
  const object = stack.lastIndexOf('w:object', at);
  if (object >= 0 && !stack.slice(object, at).includes('w:txbxContent'))
    at = object;
  const ole = stack.lastIndexOf('p:oleObj', at);
  if (stack[at] !== 'p:graphicFrame' && ole >= 0)
    at = stack.lastIndexOf('p:graphicFrame', ole);
  if (
    stack[at] === 'a:blipFill' &&
    stack[at - 1] === 'p:bgPr' &&
    stack[at - 2] === 'p:bg'
  )
    at -= 2;
  if (
    (stack[at] === 'p:graphicFrame' || stack[at] === 'oleObject') &&
    stack[at - 2] === 'mc:AlternateContent' &&
    ALTERNATE.test(stack[at - 1] ?? '')
  )
    at -= 2;
  return at;
}

const MEDIA = /^(word|ppt|xl)\/media\//;
const TARGET = /(\sTarget\s*=\s*)(["'])[^"']*\2/;
const TYPES = /<Types\b[^>]*>/;
const REFERENCE =
  /\s[\w.-]+:(?:embed|link|id|pict|relid)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const references = (xml: string) =>
  [...xml.matchAll(REFERENCE)].map((match) => match[1] ?? match[2]);
const MARKUP =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[?!][\s\S]*?>|<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const EMPTY_EXTENSIONS = /<([\w.-]+:)?extLst\b[^>]*>\s*<\/\1extLst>/g;

/** Removes from a part's XML every container (`containers`) that refers to
 * one of `ids`. Returns the new XML, the ids the removed elements referred
 * to, and how many pictures were removed where they show (an element inside
 * mc:Fallback, or in a VML part, shows only beside one counted already, and
 * an extension beside a picture that stays is not counted). */
export function removePictures(path: string, xml: string, ids: Set<string>) {
  const names = containers(path);
  const empty = { count: 0, refs: [] as string[], xml };
  if (!names) return empty;
  const stack: {
    counted: boolean;
    name: string;
    remove: boolean;
    start: number;
  }[] = [];
  const spans: [number, number, boolean][] = [];
  for (const match of xml.matchAll(MARKUP)) {
    const [whole, close, name, attrs, selfClosing] = match;
    if (!name) continue;
    const start = match.index;
    const end = start + whole.length;
    if (close) {
      const open = stack.pop();
      if (open?.remove) spans.push([open.start, end, open.counted]);
      continue;
    }
    const entry = { counted: false, name, remove: false, start };
    stack.push(entry);
    if (references(attrs).some((id) => ids.has(id))) {
      const at = pick(
        names,
        stack.map((open) => open.name)
      );
      if (at >= 0) {
        stack[at].remove = true;
        stack[at].counted =
          !path.endsWith('.vml') &&
          !stack[at].name.endsWith(':ext') &&
          !stack.slice(0, at).some((open) => open.name === 'mc:Fallback');
      }
    }
    if (selfClosing) {
      stack.pop();
      if (entry.remove) spans.push([start, end, entry.counted]);
    }
  }
  if (spans.length === 0) return empty;
  // Inner spans close first; keep only the outermost.
  spans.sort((a, b) => a[0] - b[0]);
  let out = '';
  let from = 0;
  let count = 0;
  const refs: string[] = [];
  for (const [start, end, counted] of spans) {
    if (start < from) continue;
    out += xml.slice(from, start);
    refs.push(...references(xml.slice(start, end)));
    if (counted) count += 1;
    from = end;
  }
  out += xml.slice(from);
  // A sheet's OLE list and an extension list may not be empty.
  out = out
    .replace(/<oleObjects>\s*<\/oleObjects>/g, '')
    .replace(EMPTY_EXTENSIONS, '');
  return { count, refs, xml: out };
}

/** Compresses the raster pictures of an Office package with the Office insert
 * rules and removes the pictures nothing can show with what shows them; see
 * OfficeImagesResult. EMF and WMF parts nothing refers to and document
 * thumbnails in those formats go too, uncounted, and an SVG part outside the
 * pictures, counted when nothing showed it. `onProgress` hears each picture
 * compressed. */
export async function compressOfficeImages(
  file: File,
  imageMaxBytes: number,
  onProgress?: (done: number, total: number) => void
): Promise<OfficeImagesResult> {
  const unchanged = { file, removed: 0 };
  const data = new Uint8Array(await file.arrayBuffer());
  const stored = new Set<string>();
  let entries = 0;
  let expanded = 0;
  let parts: Record<string, Uint8Array<ArrayBuffer>>;
  try {
    // fflate inflates into fresh buffers, never shared ones.
    parts = unzipSync(data, {
      filter: (entry) => {
        entries += 1;
        expanded += entry.originalSize;
        if (entry.compression === 0) stored.add(entry.name);
        return entries <= MAX_ENTRIES && expanded <= MAX_EXPANDED;
      },
    }) as Record<string, Uint8Array<ArrayBuffer>>;
  } catch {
    return unchanged;
  }
  if (entries > MAX_ENTRIES || expanded > MAX_EXPANDED) return unchanged;
  const text = (path: string) => decoder.decode(parts[path]);
  const write = (path: string, xml: string) => {
    parts[path] = encoder.encode(xml);
  };
  const paths = Object.keys(parts);
  const rels = new Map(
    paths
      .filter((path) => path.endsWith('.rels'))
      .map((path) => [path, relationships(path, text(path))])
  );
  const targeted = (part: string) =>
    [...rels.values()].some((list) => list.some((rel) => rel.part === part));
  // An image relationship's targets, and media parts no other relationship
  // targets.
  const other = new Set<string>();
  const pictures = new Set<string>();
  for (const list of rels.values())
    for (const rel of list)
      if (rel.part)
        (PICTURE_TYPES.some((type) => rel.type.endsWith(type))
          ? pictures
          : other
        ).add(rel.part);
  for (const path of paths)
    if (MEDIA.test(path) && !other.has(path)) pictures.add(path);
  const kinds = new Map(
    paths.map((path) => [path, pictureKind(parts[path], path)])
  );
  let changed = false;
  let removed = 0;
  const deleted = new Set<string>();
  // An SVG outside the picture parts goes too (review r2 N12), counted below
  // when no relationship showed it.
  const straySvgs = new Set(
    paths.filter((path) => !pictures.has(path) && isSvg(parts[path], path))
  );
  const shown = new Set(
    [...rels.values()].flatMap((list) => list.map((rel) => rel.part))
  );
  const gone = new Set([
    ...straySvgs,
    ...paths.filter((path) => {
      const kind = kinds.get(path);
      return (
        (pictures.has(path) && (!kind || kind === 'vector')) ||
        (kind === 'vector' && !path.endsWith('.xml') && !path.endsWith('.rels'))
      );
    }),
  ]);

  // Rasters first, each through the insert compressor: one it cannot decode
  // joins the removals; a format change renames the part, its relationships
  // and its content type.
  const rasters = paths.filter((path) => pictures.has(path) && !gone.has(path));
  const renames = new Map<string, { path: string; type: string }>();
  for (const [index, path] of rasters.entries()) {
    const type = kinds.get(path)!;
    let result: File;
    try {
      result = await fitImage(
        new File([parts[path]], baseOf(path), { type }),
        imageMaxBytes,
        { office: true }
      );
    } catch (error) {
      // One nothing fits stays as it is; the server check decides.
      if (error instanceof ImageUnreadableError) gone.add(path);
      onProgress?.(index + 1, rasters.length);
      continue;
    }
    onProgress?.(index + 1, rasters.length);
    if (result.type === type && result.size === parts[path].length) continue;
    const bytes = new Uint8Array(await result.arrayBuffer());
    changed = true;
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    const wanted = result.type === 'image/png' ? ['png'] : ['jpeg', 'jpg'];
    if (wanted.includes(ext)) {
      parts[path] = bytes;
      continue;
    }
    const stem = path.slice(0, path.lastIndexOf('.'));
    let renamed = `${stem}.${wanted[0]}`;
    for (
      let n = 1;
      renamed in parts || [...renames.values()].some((r) => r.path === renamed);
      n++
    )
      renamed = `${stem}-${n}.${wanted[0]}`;
    renames.set(path, { path: renamed, type: result.type });
    parts[path] = bytes;
  }

  // Removals: each element that shows a removed picture goes, then every
  // relationship nothing refers to any more (a thumbnail's, whose package
  // shows it nowhere, among them), then the parts nothing targets.
  const dropped: string[] = [];
  for (const [relsPath, list] of rels) {
    const ids = list
      .filter((rel) => rel.part && gone.has(rel.part))
      .map((rel) => rel.id);
    if (ids.length === 0) continue;
    const source = sourceOf(relsPath);
    const refs = [...ids];
    let left = new Set<string>();
    if (source in parts) {
      const result = removePictures(source, text(source), new Set(ids));
      if (result.xml !== text(source)) {
        write(source, result.xml);
        removed += result.count;
        changed = true;
      }
      refs.push(...result.refs);
      left = new Set(references(result.xml));
    }
    const dead = new Set(refs.filter((id) => !left.has(id)));
    if (dead.size === 0) continue;
    let relsXml = text(relsPath);
    const kept = list.filter((rel) => {
      if (!dead.has(rel.id)) return true;
      relsXml = relsXml.replace(rel.element, '');
      if (rel.part) dropped.push(rel.part);
      return false;
    });
    rels.set(relsPath, kept);
    write(relsPath, relsXml);
    changed = true;
  }
  for (const part of new Set([...dropped, ...gone]))
    if (part in parts && !targeted(part)) {
      deleted.add(part);
      if (straySvgs.has(part) && !shown.has(part)) removed += 1;
      const ownRels = `${dirOf(part)}_rels/${baseOf(part)}.rels`;
      if (ownRels in parts) deleted.add(ownRels);
      changed = true;
    }
  for (const part of deleted) renames.delete(part);
  if (!changed) return unchanged;

  for (const [relsPath, list] of rels) {
    let relsXml = text(relsPath);
    for (const rel of list) {
      const rename = rel.part ? renames.get(rel.part) : undefined;
      if (!rename) continue;
      const old = baseOf(rel.part!);
      const target = rel.target.endsWith(old)
        ? rel.target.slice(0, -old.length) + baseOf(rename.path)
        : `/${rename.path}`;
      relsXml = relsXml.replace(
        rel.element,
        rel.element.replace(
          TARGET,
          (_, name: string, quote: string) => `${name}${quote}${target}${quote}`
        )
      );
    }
    if (relsXml !== text(relsPath)) write(relsPath, relsXml);
  }
  if ('[Content_Types].xml' in parts) {
    let types = text('[Content_Types].xml');
    for (const part of deleted)
      types = types.replace(
        new RegExp(
          `<Override\\b[^>]*PartName\\s*=\\s*["']/${escapeRegExp(part)}["'][^>]*>`,
          'i'
        ),
        ''
      );
    for (const [path, rename] of renames) {
      types = types.replace(
        new RegExp(
          `<Override\\b[^>]*PartName\\s*=\\s*["']/${escapeRegExp(path)}["'][^>]*>`,
          'i'
        ),
        `<Override PartName="/${rename.path}" ContentType="${rename.type}"/>`
      );
      const ext = rename.path.slice(rename.path.lastIndexOf('.') + 1);
      if (
        !new RegExp(
          `<Default\\b[^>]*Extension\\s*=\\s*["']${ext}["']`,
          'i'
        ).test(types)
      )
        types = types.replace(
          TYPES,
          (open) =>
            `${open}<Default Extension="${ext}" ContentType="${rename.type}"/>`
        );
    }
    write('[Content_Types].xml', types);
  }

  const zippable: Zippable = {};
  for (const [path, bytes] of Object.entries(parts)) {
    if (deleted.has(path)) continue;
    const name = renames.get(path)?.path ?? path;
    zippable[name] = [
      bytes,
      { level: stored.has(path) || renames.has(path) ? 0 : 6 },
    ];
  }
  return {
    file: new File([zipSync(zippable)], file.name, { type: file.type }),
    removed,
  };
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
