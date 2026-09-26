/* biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared assertion helpers execute inside the UAT tests. */
// The rich-content fixtures (e2e/fixtures/files/rich-content/README.md): what
// each actor edits, what the user sees in the editor and viewer, and what the
// exported and published bytes keep.
import assert from 'node:assert/strict';
import { expect, type FrameLocator, type Page } from '@playwright/test';
import { strFromU8, type Unzipped, unzipSync } from 'fflate';
import { type Range, read as readWorkbook, utils } from 'xlsx';
import { type OfficeFormat, replaceSlideText } from './office';

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
      await caretAfter(page, frame, DOCX_TOPIC);
      await input.press('End');
      await input.pressSequentially(DOCX_APPENDED);
    } else {
      await caretAfter(page, frame, '人數：20人');
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
  await page.getByRole('button', { exact: true, name: 'Save' }).click();
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
 * sheet's used range, as far as arrow keys go). The PPTX editor takes text
 * only as single-key presses, so it has no paste.
 */
export async function pasteRich(
  page: Page,
  frame: FrameLocator,
  format: 'docx' | 'xlsx',
  text: string
) {
  if (format === 'docx') {
    const input = frame.getByRole('textbox', { name: 'Document input' });
    await input.focus();
    await input.press('ControlOrMeta+End');
    await input.press('Enter');
    await page.keyboard.insertText(text);
  } else await setCell(frame, 'Summary', 'A8', text);
  await page.getByRole('button', { exact: true, name: 'Save' }).click();
}

// The page mirror draws one span per character; clicking the right half of
// the paragraph's last character puts the caret after it. The mirror is
// rebuilt after each edit, so a detached span is retried. Clicks move the
// caret at once while typed keys apply later, so each editor clicks only
// before it types (both actors never share one editor).
async function caretAfter(page: Page, frame: FrameLocator, text: string) {
  const last = frame
    .getByRole('paragraph')
    .filter({ hasText: new RegExp(`^${text}$`) })
    .getByText(text.at(-1) ?? '', { exact: true })
    .last();
  await expect(async () => {
    await last.scrollIntoViewIfNeeded({ timeout: 5000 });
    const box = await last.boundingBox();
    assert(box, `paragraph ${text} is not painted`);
    await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2);
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
    for (const [sheet, label] of [
      ['CC info', 'H5, 4'],
      ['Faculty Database', `C3, ${XLSX_NOTE}`],
      ['Summary', 'D4, 5.4'],
    ]) {
      await frame.getByRole('tab', { exact: true, name: sheet }).click();
      await expect(
        frame.getByRole('gridcell', { exact: true, name: label })
      ).toBeAttached({ timeout });
    }
    await expect(
      frame.getByRole('gridcell', { exact: true, name: 'C4, 10' })
    ).toBeAttached();
    await expect(
      frame.getByRole('img', { name: /^Average workload by area, / })
    ).toBeAttached();
  } else if (mode === 'edit') {
    await frame.locator('aside button').nth(1).click();
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
        await frame.getByRole('button', { exact: true, name: 'Next' }).click();
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
 * published, with the pasted text when given. DOCX export drops the six
 * eastAsia language tags even without edits (the filed DOCX-properties task),
 * so they are not checked here.
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
