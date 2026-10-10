/**
 * Proves a shared page looks the same with only the CSS the Worker inlines
 * as with the full stylesheets: in light and dark, at a phone and a desktop
 * width, every element's and pseudo-element's computed style matches, and so
 * do the screenshots. Page scripts are blocked, so what is compared is the
 * server's HTML at first paint (the theme script in the head still runs);
 * after load the page applies the full stylesheets anyway.
 */
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
  await page.goto(url, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

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
  url: string
): Promise<{ checked: number; differences: string[]; subsetBytes: number; fullBytes: number }> {
  const served = await (await fetch(url)).text();
  const { full, subset } = await variants(served, new URL(url).origin);
  const differences: string[] = [];
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
        const [fullShot, subsetShot] = await Promise.all([
          a.screenshot({ animations: 'disabled', fullPage: true }),
          b.screenshot({ animations: 'disabled', fullPage: true }),
        ]);
        if (!fullShot.equals(subsetShot))
          differences.push(`${label}: the screenshots differ`);
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
  return { checked, differences, fullBytes: bytes(full), subsetBytes: bytes(subset) };
}
