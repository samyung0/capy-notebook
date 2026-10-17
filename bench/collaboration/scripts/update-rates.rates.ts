import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Frame, type Page, test } from '@playwright/test';
import * as Y from 'yjs';
import { m } from '../../../e2e/i18n';
import {
  PERF_LARGE_NOTE,
  PERF_SMALL_NOTE,
  PERF_WORKSPACE_ID,
} from '../../../src/mocks/perfSeed';

/**
 * What one connection sends the collaboration server while a person edits:
 * document updates (one SYNC message each) and awareness updates, per
 * scenario, with the peaks over 1 s windows. The mock rooms
 * (src/mocks/collaboration.ts) stand in for the server: every update a
 * participant's document emits that did not come from its room is one the
 * room provider (src/features/collaboration/roomProvider.ts) would send.
 *
 * Unthrottled, and keys are pressed on the clock, so typing runs at the
 * cadence asked for; one scenario presses keys as fast as the page takes
 * them, an upper bound of what one keystroke stream can emit.
 * Each scenario's summary is printed and appended to
 * bench/collaboration/.results/rates.jsonl.
 */

interface Sent {
  at: number;
  bytes: number;
  kind: 'awareness' | 'update';
  room: string;
}

declare global {
  interface Window {
    __rates: Sent[];
    /** The updates themselves, while a scenario keeps them. */
    __ratesKept?: Uint8Array[];
  }
}

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(scriptsDir, '..', '.results');

async function save(scenario: string, summary: object) {
  console.log(scenario, JSON.stringify(summary));
  await mkdir(resultsDir, { recursive: true });
  await appendFile(
    path.join(resultsDir, 'rates.jsonl'),
    `${JSON.stringify({ scenario, ...summary })}\n`
  );
}

/** The plan's starting allowance, evaluated per scenario (`headroom`). */
const PROPOSED = {
  burstBytes: 8 * 1024 * 1024,
  burstUpdates: 300,
  bytesPerSecond: 2 * 1024 * 1024,
  updatesPerSecond: 60,
};

const PROSE = 'the quick brown fox jumps over the lazy dog while we measure ';

/**
 * Counts what every mock room participant sends: document updates whose
 * origin is not its room, and its awareness updates not applied from the
 * room. The dev server shares the app's module instance, so `rooms` is the
 * app's own map; new participants are picked up every 10 ms.
 */
async function installCounter(page: Page) {
  await page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { rooms } = (await import(path)) as {
      rooms: Map<
        string,
        {
          name: string;
          participants: Set<{
            awareness?: {
              getLocalState(): unknown;
              on(
                name: 'update',
                listener: (change: unknown, origin: unknown) => void
              ): void;
            };
            document: {
              on(
                name: 'update',
                listener: (update: Uint8Array, origin: unknown) => void
              ): void;
            };
            origin: object;
          }>;
        }
      >;
    };
    const sent: Sent[] = [];
    window.__rates = sent;
    const hooked = new WeakSet<object>();
    const scan = () => {
      for (const room of rooms.values())
        for (const participant of room.participants) {
          if (hooked.has(participant)) continue;
          hooked.add(participant);
          participant.document.on('update', (update, origin) => {
            if (origin === participant.origin) return;
            window.__ratesKept?.push(update.slice());
            sent.push({
              at: performance.now(),
              bytes: update.byteLength,
              kind: 'update',
              room: room.name,
            });
          });
          const awareness = participant.awareness;
          awareness?.on('update', (_change, origin) => {
            if (origin !== 'mock-room')
              sent.push({
                at: performance.now(),
                // The y-protocols message: the state's JSON plus ids and clock.
                bytes: JSON.stringify(awareness.getLocalState()).length + 12,
                kind: 'awareness',
                room: room.name,
              });
          });
        }
    };
    scan();
    setInterval(scan, 10);
  });
}

async function reset(page: Page) {
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    window.__rates.length = 0;
  });
}

/** Waits for the scenario's updates to land, then records its summary. */
async function record(page: Page, scenario: string, extra: object = {}) {
  await page.waitForTimeout(1500);
  const sent = await page.evaluate(() => window.__rates.slice());
  const summary = {
    ...summarize(sent.filter((event) => event.kind === 'update')),
    awareness: summarize(sent.filter((event) => event.kind === 'awareness')),
    ...extra,
  };
  await save(scenario, summary);
}

