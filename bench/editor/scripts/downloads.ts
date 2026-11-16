// A built file's name without Vite's hash: `docx_view_wasm_bg`.
const HASHED = /-[\w-]{8}$/;

/**
 * A fetch's kind for `bench:office`'s report-only downloads, by its file;
 * for an engine, its module too. A CJK face's slice index (`slices.json`)
 * counts with the fonts it locates.
 */
export function downloadKind(
  initiator: string,
  url: URL,
  runtimeOrigin: string
): { kind: string; module?: string } {
  const file = url.pathname.split('/').at(-1) ?? '';
  const dot = file.lastIndexOf('.');
  const extension = dot < 0 ? '' : file.slice(dot + 1);
  const module = (dot < 0 ? file : file.slice(0, dot)).replace(HASHED, '');
  if (
    initiator === 'navigation' ||
    ['css', 'html', 'js', 'mjs'].includes(extension)
  )
    return {
      kind: url.origin === runtimeOrigin ? 'officeRuntimeJs' : 'appJsCss',
    };
  if (extension === 'wasm')
    return module.startsWith('fontpack')
      ? { kind: 'fontDecoder' }
      : { kind: 'engineWasm', module };
  if (
    ['otf', 'ttf', 'woff', 'woff2', 'zst'].includes(extension) ||
    (extension === 'json' && module === 'slices')
  )
    return { kind: 'fonts' };
  if (['docx', 'pptx', 'xlsx'].includes(extension))
    return { kind: 'sourceFile' };
  return { kind: 'other' };
}
