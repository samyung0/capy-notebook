/**
 * Proves a shared page looks the same with only the CSS the Worker inlines
 * as with the full stylesheets: in light and dark, at a phone and a desktop
 * width, every element's and pseudo-element's computed style matches, and so
 * do the screenshots. Page scripts are blocked, so what is compared is the
 * server's HTML at first paint (the theme script in the head still runs);
 * after load the page applies the full stylesheets anyway.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { pageClasses, usedCss } from '../../../workers/site/usedCss';

const INLINED =
  /<style>([\s\S]*?)<\/style><link rel="preload" as="style"[^>]*href="([^"]+)"[^>]*data-full-css>/g;

/** The served page as the Worker sends it (the subset) and with the full
 * stylesheets inlined instead. A page from before the Worker cut its CSS is
 * cut here with the same code. */
async function variants(html: string, origin: string) {
  if (!html.match(INLINED)) {
    const classes = pageClasses(html);
    return {
      full: html,
      subset: html.replace(
        /<style>([\s\S]*?)<\/style>/g,
        (_, css: string) => `<style>${usedCss(css)(classes)}</style>`
      ),
    };
  }
  const sheets = new Map<string, string>();
  for (const [, , href] of html.matchAll(INLINED))
    if (!sheets.has(href))
      sheets.set(href, await (await fetch(new URL(href, origin))).text());
  return {
    full: html.replace(
      INLINED,
      (_, _css, href: string) => `<style>${sheets.get(href)}</style>`
    ),
    subset: html.replace(INLINED, (_, css: string) => `<style>${css}</style>`),
  };
}

const VIEWPORTS = [
  { height: 823, width: 412 },
  { height: 900, width: 1366 },
];