/**
 * Counts and bytes: the most in any 1 s (sliding), the 99th percentile of
 * consecutive 1 s windows over the scenario, the most in any 100 ms, the
 * largest message, and the proposed allowance's least headroom.
 */
function summarize(events: Sent[]) {
  if (!events.length) return { updates: 0 };
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const sliding = (span: number) => {
    let from = 0;
    let bytes = 0;
    let most = { bytes: 0, count: 0 };
    for (const [index, event] of sorted.entries()) {
      bytes += event.bytes;
      while (event.at - sorted[from].at >= span) bytes -= sorted[from++].bytes;
      most = {
        bytes: Math.max(most.bytes, bytes),
        count: Math.max(most.count, index - from + 1),
      };
    }
    return most;
  };
  const first = sorted[0].at;
  const windows = Math.floor((sorted.at(-1)!.at - first) / 1000) + 1;
  const counts = new Array<number>(windows).fill(0);
  const bytes = new Array<number>(windows).fill(0);
  for (const event of sorted) {
    const window = Math.floor((event.at - first) / 1000);
    counts[window] += 1;
    bytes[window] += event.bytes;
  }
  const p99 = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.99) - 1];
  const second = sliding(1000);
  const tenth = sliding(100);
  return {
    bytes: sorted.reduce((sum, event) => sum + event.bytes, 0),
    bytesMax1s: second.bytes,
    bytesP99of1s: p99(bytes),
    countMax100ms: tenth.count,
    countMax1s: second.count,
    countP99of1s: p99(counts),
    largestBytes: Math.max(...sorted.map((event) => event.bytes)),
    proposed: headroom(sorted),
    seconds: Math.round((sorted.at(-1)!.at - first) / 100) / 10,
    updates: sorted.length,
  };
}

/**
 * The proposed token buckets over the events: a message is over the limit
 * when either allowance is empty when it arrives; it then takes one update
 * and its bytes, the byte allowance possibly going into debt. Returns the
 * least either allowance held before a message, and the messages over.
 */
function headroom(events: Sent[]) {
  let updates = PROPOSED.burstUpdates;
  let bytes = PROPOSED.burstBytes;
  let last = events[0].at;
  let least = { bytes, updates };
  let over = 0;
  for (const event of events) {
    const elapsed = (event.at - last) / 1000;
    last = event.at;
    updates = Math.min(
      PROPOSED.burstUpdates,
      updates + elapsed * PROPOSED.updatesPerSecond
    );
    bytes = Math.min(
      PROPOSED.burstBytes,
      bytes + elapsed * PROPOSED.bytesPerSecond
    );
    least = {
      bytes: Math.min(least.bytes, bytes),
      updates: Math.min(least.updates, updates),
    };
    if (updates <= 0 || bytes <= 0) {
      over += 1;
      continue;
    }
    updates -= 1;
    bytes -= event.bytes;
  }
  return {
    leastBytes: Math.round(least.bytes),
    leastUpdates: Math.round(least.updates * 10) / 10,
    over,
  };
}

async function openNote(page: Page, note: { id: string; readyText: string }) {
  await page.goto(
    `/workspaces/${PERF_WORKSPACE_ID}?material=${encodeURIComponent(note.id)}&mode=edit`
  );
  if (note === PERF_LARGE_NOTE)
    await page.getByTestId('heavy-material-open').click({ timeout: 180_000 });
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor.getByText(note.readyText).first()).toBeVisible({
    timeout: 180_000,
  });
  await installCounter(page);
  await page.waitForTimeout(1500);
  return editor;
}

/** Paste through the events a real clipboard fires (paste.spec.ts). */
async function pasteInto(
  editor: ReturnType<Page['locator']>,
  data: Record<string, string>
) {
  await editor.evaluate((element, entries) => {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(entries))
      transfer.setData(type, value);
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    });
    element.dispatchEvent(event);
    if (!event.defaultPrevented)
      element.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          inputType: 'insertFromPaste',
        })
      );
  }, data);
}

/**
 * Presses `keys` one every `every` ms on the clock, so the cadence holds
 * while each press takes a round trip (about 10 ms); 0 presses them as fast
 * as the page takes them.
 */
async function paced(page: Page, keys: string[], every: number) {
  const start = Date.now();
  for (const [index, key] of keys.entries()) {
    await page.keyboard.press(key);
    const wait = start + (index + 1) * every - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
  }
}

