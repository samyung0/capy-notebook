// What a case can do to a runtime frame: real mouse and keyboard on the
// frame (Playwright, page coordinates), and the menu messages Capy's header
// sends. Text is located through the editors' own DOM: the DOCX accessible
// mirror (invisible, laid out exactly over the painted page), the PPTX/XLSX
// equivalents.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CDPSession, Frame } from '@playwright/test';
import { type Fixture, type Format, ROOT, type Session } from './session';

export interface Recording {
  updates: { order: number; peer: string; seq: number; t: number; source: string; step: number; bytes: string; raw: string | null }[];
  raws: { peer: string; rawSeq: number; t: number; bytes: number; wire: number | null }[];
  steps: { i: number; peer: string; t: number; action: string; detail: string }[];
  messages: { peer: string; t: number; type: string; detail?: unknown }[];
  clientIds: Record<string, number | null>;
  t: number;
}

declare global {
  interface Window {
    // host.ts
    recorder: {
      start(options: unknown): Promise<{ t: number }>;
      step(peer: string, action: string, detail?: string): void;
      menu(peer: string, id: string, value?: string): void;
      menuFile(peer: string, id: string, name: string, mime: string, data: string): void;
      focusLeft(peer: string): void;
      hold(): void;
      release(): void;
      flush(peer: string): Promise<string>;
      exportFile(peer: string): Promise<string>;
      menus(peer: string): unknown;
      hostState(peer: string): string;
      dump(): unknown;
    };
  }
}

export interface Locate {
  /** 0-based occurrence of the needle in reading order. */
  occurrence?: number;
  /** Caret before the needle (start), after it (end), or before its n-th character. */
  at?: 'start' | 'end' | number;
  /** Which part of the page to search. */
  scope?: 'body' | 'header' | 'footer' | 'notes' | 'any';
}

export interface Peer {
  name: string;
  frame(): Frame;
  click(needle: string, where?: Locate & { count?: number; button?: 'left' | 'right'; shift?: boolean }): Promise<void>;
  type(text: string, delay?: number): Promise<void>;
  press(key: string, times?: number): Promise<void>;
  menu(id: string, value?: string): Promise<void>;
  pickFile(id: string, file: string, mime: string): Promise<void>;
  paste(text: string): Promise<void>;
  ime(text: string): Promise<void>;
  clickRole(role: Parameters<Frame['getByRole']>[0], name: string | RegExp): Promise<void>;
  clickElement(selector: string, options?: { index?: number; count?: number; button?: 'left' | 'right'; dx?: number; dy?: number }): Promise<void>;
  /** DOCX: click the picture laid out just above the caption text `needle`. */
  clickImage(needle: string): Promise<void>;
  /** Focus the editor's text input again without moving its caret. */
  focus(): Promise<void>;
  /** DOCX find-and-replace dialog: Replace All. */
  replaceAll(find: string, replace: string): Promise<void>;
  /** DOCX review: accept/reject the index-th tracked change card, or all. */
  review(action: 'accept' | 'reject' | 'acceptAll' | 'rejectAll', index?: number): Promise<void>;
  /** PPTX: show slide n (1-based) from the slide strip. */
  slide(n: number): Promise<void>;
  /** PPTX: caret in the shape holding `needle` on slide n (or the shape selected). */
  shape(n: number, needle: string, mode: 'start' | 'end' | 'paragraph-end' | 'select'): Promise<void>;
  /** PPTX: select the index-th shape of slide n by clicking its centre. */
  shapeByIndex(n: number, index: number): Promise<void>;
  /** PPTX: drag the shape holding `needle` by a fraction of the slide size. */
  dragShape(n: number, needle: string, dx: number, dy: number): Promise<void>;
  /** PPTX: click the current slide at a fraction of its size. */
  slideClick(fx: number, fy: number): Promise<void>;
  /** PPTX: caret at the end of the first table cell text found. */
  tableCell(): Promise<void>;
  /** PPTX: append to the current slide's speaker notes. */
  notes(text: string): Promise<void>;
  /** XLSX: select a cell through the name box. */
  goto(ref: string): Promise<void>;
  clickTestId(id: string): Promise<void>;
  clickAt(x: number, y: number, options?: { count?: number; button?: 'left' | 'right' }): Promise<void>;
  drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void>;
}

