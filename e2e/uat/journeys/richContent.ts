/* biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared assertion helpers execute inside the UAT tests. */
// The rich-content fixtures (e2e/fixtures/files/rich-content/README.md): what
// each actor edits, what the user sees in the editor and viewer, and what the
// exported and published bytes keep.
import assert from 'node:assert/strict';
import { expect, type FrameLocator, type Page } from '@playwright/test';
import { strFromU8, type Unzipped, unzipSync } from 'fflate';
import { type Range, read as readWorkbook, utils } from 'xlsx';
import { type OfficeFormat, replaceSlideText, saveOffice } from './office';

export const richFiles = {
  docx: 'exchange-plan.docx',
  pptx: 'lecture.pptx',
  xlsx: 'course-guide.xlsx',
} as const;

const DOCX_COUNT = '人數：24人';
const DOCX_TOPIC = '主題：智能科技，精湛技術';
const DOCX_APPENDED = ' Collaborator confirmed the July tour.';
const DOCX_CELLS = [
  '陳大文主席',
  '李小明外務副主席',
  '何晴內務副主席',
  '張志強宣傳幹事',
  '工作',
  '統籌',
  '計劃設計',
  '聯絡機構',
  '宣傳工作',
];
const XLSX_NOTE = 'Collaborator office hours moved to Friday.';
const PPTX_OWNER = 'Owner sentence: The launch code is CEDAR-42.';
const PPTX_COLLABORATOR = 'Collaborator sentence: The survey starts in July.';

/** Actor A (owner) or B (collaborator) makes the fixture README's edit. */
export async function editRich(
  page: Page,
  frame: FrameLocator,
  format: OfficeFormat,
  collaborator: boolean
) {
  if (format === 'docx') {
    const input = frame.getByRole('textbox', { name: 'Document input' });
    if (collaborator) {
      await expect(
        frame.getByRole('paragraph').filter({ hasText: /^人數：24人$/ })
      ).toBeAttached({ timeout: 60_000 });
      await focusParagraph(frame, DOCX_TOPIC);
      await input.press('End');
      await input.pressSequentially(DOCX_APPENDED);
    } else {
      await focusParagraph(frame, '人數：20人');
      await input.press('End');
      await input.press('ArrowLeft');
      await input.press('Backspace');
      await input.press('Backspace');
      await input.pressSequentially('24');
    }
  } else if (format === 'xlsx') {
    if (collaborator) await setCell(frame, 'Faculty Database', 'C3', XLSX_NOTE);
    else await setCell(frame, 'CC info', 'H5', '4');
  } else if (collaborator) {
    // First body paragraph of slide 18; its box starts at 0.34in,1.26in.
    await replaceSlideText(frame, 17, PPTX_COLLABORATOR, { x: 0.2, y: 0.265 });
  } else {
    // First (numbered) body paragraph of slide 3, same box.
    await replaceSlideText(frame, 2, PPTX_OWNER, { x: 0.25, y: 0.265 });
  }
  await saveOffice(page);
}

/**
 * Deterministic text past the automatic refresh trigger (3,000 net tokens:
 * about 3,500 here), marked with the run marker.
 */
export function richPaste(marker: string) {
  return `${marker} ${'Field notes repeat this sentence to pass the refresh threshold. '.repeat(220).trim()}`;
}

/**
 * The owner pastes `text` where the preserved-content checks do not look: a
 * new last DOCX paragraph, or `Summary!A8` of the XLSX (the first row past the
 * sheet's used range, as far as arrow keys go), or a new paragraph in the
 * PPTX slide 3 body. PPTX uses the real system clipboard and paste shortcut.
 */
export async function pasteRich(
  page: Page,
  frame: FrameLocator,
  format: OfficeFormat,
  text: string
) {
  if (format === 'docx') {
    const input = frame.getByRole('textbox', { name: 'Document input' });
    await input.focus();
    await input.press('ControlOrMeta+End');
    await input.press('Enter');
    await page.keyboard.insertText(text);
  } else if (format === 'xlsx') await setCell(frame, 'Summary', 'A8', text);
  else {
    await frame.locator('aside button').nth(2).click();
    const canvas = frame.getByTestId('pptx-slide-canvas');
    const box = await canvas.boundingBox();
    assert(box, 'slide canvas cannot receive a pointer action');
    await canvas.click({
      clickCount: 2,
      position: { x: box.width * 0.25, y: box.height * 0.265 },
    });
    const input = frame.getByTestId('pptx-text-input');
    await expect(input).toBeFocused();
    await input.press('ControlOrMeta+End');
    await input.press('Enter');
    await page
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(
      async (value) => navigator.clipboard.writeText(value),
      text
    );
    await input.press('ControlOrMeta+V');
  }
  await saveOffice(page);
}