/** `count` presses of `key` every `every` ms (a held key repeats this way). */
const hold = (page: Page, key: string, count: number, every: number) =>
  paced(page, new Array<string>(count).fill(key), every);

/** Each character of `text` as a key (Space for a space). */
const keysOf = (text: string) =>
  [...text].map((character) => (character === ' ' ? 'Space' : character));

/** Prose of about `bytes`, as paragraphs of ~500 characters. */
function paragraphs(bytes: number) {
  const line = PROSE.repeat(8).slice(0, 500);
  return Array.from({ length: Math.ceil(bytes / 501) }, () => line);
}

test('note: typing, held keys, undo, paste', async ({ page }) => {
  const editor = await openNote(page, PERF_SMALL_NOTE);
  await editor.getByText(PERF_SMALL_NOTE.readyText).first().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');

  await reset(page);
  // A fast typist's burst: 15 keys per second.
  await paced(page, keysOf(PROSE.repeat(5).slice(0, 300)), 66);
  await record(page, 'note typing 15/s');

  await reset(page);
  // Key repeat: Windows' fastest (about 30/s) and macOS's fastest (15 ms).
  await hold(page, 'a', 300, 30);
  await record(page, 'note held key 33/s');
  await reset(page);
  await hold(page, 'b', 300, 15);
  await record(page, 'note held key 66/s');
  await reset(page);
  await hold(page, 'Backspace', 300, 15);
  await record(page, 'note held Backspace 66/s');
  await reset(page);
  await hold(page, 'Enter', 100, 15);
  await record(page, 'note held Enter 66/s');

  await reset(page);
  await paced(page, keysOf(PROSE.repeat(5).slice(0, 300)), 0);
  await record(page, 'note typing as fast as the editor takes');

  await reset(page);
  await hold(page, 'ControlOrMeta+z', 200, 15);
  await record(page, 'note held undo 66/s');
  await reset(page);
  await hold(page, 'ControlOrMeta+Shift+z', 200, 15);
  await record(page, 'note held redo 66/s');

  await page.keyboard.press('ControlOrMeta+End');
  await reset(page);
  const html = paragraphs(300_000)
    .map((line, index) =>
      index % 10 === 0
        ? `<h2>${line.slice(0, 60)}</h2>`
        : `<p><b>${line.slice(0, 40)}</b>${line.slice(40)}</p>`
    )
    .join('');
  await pasteInto(editor, { 'text/html': html, 'text/plain': 'x' });
  await record(page, 'note paste 300 KB HTML', { pastedBytes: html.length });

  await page.keyboard.press('ControlOrMeta+End');
  await reset(page);
  const text = paragraphs(1_500_000).join('\n');
  await pasteInto(editor, { 'text/plain': text });
  await record(page, 'note paste 1.5 MB text', { pastedBytes: text.length });
});

test('note: select all and delete in the near-limit note', async ({ page }) => {
  test.setTimeout(900_000);
  const editor = await openNote(page, PERF_LARGE_NOTE);
  await editor.getByText(PERF_LARGE_NOTE.readyText).first().click();
  await reset(page);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(5000);
  await record(page, 'near-limit note select all, Delete');
});

/**
 * What a reconnect replays: the editor applies its stored drafts before it
 * joins, so its step 2 (or a draft sweep's send) carries the session's
 * updates merged into one, which is what this merges.
 */
test('note: a session replayed as one update (drafts)', async ({ page }) => {
  const editor = await openNote(page, PERF_SMALL_NOTE);
  await editor.getByText(PERF_SMALL_NOTE.readyText).first().click();
  await page.keyboard.press('End');
  await page.evaluate(() => {
    window.__ratesKept = [];
  });
  await page.keyboard.press('Enter');
  await page.keyboard.type(PROSE.repeat(10).slice(0, 600), { delay: 20 });
  await pasteInto(editor, { 'text/plain': paragraphs(500_000).join('\n') });
  await page.waitForTimeout(3000);
  const kept = await page.evaluate(() =>
    (window.__ratesKept ?? []).map((update) => {
      let binary = '';
      for (let at = 0; at < update.length; at += 0x8000)
        binary += String.fromCharCode(...update.subarray(at, at + 0x8000));
      return btoa(binary);
    })
  );
  const updates = kept.map((row) => new Uint8Array(Buffer.from(row, 'base64')));
  await save('note session of 600 keys + 500 KB paste, replayed', {
    mergedBytes: Y.mergeUpdates(updates).byteLength,
    updateBytes: updates.reduce((sum, update) => sum + update.byteLength, 0),
    updates: updates.length,
  });
});