export interface Driver {
  format: Format;
  peer(name?: string): Peer;
  step(peer: string, action: string, detail?: string): Promise<void>;
  savePoint(): Promise<void>;
  hold(): Promise<void>;
  release(): Promise<void>;
  wait(ms: number): Promise<void>;
  settle(quietMs?: number): Promise<void>;
  capture(needles: string[]): Promise<{ peer: string; needle: string; text: string | null; source: string }[]>;
  exportFile(peer: string): Promise<void>;
}

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../../fixtures/effects-recorder');

/** In the frame: the page-coordinate point for a caret at the needle. */
interface SlideShapes {
  width: number;
  height: number;
  shapes: { kind: string; name: string; text: string[]; box: [number, number, number, number] | null }[];
}

type Located = { x: number; y: number; text: string } | { scrolled: true; rect?: number[] } | null;

function locateInFrame([needle, occurrence, at, scope, scroll]: [string, number, 'start' | 'end' | number, string, boolean]): Located {
  const scopes: Record<string, string> = {
    any: '',
    body: '.layout-page-content',
    footer: '.layout-page-footer',
    header: '.layout-page-header',
    notes: '.layout-page-notes',
  };
  const positioned = [...document.querySelectorAll('.layout-page-mirror:not(.layout-page-mirror-text)')];
  let seen = 0;
  for (const page of positioned) {
    const roots = scopes[scope] ? [...page.querySelectorAll(scopes[scope]!)] : [page];
    for (const root of roots) {
      for (const block of root.querySelectorAll('[role=paragraph]')) {
        if (block.querySelector('[role=paragraph]')) continue;
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        const nodes: { node: Text; start: number }[] = [];
        let text = '';
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          nodes.push({ node: n as Text, start: text.length });
          text += (n as Text).data;
        }
        let from = text.indexOf(needle);
        while (from >= 0) {
          if (seen++ === occurrence) {
            const index = at === 'start' ? from : at === 'end' ? from + needle.length : from + at;
            const before = index >= text.length || (at === 'end' && index > 0);
            const char = before ? index - 1 : index;
            const hit = nodes.filter((entry) => entry.start <= char).pop()!;
            const range = document.createRange();
            range.setStart(hit.node, char - hit.start);
            range.setEnd(hit.node, char - hit.start + 1);
            const rect = range.getBoundingClientRect();
            // Off the frame's viewport: bring the run to the middle, then retry.
            if (scroll && (rect.top < 60 || rect.bottom > window.innerHeight - 20)) {
              hit.node.parentElement?.scrollIntoView({ block: 'center' });
              return { scrolled: true, rect: [rect.left, rect.top, rect.width, rect.height] };
            }
            return { x: before ? rect.right - 0.5 : rect.left + 0.5, y: rect.top + rect.height / 2, text };
          }
          from = text.indexOf(needle, from + 1);
        }
      }
    }
  }
  // On a page away from the viewport: bring it in and let the caller retry.
  for (const page of document.querySelectorAll('.layout-page-mirror-text')) {
    if ((page.textContent ?? '').includes(needle)) {
      page.scrollIntoView({ block: 'center' });
      return { scrolled: true };
    }
  }
  return null;
}

class FramePeer implements Peer {
  constructor(
    readonly name: string,
    private readonly format: Format,
    private readonly fixture: Fixture,
    private readonly session: Session,
    private readonly cdp: () => Promise<CDPSession>,
    private readonly focusState: { peer: string | null }
  ) {}

  /** Keys go to the focused frame: give this peer's editor the focus first. */
  private async ensureFocus() {
    if (this.focusState.peer === this.name) return;
    await this.focus();
  }

  private slides = new Map<number, SlideShapes>();

  private shapesOf(n: number): SlideShapes {
    let shapes = this.slides.get(n);
    if (!shapes) {
      const script = path.join(import.meta.dirname, 'pptx_shapes.py');
      const result = spawnSync('python', ['-I', '-X', 'utf8', script, path.join(ROOT, this.fixture.path), String(n)], {
        encoding: 'utf8',
      });
      if (result.status !== 0) throw new Error('pptx_shapes: ' + result.stderr);
      shapes = JSON.parse(result.stdout) as SlideShapes;
      this.slides.set(n, shapes);
    }
    return shapes;
  }