// The mirror ignores pointer events, so force routes the click to the canvas.
// During a remote layout the mirror remains mounted but clicks are gated.
// The text cursor confirms hit testing is ready before we place the caret.
// Mirror pages away from the viewport hold only plain text, so each attempt
// brings the paragraph's page into view and points at its positioned glyph.
async function focusParagraph(frame: FrameLocator, text: string) {
  const paragraph = frame
    .getByRole('paragraph')
    .filter({ hasText: new RegExp(`^${text}$`) });
  const last = frame
    .locator('.layout-page-mirror:not(.layout-page-mirror-text)')
    .getByRole('paragraph')
    .filter({ hasText: new RegExp(`^${text}$`) })
    .getByText(text.at(-1) ?? '', { exact: true })
    .last();
  await expect(async () => {
    await frame
      .locator('.layout-page-mirror')
      .filter({ has: paragraph })
      .scrollIntoViewIfNeeded({ timeout: 5000 });
    await last.hover({ force: true, timeout: 5000 });
    await expect(frame.locator('.canvas-pages')).toHaveCSS('cursor', 'text', {
      timeout: 1000,
    });
    await last.click({ force: true, timeout: 5000 });
    const input = frame.getByRole('textbox', { name: 'Document input' });
    await expect(input).toHaveAttribute('data-pointer-placement', 'ready', {
      timeout: 1000,
    });
    const range = await last.evaluate((node) => {
      const paragraph = node.closest<HTMLElement>('[role="paragraph"]');
      return {
        end: Number(paragraph?.dataset.docEnd),
        start: Number(paragraph?.dataset.docStart),
      };
    });
    const head = Number(await input.getAttribute('data-selection-head'));
    expect(head).toBeGreaterThanOrEqual(range.start);
    expect(head).toBeLessThanOrEqual(range.end);
  }).toPass({ timeout: 60_000 });
}

async function setCell(
  frame: FrameLocator,
  sheet: string,
  cell: string,
  value: string
) {
  await frame.getByRole('tab', { exact: true, name: sheet }).click();
  const grid = frame.getByTestId('xlsx-scroll');
  const nameBox = frame.getByTestId('xlsx-name-box');
  await grid.focus();
  await grid.press('ControlOrMeta+Home');
  await expect(nameBox).toHaveValue('A1');
  const [, column = '', row = ''] = /^([A-Z])(\d+)$/.exec(cell) ?? [];
  for (let i = 1; i < Number(row); i++) await grid.press('ArrowDown');
  for (let i = 65; i < column.charCodeAt(0); i++)
    await grid.press('ArrowRight');
  await expect(nameBox).toHaveValue(cell);
  const input = frame.getByTestId('xlsx-formula-input');
  await input.fill(value);
  await input.press('Enter');
}

/**
 * What the user sees after both edits, through the runtime's accessible
 * mirror (screenshots are outside the assertion policy). The PPTX editor has
 * no slide text mirror, so it shows the speaker notes; the viewer shows slide
 * text but no table, comment, connector or picture nodes.
 */
