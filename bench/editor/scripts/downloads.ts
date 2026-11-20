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

/** One fetch in some realm, from its resource or navigation timing. */
export interface Download {
  /** decodedBodySize: the body with its gzip or brotli undone. */
  decoded: number;
  /** encodedBodySize: the body as it arrived, before decoding, also when
   * none was sent. */
  encoded: number;
  initiator: string;
  name: string;
  /** Epoch ms the fetch started. */
  start: number;
  /** transferSize: on the wire, headers included; 0 from the HTTP cache or
   * a service worker. */
  transfer: number;
}

const kib = (bytes: number) => Math.round((bytes / 1024) * 10) / 10;

/**
 * What the fetches that started in [from, to) downloaded, by kind, with the
 * engine WASM per module, as the browser reports each fetch:
 * `transferredKiB` crossed the wire, headers included, from this bench's
 * server (vite preview, which gzips text, JavaScript, CSS and JSON responses
 * over 1 KB and sends WASM, fonts and other binaries as built);
 * `encodedKiB` is the bodies as they arrived and `decodedKiB` the same
 * decoded. `withStoredBrotliKiB` is `transferredKiB` with each body the
 * Office Worker stores as a brotli-11 `.br` (WASM and TTF; `storedBrotli`
 * gives its size, or null) at that size, as production serves it.
 * `bodiesSent` counts the fetches whose body crossed the wire: one answered
 * by the HTTP cache or by MSW's service worker (the app's origin, bench only)
 * transfers nothing, a revalidation (vite preview's ETags) only its headers.
 */
export function downloadsBetween(
  entries: Download[],
  from: number,
  to: number,
  runtimeOrigin: string,
  storedBrotli: (url: URL) => number | null
) {
  const tally = () => ({
    bodiesSent: 0,
    decodedKiB: 0,
    encodedKiB: 0,
    requests: 0,
    transferredKiB: 0,
    withStoredBrotliKiB: 0,
  });
  type Tally = ReturnType<typeof tally>;
  const kinds: Record<string, Tally> = {};
  const modules: Record<string, Tally> = {};
  const total = tally();
  const add = (
    into: Tally,
    entry: Download,
    bodySent: boolean,
    sent: number
  ) => {
    into.requests += 1;
    if (bodySent) into.bodiesSent += 1;
    into.decodedKiB += entry.decoded;
    into.encodedKiB += entry.encoded;
    into.transferredKiB += entry.transfer;
    into.withStoredBrotliKiB += sent;
  };
  for (const entry of entries) {
    // The host's entry for the runtime frame; the frame reports its own.
    if (entry.start < from || entry.start >= to || entry.initiator === 'iframe')
      continue;
    const url = new URL(entry.name);
    const { kind, module } = downloadKind(entry.initiator, url, runtimeOrigin);
    // More than the headers came (a revalidation may report no body size).
    const bodySent = entry.encoded > 0 && entry.transfer > entry.encoded;
    const stored = bodySent ? storedBrotli(url) : null;
    const sent =
      stored === null
        ? entry.transfer
        : entry.transfer - entry.encoded + stored;
    add((kinds[kind] ??= tally()), entry, bodySent, sent);
    add(total, entry, bodySent, sent);
    if (module) add((modules[module] ??= tally()), entry, bodySent, sent);
  }
  const inKiB = (into: Tally) => ({
    ...into,
    decodedKiB: kib(into.decodedKiB),
    encodedKiB: kib(into.encodedKiB),
    transferredKiB: kib(into.transferredKiB),
    withStoredBrotliKiB: kib(into.withStoredBrotliKiB),
  });
  return {
    engineWasmModules: Object.fromEntries(
      Object.entries(modules).map(([name, into]) => [name, inKiB(into)])
    ),
    kinds: Object.fromEntries(
      Object.entries(kinds).map(([name, into]) => [name, inKiB(into)])
    ),
    total: inKiB(total),
  };
}