  /** Page coordinates of a slide point given in EMU. */
  private async slidePoint(shapes: SlideShapes, x: number, y: number) {
    const canvas = this.frame().getByTestId('pptx-slide-canvas');
    await (await this.frame().frameElement()).scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('no slide canvas');
    return { x: box.x + (x / shapes.width) * box.width, y: box.y + (y / shapes.height) * box.height };
  }

  async slide(n: number) {
    this.focusState.peer = this.name;
    await this.frame().locator('aside button').nth(n - 1).click();
    await this.session.page.waitForTimeout(400);
  }

  async slideClick(fx: number, fy: number) {
    this.focusState.peer = this.name;
    const canvas = await this.frame().getByTestId('pptx-slide-canvas').boundingBox();
    if (!canvas) throw new Error('no slide canvas');
    await this.session.page.mouse.click(canvas.x + canvas.width * fx, canvas.y + canvas.height * fy);
    await this.session.page.waitForTimeout(300);
  }

  private findShape(n: number, needle: string) {
    const shapes = this.shapesOf(n);
    const shape = shapes.shapes.find((s) => s.text.join('\n').includes(needle));
    if (!shape?.box) throw new Error('no shape with "' + needle + '" on slide ' + n);
    return { shape, shapes };
  }

  async shape(n: number, needle: string, mode: 'start' | 'end' | 'paragraph-end' | 'select') {
    this.focusState.peer = this.name;
    await this.slide(n);
    const { shape, shapes } = this.findShape(n, needle);
    const [x, y, cx, cy] = shape.box!;
    const page = this.session.page;
    if (mode === 'select') {
      // The frame edge selects the shape without entering its text.
      const point = await this.slidePoint(shapes, x + cx / 2, y + 1);
      await page.mouse.click(point.x, point.y);
      await page.waitForTimeout(300);
      return;
    }
    // Into the text, then to the needle by keyboard from the text start.
    const inside = await this.slidePoint(shapes, x + cx * 0.3, y + cy * 0.15);
    await page.mouse.click(inside.x, inside.y);
    await page.waitForTimeout(250);
    await page.mouse.click(inside.x, inside.y, { clickCount: 2 });
    await page.waitForTimeout(250);
    await page.keyboard.press('ControlOrMeta+Home');
    const text = shape.text.join('\n');
    const from = text.indexOf(needle);
    let offset = from;
    if (mode === 'end') offset = from + needle.length;
    if (mode === 'paragraph-end') {
      const end = text.indexOf('\n', from + needle.length);
      offset = end < 0 ? text.length : end;
    }
    for (let i = 0; i < offset; i++) await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
  }

  async shapeByIndex(n: number, index: number) {
    this.focusState.peer = this.name;
    await this.slide(n);
    const shapes = this.shapesOf(n);
    const box = shapes.shapes[index]?.box;
    if (!box) throw new Error('no shape ' + index + ' on slide ' + n);
    const point = await this.slidePoint(shapes, box[0] + box[2] / 2, box[1] + box[3] / 2);
    await this.session.page.mouse.click(point.x, point.y);
    await this.session.page.waitForTimeout(300);
  }

  async dragShape(n: number, needle: string, dx: number, dy: number) {
    await this.shape(n, needle, 'select');
    const { shape, shapes } = this.findShape(n, needle);
    const [x, y, cx] = shape.box!;
    const from = await this.slidePoint(shapes, x + cx / 2, y + 1);
    const to = await this.slidePoint(shapes, x + cx / 2 + dx * shapes.width, y + 1 + dy * shapes.height);
    const mouse = this.session.page.mouse;
    await mouse.move(from.x, from.y);
    await mouse.down();
    await mouse.move(to.x, to.y, { steps: 12 });
    await mouse.up();
    await this.session.page.waitForTimeout(300);
  }