/** Opens `html` at `url` with page scripts blocked, after fonts load. */
async function open(
  browser: Browser,
  url: string,
  html: string,
  colorScheme: 'light' | 'dark',
  viewport: (typeof VIEWPORTS)[number]
) {
  const page = await browser.newPage({ colorScheme, viewport });
  await page.route('**/*', (route) => {
    const request = route.request();
    if (request.url() === url) return route.fulfill({ body: html, contentType: 'text/html' });
    if (['script', 'stylesheet'].includes(request.resourceType()))
      return route.abort();
    return route.continue();
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  // Lazy images would load while the full-page screenshot scrolls, at a
  // different moment in each page; load them all first.
  await page.evaluate(SETTLE);
  return page;
}

// A string, so tsx's helpers never reach the page.
const SETTLE = `(async () => {
  const images = [...document.images];
  for (const image of images) image.loading = 'eager';
  await Promise.all(images.map((image) => image.decode().catch(() => {})));
  await document.fonts.ready;
})()`;

/** A hash of every element's and ::before/::after's computed style; the
 * styles themselves stay in the page for `style`. */
// A string, so tsx's helpers never reach the page.
const STYLE_HASHES = `(() => {
  // Sorted: custom properties list in the order the stylesheet declared them.
  const read = (style) => {
    const parts = [];
    for (let i = 0; i < style.length; i++)
      parts.push(style[i] + ':' + style.getPropertyValue(style[i]));
    return parts.sort().join(';');
  };
  const entries = [...document.querySelectorAll('*')].flatMap((element, index) => {
    const name = index + ':' + element.tagName.toLowerCase() + '.' + (element.getAttribute('class') ?? '');
    return [
      [name, read(getComputedStyle(element))],
      [name + '::before', read(getComputedStyle(element, '::before'))],
      [name + '::after', read(getComputedStyle(element, '::after'))],
    ];
  });
  window.styles = entries;
  // FNV-1a, enough to spot a difference.
  return entries.map(([name, text]) => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++)
      hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
    return name + ' ' + (hash >>> 0);
  });
})()`;

const styleHashes = (page: Page) => page.evaluate<string[]>(STYLE_HASHES);

const style = (page: Page, index: number) =>
  page.evaluate(
    (i) => (window as unknown as { styles: string[][] }).styles[i],
    index
  );

/** The first property whose value differs. */
async function difference(full: Page, subset: Page, index: number) {
  const parse = ([, text]: string[]) =>
    Object.fromEntries(text.split(';').map((p) => p.split(/:(.*)/s)));
  const [name] = await style(full, index);
  const expected = parse(await style(full, index));
  const actual = parse(await style(subset, index));
  const property = Object.keys({ ...expected, ...actual }).find(
    (key) => expected[key] !== actual[key]
  );
  return `${name.slice(0, 120)}: ${property} is ${property && actual[property]} instead of ${property && expected[property]}`;
}

/** Differences between the subset and the full stylesheets, if any. */
export async function compareStyles(
  browser: Browser,
  url: string,
  name: string,
  out: string
): Promise<{
  checked: number;
  differences: string[];
  fullBytes: number;
  noise: string[];
  subsetBytes: number;
}> {
  const served = await (await fetch(url)).text();
  const { full, subset } = await variants(served, new URL(url).origin);
  const differences: string[] = [];
  const noise: string[] = [];
  let checked = 0;
  for (const colorScheme of ['light', 'dark'] as const)
    for (const viewport of VIEWPORTS) {
      const label = `${colorScheme} ${viewport.width}px`;
      const a = await open(browser, url, full, colorScheme, viewport);
      const b = await open(browser, url, subset, colorScheme, viewport);
      try {
        const [expected, actual] = await Promise.all([
          styleHashes(a),
          styleHashes(b),
        ]);
        checked += expected.length;
        if (expected.length !== actual.length)
          differences.push(
            `${label}: ${expected.length} vs ${actual.length} elements`
          );
        for (let i = 0; i < expected.length && differences.length < 20; i++)
          if (expected[i] !== actual[i])
            differences.push(`${label} ${await difference(a, b, i)}`);
        const shot = (page: Page) =>
          page.screenshot({ animations: 'disabled', fullPage: true });
        const [fullShot, subsetShot] = await Promise.all([shot(a), shot(b)]);
        // The rasteriser now and then draws a few pixels differently on
        // identical pages, so a mismatch gets two more fresh loads of each.
        // The inlined page passes if it ever matches a full one; otherwise
        // the difference is noise when the full page varies too.
        const fulls = [fullShot];
        const subsets = [subsetShot];
        const matches = () =>
          subsets.some((s) => fulls.some((f) => f.equals(s)));
        for (let retry = 0; retry < 2 && !matches(); retry++)
          for (const [html, shots] of [
            [full, fulls],
            [subset, subsets],
          ] as const) {
            const fresh = await open(browser, url, html, colorScheme, viewport);
            shots.push(await shot(fresh).finally(() => fresh.close()));
          }
        if (!matches()) {
          const control = fulls.every((f) => f.equals(fullShot))
            ? fullShot
            : undefined;
          const changed = await changedPixels(browser, fullShot, subsetShot);
          const where = await a.evaluate(
            ([x, y]) =>
              document
                .elementsFromPoint(x, y)
                .slice(0, 3)
                .map((e) => `${e.tagName.toLowerCase()}.${e.getAttribute('class') ?? ''}`.slice(0, 60))
                .join(' < '),
            [changed.x, changed.y]
          );
          const file = `${name}-${colorScheme}-${viewport.width}`;
          await mkdir(out, { recursive: true });
          await writeFile(path.join(out, `${file}-full.png`), fullShot);
          await writeFile(path.join(out, `${file}-inlined.png`), subsetShot);
          const detail = `${changed.pixels} px around (${changed.x}, ${changed.y}) over ${where} (${file}-*.png)`;
          if (control)
            differences.push(`${label}: the screenshots differ, ${detail}`);
          else noise.push(`${label}: ${detail}`);
        }
      } finally {
        await a.close();
        await b.close();
      }
    }
  const bytes = (html: string) =>
    [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].reduce(
      (sum, [, css]) => sum + css.length,
      0
    );
  return {
    checked,
    differences,
    fullBytes: bytes(full),
    noise,
    subsetBytes: bytes(subset),
  };
}

// A string, so tsx's helpers never reach the page.
const CHANGED_PIXELS = `(async ([first, second]) => {
  const load = (png) => new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.src = 'data:image/png;base64,' + png;
  });
  const pixels = (image) => {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, image.width, image.height).data;
  };
  const [a, b] = [await load(first), await load(second)];
  if (a.width !== b.width || a.height !== b.height)
    return { pixels: -1, x: 0, y: 0 };
  const [pa, pb] = [pixels(a), pixels(b)];
  let count = 0, x = 0, y = 0;
  for (let i = 0; i < pa.length; i += 4)
    if (pa[i] !== pb[i] || pa[i + 1] !== pb[i + 1] || pa[i + 2] !== pb[i + 2]) {
      if (!count) { x = (i / 4) % a.width; y = Math.floor(i / 4 / a.width); }
      count++;
    }
  return { pixels: count, x, y };
})`;

/** How many pixels differ, and the first that does. */
async function changedPixels(browser: Browser, first: Buffer, second: Buffer) {
  const page = await browser.newPage();
  try {
    return await page.evaluate<{ pixels: number; x: number; y: number }>(
      `${CHANGED_PIXELS}(${JSON.stringify([first.toString('base64'), second.toString('base64')])})`
    );
  } finally {
    await page.close();
  }
}