// ------------------------------------------------------------------ Office

const OFFICE = [
  { format: 'docx', id: 'bio-office-docx' },
  { format: 'xlsx', id: 'bio-office-xlsx' },
  { format: 'pptx', id: 'bio-office-pptx' },
] as const;

function runtimeFrame(page: Page): Frame {
  const frame = page.frames().find((f) => f.url().includes('office-runtime'));
  if (!frame) throw new Error('No Office runtime frame');
  return frame;
}

async function openOffice(page: Page, id: string) {
  await page.goto(`/workspaces/${PERF_WORKSPACE_ID}`);
  await page
    .getByRole('tab', { exact: true, name: m.workspace_tab_files() })
    .click();
  await page
    .locator(`[data-workspace-file-tree] a[href$="file=${id}"]`)
    .click();
  await expect(
    page.frameLocator('iframe[src*="office-runtime"]').locator('canvas').first()
  ).toBeVisible({ timeout: 120_000 });
  const mode = page.getByRole('button', { name: m.material_mode() });
  await expect(mode).toBeEnabled({ timeout: 60_000 });
  await mode.click();
  // The editor's menus arrive with its replica.
  await expect(
    page
      .getByRole('menubar', { name: m.files_office_menu_bar() })
      .getByRole('menuitem')
      .first()
  ).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(5000);
  await installCounter(page);
  return runtimeFrame(page);
}

/** A caret in the first page's body, the first sheet's B2, or the first
 * slide's title (runtime.office.ts placeCaret). */
async function placeCaret(page: Page, frame: Frame, format: string) {
  if (format === 'docx') {
    // A point over body text (the pages show a text cursor there), then the
    // editor's input takes the caret (biology-office.spec.ts).
    const box = await frame
      .locator('canvas[data-page-index="0"]')
      .boundingBox();
    if (!box) throw new Error('First page is not laid out');
    const pages = frame.locator('.canvas-pages');
    for (let y = 150; y < box.height; y += 20) {
      await page.mouse.move(box.x + box.width / 3, box.y + y);
      const cursor = await pages.evaluate(
        (node) => getComputedStyle(node).cursor
      );
      if (cursor !== 'text') continue;
      await page.mouse.click(box.x + box.width / 3, box.y + y);
      break;
    }
    const input = frame.getByTestId('yrs-input');
    await expect(input).toHaveAttribute('data-pointer-placement', 'ready');
    await input.press('End');
  } else if (format === 'xlsx') {
    const box = await frame
      .locator('[data-testid="xlsx-scroll"]')
      .boundingBox();
    if (!box) throw new Error('Grid is not laid out');
    await page.mouse.click(box.x + 300, box.y + 120);
  } else {
    const canvas = frame.getByTestId('pptx-slide-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Slide is not laid out');
    await canvas.click({
      clickCount: 2,
      position: { x: box.width * 0.5, y: box.height * 0.456 },
    });
    await expect(frame.getByTestId('pptx-text-input')).toBeFocused();
    await page.keyboard.press('ControlOrMeta+End');
  }
}

/** A photo larger than any plan's image cap, which the editor shrinks
 * (e2e/editor/office-images.spec.ts). */