export async function expectRichContent(
  frame: FrameLocator,
  format: OfficeFormat,
  marker: string,
  mode: 'edit' | 'view'
) {
  const timeout = 60_000;
  if (format === 'docx') {
    const paragraph = (text: string) =>
      frame.getByRole('paragraph').filter({ hasText: text }).first();
    for (const text of [DOCX_COUNT, DOCX_TOPIC + DOCX_APPENDED, marker])
      await expect(paragraph(text)).toBeAttached({ timeout });
    await expect(
      frame.getByRole('table').filter({ hasText: DOCX_CELLS[0] })
    ).toHaveCount(1);
    for (const chart of ['交流團預計支出', '交流團預計收入'])
      await expect(
        frame.getByRole('img', { exact: true, name: chart }).first()
      ).toBeAttached();
    // The three pictures carry no alternative text.
    await expect(frame.locator('[role="img"]:not([aria-label])')).toHaveCount(
      3
    );
    await expect(
      frame.getByRole('region', { name: 'Page footer' }).first()
    ).toBeAttached();
  } else if (format === 'xlsx') {
    const cell = (name: string) =>
      frame.getByRole('gridcell', { exact: true, name });
    // The mirror holds only painted cells. At the journeys' 1280x720 the
    // runtime paints `CC info` up to column G, so the grid scrolls right, as
    // a user would, until H5 is painted.
    await frame.getByRole('tab', { exact: true, name: 'CC info' }).click();
    const page = frame.owner().page();
    await expect(async () => {
      if (await cell('H5, 4').count()) return;
      await frame.owner().hover();
      await page.mouse.wheel(200, 0);
      await expect(cell('H5, 4')).toBeAttached({ timeout: 1000 });
    }).toPass({ timeout });
    for (const [sheet, label] of [
      ['Faculty Database', `C3, ${XLSX_NOTE}`],
      ['Summary', 'D4, 5.4'],
    ]) {
      await frame.getByRole('tab', { exact: true, name: sheet }).click();
      await expect(cell(label)).toBeAttached({ timeout });
    }
    await expect(cell('C4, 10')).toBeAttached();
    await expect(
      frame.getByRole('img', { name: /^Average workload by area, / })
    ).toBeAttached();
  } else if (mode === 'edit') {
    await frame.locator('aside button').nth(1).click();
    // Speaker notes start hidden; the choice is remembered per browser.
    const notesToggle = frame.getByTestId('pptx-notes-toggle');
    if ((await notesToggle.getAttribute('aria-pressed')) !== 'true')
      await notesToggle.click();
    await expect(
      frame.getByRole('textbox', { name: 'Speaker notes' })
    ).toHaveValue('Speaker note: the rehearsal takes 12 minutes.', {
      timeout,
    });
  } else {
    let current = 1;
    for (const [slide, text] of [
      [1, marker],
      [3, PPTX_OWNER],
      [18, PPTX_COLLABORATOR],
    ] as const) {
      for (; current < slide; current++) {
        await frame.getByTestId('pptx-next-slide').click();
        await expect(frame.getByRole('status')).toHaveText(
          `Slide ${current + 1} of 20`
        );
      }
      await expect(
        frame.getByRole('region', { name: `Slide ${slide} of 20 content` })
      ).toContainText(text, { timeout });
    }
  }
}

/** Whether exported bytes hold both actors' edits. */
export function richEdited(format: OfficeFormat, bytes: Uint8Array) {
  const zip = unzipSync(bytes);
  if (format === 'docx') {
    const paragraphs = texts(zip, 'word/document.xml', 'w');
    return (
      paragraphs.includes(DOCX_COUNT) &&
      paragraphs.includes(DOCX_TOPIC + DOCX_APPENDED)
    );
  }
  if (format === 'xlsx') {
    const sheets = readWorkbook(bytes, { type: 'buffer' }).Sheets;
    return (
      sheets['CC info'].H5?.v === 4 &&
      sheets['Faculty Database'].C3?.v === XLSX_NOTE
    );
  }
  return (
    texts(zip, 'ppt/slides/slide3.xml', 'a').includes(PPTX_OWNER) &&
    texts(zip, 'ppt/slides/slide18.xml', 'a').includes(PPTX_COLLABORATOR)
  );
}

/**
 * The README's preserved content, in bytes exported from the saved state or
 * published, with the pasted text when given.
 */
