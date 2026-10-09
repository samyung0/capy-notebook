/* Loads yjs, slate and @slate-yjs/core as the app gets them (one yjs
 * instance through slate-yjs's own resolution), plus slate-yjs with the
 * "shared text attribute" patch of Mermaid shape A applied in memory.
 * Prototype for capy-harness/2026-10-06-rust-round/live-items/DESIGN.md. */
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { dirname } from 'node:path';

const anchor = createRequire(import.meta.url).resolve('@slate-yjs/core');
const req = createRequire(anchor);

/** The part of slate the probes use (slate is not a direct dependency). */
export interface SlateEditor {
  apply(op: unknown): void;
  children: unknown[];
  isVoid(element: unknown): boolean;
  onChange(): void;
}
interface SlateApi {
  createEditor(): SlateEditor;
  Transforms: {
    moveNodes(editor: SlateEditor, options: { at: number[]; to: number[] }): void;
    setNodes(editor: SlateEditor, props: object, options: { at: number[] }): void;
  };
}

export const Y = req('yjs') as typeof import('yjs');
export const slate = req('slate') as SlateApi;
export const slateYjs = req('@slate-yjs/core') as typeof import('@slate-yjs/core');

/** Shape A's patch to @slate-yjs/core 1.0.2 (dist/index.cjs): a `mermaid`
 * element's `source` is a nested Y.Text attribute. Slate keeps a plain
 * string; remote edits of the nested text become `set_node`; a local
 * `set_node` of the source edits the Y.Text minimally; clones copy it. Each
 * pair is [find, replace]; `count` lines are what a pnpm patch would carry. */
export const SHARED_TEXT_PATCH: [string, string][] = [
  [
    '// src/utils/convert.ts\n',
    `// src/utils/convert.ts
function isSharedTextKey(type, key) { return type === "mermaid" && key === "source"; }
function toSlateValue(value) { return value instanceof Y.AbstractType ? value.toString() : value; }
function slateAttributes(yText) {
  const out = {};
  for (const [key, value] of Object.entries(yText.getAttributes())) out[key] = toSlateValue(value);
  return out;
}
function newSharedText(text) { const t = new Y.Text(); t.insert(0, text); return t; }
function editSharedText(yText, next) {
  const current = yText.toString();
  if (current === next) return;
  let start = 0;
  while (start < current.length && start < next.length && current[start] === next[start]) start++;
  let end = 0;
  while (end < current.length - start && end < next.length - start && current[current.length - 1 - end] === next[next.length - 1 - end]) end++;
  if (current.length - start - end > 0) yText.delete(start, current.length - start - end);
  if (next.length - start - end > 0) yText.insert(start, next.slice(start, next.length - end));
}
`,
  ],
  [
    'return __spreadProps(__spreadValues({}, yText.getAttributes()), { children });',
    'return __spreadProps(__spreadValues({}, slateAttributes(yText)), { children });',
  ],
  [
    `  const yElement = new Y.XmlText();
  Object.entries(attributes).forEach(([key, value]) => {
    yElement.setAttribute(key, value);
  });`,
    `  const yElement = new Y.XmlText();
  Object.entries(attributes).forEach(([key, value]) => {
    yElement.setAttribute(key, isSharedTextKey(attributes.type, key) && typeof value === "string" ? newSharedText(value) : value);
  });`,
  ],
  [
    `  const clone = new Y5.XmlText();
  const attributes = yText.getAttributes();
  Object.entries(attributes).forEach(([key, value]) => {
    clone.setAttribute(key, value);
  });`,
    `  const clone = new Y5.XmlText();
  const attributes = yText.getAttributes();
  Object.entries(attributes).forEach(([key, value]) => {
    clone.setAttribute(key, value instanceof Y5.AbstractType ? newSharedText(value.toString()) : value);
  });`,
  ],
  [
    `  if (!(target instanceof Y3.XmlText)) {
    throw new Error("Unexpected target node type");
  }`,
    `  if (!(target instanceof Y3.XmlText)) {
    const owner = target._item && target._item.parent;
    const key = target._item && target._item.parentSub;
    if (!(owner instanceof Y3.XmlText) || !key) throw new Error("Unexpected target node type");
    const path = getSlatePath(sharedRoot, editor, owner);
    const element = import_slate5.Node.get(editor, path);
    return [{ type: "set_node", path, properties: { [key]: element[key] }, newProperties: { [key]: target.toString() } }];
  }`,
  ],
  [
    'info.action === "delete" ? null : target.getAttribute(key)',
    'info.action === "delete" ? null : toSlateValue(target.getAttribute(key))',
  ],
  [
    `      if (value === null) {
        return yTarget.removeAttribute(key);
      }
      yTarget.setAttribute(key, value);`,
    `      if (value === null) {
        return yTarget.removeAttribute(key);
      }
      const held = yTarget.getAttribute(key);
      if (held instanceof Y.AbstractType && typeof value === "string") return editSharedText(held, value);
      yTarget.setAttribute(key, value);`,
  ],
];

/** Lines the patch adds or changes (what `git diff --stat` would count). */
export function patchLines(): number {
  return SHARED_TEXT_PATCH.reduce(
    (total, [find, replace]) =>
      total + replace.split('\n').length - (replace.startsWith(find) ? find.split('\n').length - 1 : 0),
    0
  );
}

let patched: typeof import('@slate-yjs/core') | null = null;

export function slateYjsSharedText(): typeof import('@slate-yjs/core') {
  if (patched) return patched;
  let code = readFileSync(anchor, 'utf8');
  for (const [find, replace] of SHARED_TEXT_PATCH) {
    if (!code.includes(find)) throw new Error(`patch anchor missing: ${find.slice(0, 60)}`);
    code = code.replace(find, replace);
  }
  type Internal = typeof Module & {
    _nodeModulePaths(dir: string): string[];
  };
  const module = new Module(`${anchor}#shared-text`) as Module & {
    _compile(code: string, filename: string): void;
  };
  module.filename = anchor;
  module.paths = (Module as Internal)._nodeModulePaths(dirname(anchor));
  module._compile(code, anchor);
  patched = module.exports as typeof import('@slate-yjs/core');
  return patched;
}