  async tableCell() {
    this.focusState.peer = this.name;
    for (let n = 1; n <= 30; n++) {
      let shapes: SlideShapes;
      try {
        shapes = this.shapesOf(n);
      } catch {
        break;
      }
      const table = shapes.shapes.find((s) => s.kind === 'table' && s.box);
      if (!table) continue;
      await this.slide(n);
      const [x, y, cx, cy] = table.box!;
      const point = await this.slidePoint(shapes, x + cx * 0.15, y + cy * 0.1);
      await this.session.page.mouse.click(point.x, point.y);
      await this.session.page.waitForTimeout(250);
      await this.session.page.mouse.click(point.x, point.y, { clickCount: 2 });
      await this.session.page.waitForTimeout(250);
      await this.session.page.keyboard.press('End');
      return;
    }
    throw new Error('no table in the deck');
  }

  async notes(text: string) {
    this.focusState.peer = this.name;
    const notes = this.frame().getByTestId('pptx-notes-textarea');
    if (!(await notes.isVisible().catch(() => false))) await this.menu('view.speakerNotes');
    await notes.click();
    await this.session.page.keyboard.press('ControlOrMeta+End');
    await this.type(text);
  }

  async goto(ref: string) {
    this.focusState.peer = this.name;
    const box = this.frame().getByTestId('xlsx-name-box');
    await box.click();
    await box.fill(ref);
    await box.press('Enter');
    await this.session.page.waitForTimeout(250);
  }

  frame() {
    return this.session.frame(this.name);
  }

  private async origin() {
    const element = await this.frame().frameElement();
    await element.scrollIntoViewIfNeeded();
    const box = await element.boundingBox();
    if (!box) throw new Error(`frame ${this.name} has no box`);
    return box;
  }

  async point(needle: string, where: Locate = {}, scroll = true) {
    let last: Located = null;
    // Far pages are laid out progressively after the first paint: a needle
    // not found yet is retried for a while, as is one being scrolled to.
    for (let attempt = 0; attempt < 40; attempt++) {
      const found = await this.frame().evaluate(locateInFrame, [
        needle,
        where.occurrence ?? 0,
        where.at ?? 'start',
        where.scope ?? 'body',
        scroll,
      ] as [string, number, 'start' | 'end' | number, string, boolean]);
      if (found && 'x' in found) {
        const box = await this.origin();
        return { x: box.x + found.x, y: box.y + found.y };
      }
      if (!found && attempt >= 30) throw new Error(`text not found: ${needle}`);
      last = found;
      await this.session.page.waitForTimeout(400);
    }
    throw new Error(`text never laid out: ${needle} ${JSON.stringify(last)}`);
  }

  private lastClick: { needle: string; where: Locate } | null = null;