function photo(page: Page) {
  return page.evaluate(async () => {
    const [width, height] = [4000, 3000];
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d')!;
    const image = context.createImageData(width, height);
    let seed = 2_463_534_242;
    for (let at = 0; at < image.data.length; at += 4) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const noise = ((seed >>> 0) / 4_294_967_296 - 0.5) * 50;
      const x = (at / 4) % width;
      const y = Math.floor(at / 4 / width);
      image.data[at] = (x * 255) / width + noise;
      image.data[at + 1] = (y * 255) / height + noise;
      image.data[at + 2] = 128 + noise;
      image.data[at + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    const blob = await canvas.convertToBlob({
      quality: 0.95,
      type: 'image/jpeg',
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  });
}

for (const { format, id } of OFFICE)
  test(`${format}: typing, held keys, paste`, async ({ context, page }) => {
    const frame = await openOffice(page, id);
    for (const origin of [
      new URL(page.url()).origin,
      new URL(frame.url()).origin,
    ])
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
        origin,
      });
    await placeCaret(page, frame, format);

    await reset(page);
    if (format === 'xlsx') {
      // A number and Enter, the way a column is filled in by hand.
      await paced(
        page,
        Array.from({ length: 150 }, (_, index) =>
          index % 3 === 2 ? 'Enter' : String(index % 10)
        ),
        66
      );
    } else await paced(page, keysOf(PROSE.repeat(3).slice(0, 150)), 66);
    await record(page, `${format} typing 15/s`);

    await reset(page);
    if (format === 'xlsx') await hold(page, 'Enter', 150, 15);
    else await hold(page, 'a', 150, 15);
    await record(
      page,
      `${format} held ${format === 'xlsx' ? 'Enter' : 'key'} 66/s`
    );

    if (format !== 'xlsx') {
      await reset(page);
      await hold(page, 'Backspace', 150, 15);
      await record(page, `${format} held Backspace 66/s`);
      await reset(page);
      await hold(page, 'ControlOrMeta+z', 100, 15);
      await record(page, `${format} held undo 66/s`);
    }

    // The clipboard: 1,000 rows of 8 cells for a sheet, ~200 KB of prose
    // otherwise.
    const clip =
      format === 'xlsx'
        ? Array.from({ length: 1000 }, (_, row) =>
            Array.from({ length: 8 }, (_, col) =>
              String((row * 7 + col) % 97)
            ).join('\t')
          ).join('\n')
        : paragraphs(200_000).join('\n');
    await frame.evaluate((value) => navigator.clipboard.writeText(value), clip);
    await reset(page);
    await page.keyboard.press('ControlOrMeta+v');
    await page.waitForTimeout(10_000);
    await record(
      page,
      `${format} paste ${format === 'xlsx' ? '8,000 cells' : '200 KB text'}`,
      {
        pastedBytes: clip.length,
      }
    );

    if (format === 'xlsx') {
      // Clearing what the paste selected.
      await reset(page);
      await page.keyboard.press('Delete');
      await page.waitForTimeout(5000);
      await record(page, 'xlsx Delete 8,000 cells');
    } else {
      await page.keyboard.press('Escape');
      await reset(page);
      await page
        .getByRole('menubar', { name: m.files_office_menu_bar() })
        .getByRole('menuitem', {
          exact: true,
          name:
            format === 'docx' ? 'Insert' : m.files_office_pptx_menu_insert(),
        })
        .click();
      const chooser = page.waitForEvent('filechooser');
      await page
        .getByRole('menuitem', {
          exact: true,
          name: format === 'docx' ? 'Image' : m.files_office_pptx_image(),
        })
        .click();
      await (await chooser).setFiles({
        buffer: Buffer.from(await photo(page), 'base64'),
        mimeType: 'image/jpeg',
        name: 'photo.jpg',
      });
      await page.waitForTimeout(15_000);
      await record(page, `${format} insert a photo (Free cap, 2 MiB)`);
    }
  });

/** A DOCX paste sends updates in a burst: how many, for a few sizes and
 * shapes of clipboard text. */
test('docx: paste sizes', async ({ context, page }) => {
  test.setTimeout(900_000);
  const frame = await openOffice(page, 'bio-office-docx');
  for (const origin of [
    new URL(page.url()).origin,
    new URL(frame.url()).origin,
  ])
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin,
    });
  await placeCaret(page, frame, 'docx');
  for (const [label, clip] of [
    ['one 2 KB paragraph', PROSE.repeat(40).slice(0, 2000)],
    ['50 KB in 100 paragraphs', paragraphs(50_000).join('\n')],
    [
      '50 KB in 2,500 short lines',
      Array.from({ length: 2500 }, (_, i) => `line ${i} ok`).join('\n'),
    ],
    ['1 MB in 2,000 paragraphs', paragraphs(1_000_000).join('\n')],
  ] as const) {
    await frame.evaluate((value) => navigator.clipboard.writeText(value), clip);
    await reset(page);
    await page.keyboard.press('ControlOrMeta+v');
    await page.waitForTimeout(clip.length > 100_000 ? 30_000 : 10_000);
    await record(page, `docx paste ${label}`, { pastedBytes: clip.length });
  }
});