export function assertRichPreserved(
  format: OfficeFormat,
  original: Uint8Array,
  exported: Uint8Array,
  marker: string,
  paste?: string
) {
  assert(richEdited(format, exported), `${format} export lacks the edits`);
  const before = unzipSync(original);
  const after = unzipSync(exported);
  const same = (part: string) =>
    assert(
      after[part] && Buffer.from(after[part]).equals(before[part]),
      `${part} changed`
    );
  if (format === 'pptx') {
    // Only the two edited slides change: the table, comments, notes, media,
    // connectors and hyperlink targets stay byte-identical.
    for (const part of Object.keys(before))
      if (!/^ppt\/slides\/slide(3|18)\.xml$/.test(part)) same(part);
    assert(texts(after, 'ppt/slides/slide1.xml', 'a').includes(marker));
    if (paste)
      assert(texts(after, 'ppt/slides/slide3.xml', 'a').includes(paste));
    return;
  }
  if (format === 'docx') {
    const xml = strFromU8(after['word/document.xml']);
    const paragraphs = texts(after, 'word/document.xml', 'w');
    for (const text of [marker, ...DOCX_CELLS, ...(paste ? [paste] : [])])
      assert(
        paragraphs.includes(text),
        `missing paragraph ${text.slice(0, 40)}`
      );
    assert(!paragraphs.includes('人數：20人'));
    assert.equal(xml.match(/<w:tbl>/g)?.length, 6);
    assert.equal(xml.match(/<w:lang\b[^>]*w:eastAsia="ja-JP"/g)?.length, 6);
    assert.equal(xml.match(/<w:br w:type="page"\/>/g)?.length, 5);
    const links = relationships(after, 'word/document.xml');
    const charts = [...xml.matchAll(/<c:chart\b[^>]*\br:id="([^"]+)"/g)].map(
      (match) => links.get(match[1])
    );
    assert.deepEqual(charts, [
      'word/charts/chart1.xml',
      'word/charts/chart2.xml',
    ]);
    // Chart parts carry the cached values; their relationships name the
    // embedded workbooks.
    for (const part of Object.keys(before))
      if (/^word\/(charts|embeddings|media)\//.test(part)) same(part);
    const pictures = [...xml.matchAll(/\br:embed="([^"]+)"/g)].map((match) =>
      links.get(match[1])
    );
    assert.deepEqual(pictures.sort(), [
      'word/media/image1.png',
      'word/media/image2.png',
      'word/media/image3.png',
    ]);
    const footer = /<w:footerReference\b[^>]*\br:id="([^"]+)"/.exec(xml)?.[1];
    assert(after[links.get(footer ?? '') ?? ''], 'the footer is lost');
    return;
  }
  const workbook = readWorkbook(exported, { type: 'buffer' });
  const source = readWorkbook(original, { type: 'buffer' });
  assert.deepEqual(workbook.SheetNames, source.SheetNames);
  const summary = workbook.Sheets.Summary;
  for (const row of [2, 3, 4, 5])
    for (const column of ['B', 'C', 'D', 'E'])
      assert.equal(
        summary[`${column}${row}`].f,
        source.Sheets.Summary[`${column}${row}`].f
      );
  assert.equal(summary.C4.v, 10);
  assert.equal(summary.D4.v, 5.4);
  assert.equal(summary.A7.v, marker);
  if (paste) assert.equal(summary.A8.v, paste);
  const summaryPart = sheetPart(after, 'Summary');
  assert(
    strFromU8(after[summaryPart]).includes(
      '<f t="shared" ref="E2:E5" si="0">C2/B2</f>'
    ),
    'the shared formula is lost'
  );
  const ranges = (merges: Range[] = []) =>
    merges.map((merge) => utils.encode_range(merge)).sort();
  for (const name of ['CC info', 'Faculty Database'])
    assert.deepEqual(
      ranges(workbook.Sheets[name]['!merges']),
      ranges(source.Sheets[name]['!merges'])
    );
  for (const [name, cell] of [
    ['CC info', 'P32'],
    ['Faculty Database', 'E9'],
    ['Faculty Database', 'E10'],
  ])
    assert.equal(
      workbook.Sheets[name][cell].l?.Target,
      source.Sheets[name][cell].l?.Target
    );
  const info = strFromU8(after[sheetPart(after, 'CC info')]);
  assert(/<pane\b[^>]*topLeftCell="C3"[^>]*state="frozen"/.test(info));
  assert(info.includes('<conditionalFormatting sqref="I1">'));
  // Summary -> drawing -> chart, the chart part unchanged.
  const drawing = [...relationships(after, summaryPart).values()].find((part) =>
    part.startsWith('xl/drawings/')
  );
  assert(drawing, 'the Summary drawing is lost');
  const chart = [...relationships(after, drawing).values()].find((part) =>
    part.startsWith('xl/charts/')
  );
  assert.equal(chart, 'xl/charts/chart1.xml');
  same(chart);
}

// Paragraph texts of a WordprocessingML (`w`) or DrawingML (`a`) part.
function texts(zip: Unzipped, part: string, ns: 'w' | 'a') {
  const run = new RegExp(`<${ns}:t(?:\\s[^>]*)?>([^<]*)</${ns}:t>`, 'g');
  return strFromU8(zip[part])
    .split(`</${ns}:p>`)
    .map((paragraph) =>
      [...paragraph.matchAll(run)].map((match) => match[1]).join('')
    );
}

// Relationship ids of a part, mapped to the package paths they target.
function relationships(zip: Unzipped, part: string) {
  const rels = part.replace(/([^/]+)$/, '_rels/$1.rels');
  const links = new Map<string, string>();
  for (const [tag] of strFromU8(zip[rels]).matchAll(/<Relationship\b[^>]*>/g))
    links.set(
      /\bId="([^"]+)"/.exec(tag)?.[1] ?? '',
      new URL(
        /\bTarget="([^"]+)"/.exec(tag)?.[1] ?? '',
        `http://package/${part}`
      ).pathname.slice(1)
    );
  return links;
}

function sheetPart(zip: Unzipped, name: string) {
  const id = new RegExp(
    `<sheet\\b[^>]*\\bname="${name}"[^>]*\\br:id="([^"]+)"`
  ).exec(strFromU8(zip['xl/workbook.xml']))?.[1];
  const part = relationships(zip, 'xl/workbook.xml').get(id ?? '');
  assert(part, `sheet ${name} is lost`);
  return part;
}