  /**
   * A click at the needle. `shift` extends from the previous click by a mouse
   * drag (the DOCX canvas has no Shift+click; dragging is how a mouse selects).
   */
  async click(needle: string, where: Locate & { count?: number; button?: 'left' | 'right'; shift?: boolean } = {}) {
    const page = this.session.page;
    if (where.shift && this.lastClick) {
      const to = await this.point(needle, where);
      const from = await this.point(this.lastClick.needle, this.lastClick.where, false);
      const viewport = (await (await this.frame().frameElement()).boundingBox())!;
      if (from.y < viewport.y || from.y > viewport.y + viewport.height) throw new Error('selection anchor is off screen');
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 10 });
      await page.mouse.up();
      await this.placed();
      return;
    }
    const { x, y } = await this.point(needle, where);
    await page.mouse.click(x, y, { button: where.button ?? 'left', clickCount: where.count ?? 1 });
    this.lastClick = { needle, where };
    await this.placed();
  }

  /** DOCX: typing waits until the click's caret placement is accepted. */
  async placed() {
    this.focusState.peer = this.name;
    await this.session.page.waitForTimeout(120);
    if (this.format !== 'docx') return;
    await this.frame()
      .waitForSelector('[data-testid=yrs-input][data-pointer-placement=ready]', { state: 'attached', timeout: 10_000 })
      .catch(() => {});
  }

  async clickAt(x: number, y: number, options: { count?: number; button?: 'left' | 'right' } = {}) {
    const box = await this.origin();
    await this.session.page.mouse.click(box.x + x, box.y + y, {
      button: options.button ?? 'left',
      clickCount: options.count ?? 1,
    });
    await this.placed();
  }

  async drag(from: { x: number; y: number }, to: { x: number; y: number }) {
    const box = await this.origin();
    const mouse = this.session.page.mouse;
    await mouse.move(box.x + from.x, box.y + from.y);
    await mouse.down();
    await mouse.move(box.x + to.x, box.y + to.y, { steps: 12 });
    await mouse.up();
    await this.session.page.waitForTimeout(200);
  }

  async type(text: string, delay = 25) {
    await this.ensureFocus();
    await this.session.page.keyboard.type(text, { delay });
  }

  async press(key: string, times = 1) {
    await this.ensureFocus();
    for (let i = 0; i < times; i++) await this.session.page.keyboard.press(key);
    await this.session.page.waitForTimeout(80);
  }

  async menu(id: string, value?: string) {
    await this.session.page.evaluate(([p, i, v]) => window.recorder.menu(p!, i!, v), [this.name, id, value]);
    await this.session.page.waitForTimeout(300);
  }

  async pickFile(id: string, file: string, mime: string) {
    const data = readFileSync(path.join(FIXTURE_DIR, file)).toString('base64');
    await this.session.page.evaluate(
      ([p, i, n, m, d]) => window.recorder.menuFile(p!, i!, n!, m!, d!),
      [this.name, id, file, mime, data]
    );
    await this.session.page.waitForTimeout(800);
  }

  async paste(text: string) {
    await this.frame().evaluate((t) => navigator.clipboard.writeText(t), text);
    await this.session.page.keyboard.press('ControlOrMeta+V');
    await this.session.page.waitForTimeout(300);
  }

  async ime(text: string) {
    const cdp = await this.cdp();
    for (let i = 1; i <= text.length; i++)
      await cdp.send('Input.imeSetComposition', { selectionEnd: i, selectionStart: i, text: text.slice(0, i) });
    await cdp.send('Input.insertText', { text });
    await this.session.page.waitForTimeout(200);
  }

  /** The centre of the index-th element matching `selector` (mirror elements included). */
  async clickElement(selector: string, options: { index?: number; count?: number; button?: 'left' | 'right'; dx?: number; dy?: number } = {}) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const rect = await this.frame().evaluate(
        ([s, i]) => {
          const element = document.querySelectorAll(s as string)[i as number];
          if (!element) return null;
          element.scrollIntoView({ block: 'nearest' });
          const r = element.getBoundingClientRect();
          return r.width > 0 && r.height > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
        },
        [selector, options.index ?? 0]
      );
      if (rect) {
        await this.clickAt(rect.x + (options.dx ?? 0), rect.y + (options.dy ?? 0), options);
        return;
      }
      await this.session.page.waitForTimeout(300);
    }
    throw new Error(`no element ${selector}`);
  }

  async clickImage(needle: string) {
    // Bring the caption on screen, then take the nearest picture above it.
    await this.point(needle, { at: 'start' });
    const box = await this.origin();
    const target = await this.frame().evaluate((n) => {
      let caption: DOMRect | null = null;
      for (const block of document.querySelectorAll('.layout-page-mirror:not(.layout-page-mirror-text) [role=paragraph]')) {
        if ((block.textContent ?? '').includes(n)) {
          const run = block.querySelector('.layout-run-text');
          if (run) caption = run.getBoundingClientRect();
          break;
        }
      }
      if (!caption) return null;
      let best: { x: number; y: number; d: number } | null = null;
      for (const image of document.querySelectorAll('.layout-page-mirror:not(.layout-page-mirror-text) .layout-run-image')) {
        const r = image.getBoundingClientRect();
        if (r.width < 40 || r.height < 40 || r.bottom > caption.top + 4) continue;
        const d = caption.top - r.bottom;
        if (!best || d < best.d) best = { d, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return best;
    }, needle);
    if (!target) throw new Error('no picture above ' + needle);
    await this.session.page.mouse.click(box.x + target.x, box.y + target.y);
    await this.session.page.waitForTimeout(400);
    this.focusState.peer = this.name;
  }

  async focus() {
    const selector = this.format === 'docx' ? '[data-testid=yrs-input]' : this.format === 'pptx' ? '[data-testid=pptx-text-input]' : '[data-testid=xlsx-scroll]';
    await this.frame().locator(selector).first().focus();
    this.focusState.peer = this.name;
    await this.session.page.waitForTimeout(100);
  }

  async replaceAll(find: string, replace: string) {
    await this.menu('find-replace');
    const frame = this.frame();
    await frame.getByLabel('Find text').fill(find);
    const replaceBox = frame.getByLabel('Replace text');
    if (!(await replaceBox.isVisible().catch(() => false))) await frame.getByText('+ Replace').click();
    await replaceBox.fill(replace);
    await frame.getByRole('button', { name: /Replace All/i }).click();
    await this.session.page.waitForTimeout(500);
    await this.session.page.keyboard.press('Escape');
  }

  async review(action: 'accept' | 'reject' | 'acceptAll' | 'rejectAll', index = 0) {
    const frame = this.frame();
    this.focusState.peer = this.name;
    if (action === 'acceptAll' || action === 'rejectAll') {
      await frame.getByRole('button', { name: action === 'acceptAll' ? /^Accept all$/ : /^Reject all$/ }).first().click();
    } else {
      // A card shows its Accept/Reject buttons once expanded by a click.
      const card = frame.locator('.docx-tracked-change-card').nth(index);
      await card.click();
      await card.getByTitle(action === 'accept' ? 'Accept' : 'Reject', { exact: true }).click();
    }
    await this.session.page.waitForTimeout(400);
  }

  async clickRole(role: Parameters<Frame['getByRole']>[0], name: string | RegExp) {
    this.focusState.peer = this.name;
    await this.frame().getByRole(role, { name }).first().click();
    await this.session.page.waitForTimeout(200);
  }

  async clickTestId(id: string) {
    this.focusState.peer = this.name;
    await this.frame().getByTestId(id).first().click();
    await this.session.page.waitForTimeout(200);
  }
}

export function driverFor(fixture: Fixture, session: Session, peers: string[], scripted: number[]): Driver {
  const format = fixture.format;
  let cdp: CDPSession | null = null;
  const getCdp = async () => (cdp ??= await session.context.newCDPSession(session.page));
  const focusState = { peer: null as string | null };
  const made = new Map(peers.map((name) => [name, new FramePeer(name, format, fixture, session, getCdp, focusState)]));
  const page = session.page;
  const updates = () => page.evaluate(() => (window.recorder.dump() as Recording).updates.length);
  return {
    format,
    peer(name = peers[0]!) {
      const peer = made.get(name);
      if (!peer) throw new Error(`no peer ${name}`);
      return peer;
    },
    async step(peer, action, detail = '') {
      await page.evaluate(([p, a, d]) => window.recorder.step(p!, a!, d), [peer, action, detail]);
    },
    async savePoint() {
      const t = (await page.evaluate(() => (window.recorder.dump() as Recording).t)) as number;
      scripted.push(t);
      await page.evaluate(() => window.recorder.step('*', 'save-point', 'scripted'));
    },
    async hold() {
      await page.evaluate(() => window.recorder.hold());
    },
    async release() {
      await page.evaluate(() => window.recorder.release());
      await page.waitForTimeout(300);
    },
    async wait(ms) {
      await page.waitForTimeout(ms);
    },
    async settle(quietMs = 1200) {
      let last = await updates();
      let quietSince = Date.now();
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        await page.waitForTimeout(200);
        const now = await updates();
        if (now !== last) {
          last = now;
          quietSince = Date.now();
        } else if (Date.now() - quietSince >= quietMs) return;
      }
    },
    async exportFile(peer) {
      await page.evaluate((p) => window.recorder.exportFile(p), peer);
    },
    async capture(needles) {
      const out: { peer: string; needle: string; text: string | null; source: string }[] = [];
      for (const [name, peer] of made) {
        for (const needle of needles) {
          const text = await peer.frame().evaluate((n) => {
            for (const block of document.querySelectorAll('[role=paragraph]')) {
              if (block.querySelector('[role=paragraph]')) continue;
              const t = block.textContent ?? '';
              if (t.includes(n)) return t;
            }
            return null;
          }, needle);
          out.push({ needle, peer: name, source: 'dom', text });
        }
      }
      return out;
    },
  };
}
