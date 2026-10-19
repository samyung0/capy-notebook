import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { unzipSync } from 'fflate';
import { officeEditMenu, officeMenu } from '../helpers/office';
import { m } from '../i18n';

/** PLAN_LIMITS.free.imageMaxBytes: the mock Office sessions carry the Free cap. */
const FREE_IMAGE_MAX_BYTES = 2_097_152;

type Kind = 'photo' | 'transparent' | 'webp';

/** A noisy gradient: a 4000×3000 JPEG photo of about 6.5 MB; a 3000×3000 PNG
 * of about 6.9 MB whose only opaque part is a translucent 1600 px square (as
 * PNG about 2.9 MB at 2000 px, 1.4 MB at 1400 px); or a small opaque WebP. */
function makeImage(page: Page, kind: Kind) {
  return page.evaluate(async (kind) => {
    const [width, height, amp] = {
      photo: [4000, 3000, 50],
      transparent: [3000, 3000, 60],
      webp: [600, 400, 50],
    }[kind];
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d')!;
    const image = context.createImageData(width, height);
    let seed = 2_463_534_242;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 4_294_967_296;
    };
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 4;
        const noise = (random() - 0.5) * amp;
        const inside =
          Math.abs(x - width / 2) < 800 && Math.abs(y - height / 2) < 800;
        image.data[at] = (x * 255) / width + noise;
        image.data[at + 1] = (y * 255) / height + noise;
        image.data[at + 2] = 128 + noise;
        image.data[at + 3] = kind === 'transparent' ? (inside ? 160 : 0) : 255;
      }
    context.putImageData(image, 0, 0);
    const blob = await canvas.convertToBlob(
      {
        photo: { quality: 0.95, type: 'image/jpeg' },
        transparent: { type: 'image/png' },
        webp: { quality: 0.9, type: 'image/webp' },
      }[kind]
    );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x80_00)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x80_00));
    return btoa(binary);
  }, kind);
}

/** A 1×1 two-frame GIF padded past `size` bytes with a comment: an animated
 * GIF over the cap, which nothing can shrink. */
function animatedGif(size: number) {
  const frame = [
    ...[0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00],
    ...[0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0],
    ...[0x02, 0x02, 0x44, 0x01, 0x00],
  ];
  const blocks = Math.ceil(size / 255);
  const comment = Buffer.alloc(blocks * 256 + 1, 0x20);
  for (let i = 0; i < blocks; i++) comment[i * 256] = 255;
  comment[blocks * 256] = 0;
  return Buffer.concat([
    Buffer.from('GIF89a'),
    Buffer.from([1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]),
    Buffer.from([...frame, ...frame, 0x21, 0xfe]),
    comment,
    Buffer.from([0x3b]),
  ]);
}

/** Insert › Image through Capy's picker. */
async function insert(
  page: Page,
  format: 'docx' | 'pptx',
  file: { buffer: Buffer; mimeType: string; name: string }
) {
  await officeMenu(page, format, 'Insert').click();
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('menuitem', {
      exact: true,
      name: format === 'docx' ? 'Image' : m.files_office_pptx_image(),
    })
    .click();
  await (await chooser).setFiles(file);
}

/** The exported file, from File › Download as Capy saves it. A plain menu
 * click: an insert that lands meanwhile must leave Capy's menu open. */
async function download(page: Page, format: 'docx' | 'pptx') {
  await officeMenu(page, format, 'File').click();
  await page
    .getByRole('menuitem', {
      exact: true,
      name: format === 'docx' ? 'Download' : m.files_office_pptx_download(),
    })
    .click();
  const downloaded = page.waitForEvent('download');
  await page
    .getByRole('menuitem', {
      name:
        format === 'docx'
          ? 'Word document (.docx)'
          : m.files_office_pptx_download_pptx(),
    })
    .click();
  return new Uint8Array(await readFile((await (await downloaded).path())!));
}

const sha = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

/** The file's pictures, by content hash. */
function media(bytes: Uint8Array) {
  return new Map(
    Object.entries(unzipSync(bytes))
      .filter(([path]) => /^(word|ppt)\/media\//.test(path))
      .map(([, part]) => [sha(part), part])
  );
}

for (const [format, name] of [
  ['docx', 'exchange-plan.docx'],
  ['pptx', 'lecture.pptx'],
] as const) {
  test(`${format} Insert › Image fits pictures under the Free cap as PNG or JPEG, and refuses one it cannot fit or read with a notice`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await page.goto('/workspaces/ws_bio');
    await page
      .getByRole('tab', { exact: true, name: m.workspace_tab_files() })
      .click();
    await page
      .locator(
        `[data-workspace-file-tree] a[href*="file=bio-office-${format}"]`
      )
      .click();
    await expect(
      page.getByRole('heading', { exact: true, name })
    ).toBeVisible();
    const frame = page.frameLocator('iframe[src*="office-runtime"]');
    await expect(frame.locator('canvas').first()).toBeVisible({
      timeout: 60_000,
    });
    await page.getByRole('button', { name: m.material_mode() }).click();
    await expect(officeEditMenu(page, format)).toBeVisible({ timeout: 30_000 });
    const before = media(await download(page, format));

    // Nothing shrinks an animated GIF over the cap: Capy's notice, not the
    // file error, and the document is unchanged (the count below).
    await insert(page, format, {
      buffer: animatedGif(FREE_IMAGE_MAX_BYTES + 1),
      mimeType: 'image/gif',
      name: 'spinner.gif',
    });
    await expect(
      page.getByText(m.image_too_large({ limit: '2 MB' }))
    ).toBeVisible();
    await expect(page.getByText(m.error_file_body())).toHaveCount(0);
    // Nor can one the browser cannot decode (a TIFF in Chrome): its own notice.
    await insert(page, format, {
      buffer: Buffer.from('II*, not really a TIFF'),
      mimeType: 'image/tiff',
      name: 'scan.tiff',
    });
    await expect(page.getByText(m.image_unreadable())).toBeVisible();
    await expect(page.getByText(m.error_file_body())).toHaveCount(0);

    let inserted: Uint8Array[] = [];
    for (const [kind, file, mimeType] of [
      ['photo', 'photo.jpg', 'image/jpeg'],
      ['transparent', 'logo.png', 'image/png'],
      ['webp', 'chart.webp', 'image/webp'],
    ] as const) {
      const buffer = Buffer.from(await makeImage(page, kind), 'base64');
      expect(buffer.length).toBeGreaterThan(
        { photo: 6_000_000, transparent: 6_000_000, webp: 0 }[kind]
      );
      if (kind === 'webp') {
        expect(buffer.length).toBeLessThan(FREE_IMAGE_MAX_BYTES);
        expect(buffer.subarray(8, 12).toString()).toBe('WEBP');
      }
      await insert(page, format, { buffer, mimeType, name: file });
      // The shrink runs in the frame before the picture lands.
      const count = inserted.length + 1;
      await expect
        .poll(
          async () => {
            inserted = [...media(await download(page, format))]
              .filter(([hash]) => !before.has(hash))
              .map(([, part]) => part);
            return inserted.length;
          },
          { intervals: [1000], timeout: 60_000 }
        )
        .toBe(count);
    }

    for (const part of inserted)
      expect(part.length).toBeLessThanOrEqual(FREE_IMAGE_MAX_BYTES);
    // Each picture's format, size and the alpha of a corner and the centre:
    // the photo as JPEG at 2000 px; the transparent PNG still PNG with its
    // clear border and translucent square, stepped down to 1400 px since it
    // is over the cap at 2000; the small WebP re-encoded as JPEG.
    const pictures = await page.evaluate(
      (parts) =>
        Promise.all(
          parts.map(async ([signature, base64]) => {
            const bytes = Uint8Array.from(atob(base64), (char) =>
              char.charCodeAt(0)
            );
            const bitmap = await createImageBitmap(new Blob([bytes]));
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = canvas.getContext('2d')!;
            context.drawImage(bitmap, 0, 0);
            const alpha = (x: number, y: number) =>
              context.getImageData(x, y, 1, 1).data[3];
            return `${signature} ${bitmap.width}x${bitmap.height} ${alpha(5, 5)} ${alpha(bitmap.width / 2, bitmap.height / 2)}`;
          })
        ),
      inserted.map((part) => [
        Buffer.from(part.subarray(0, 3)).toString('hex'),
        Buffer.from(part).toString('base64'),
      ])
    );
    expect(pictures.sort()).toEqual([
      '89504e 1400x1400 0 160',
      'ffd8ff 2000x1500 255 255',
      'ffd8ff 600x400 255 255',
    ]);
  });
}

test('docx Insert › Image refuses a picture past the growth budget of the file with a notice', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/workspaces/ws_bio?file=bio-office-docx');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  // Under the runtime's 4 KiB slack, so no room at all: refused before any
  // shrink. Set once, not as an init script, which every runtime frame would
  // run.
  await page.evaluate(() =>
    sessionStorage.setItem(
      'capy.mock.growthBudgetBytes.bio-office-docx',
      '2000'
    )
  );
  await page.getByRole('button', { name: m.material_mode() }).click();
  await expect(officeEditMenu(page, 'docx')).toBeVisible({ timeout: 30_000 });
  const before = media(await download(page, 'docx'));
  const buffer = Buffer.from(await makeImage(page, 'webp'), 'base64');
  await insert(page, 'docx', {
    buffer,
    mimeType: 'image/webp',
    name: 'chart.webp',
  });
  await expect(page.getByText(m.files_office_image_budget())).toBeVisible();
  await expect(page.getByText(m.error_file_body())).toHaveCount(0);
  expect(media(await download(page, 'docx')).size).toBe(before.size);
});

test('a DOCX with no growth budget left opens to view only with the size-limit notice', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/workspaces/ws_bio?file=bio-office-docx');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  await page.evaluate(() =>
    sessionStorage.setItem('capy.mock.growthBudgetBytes.bio-office-docx', '0')
  );
  await page.getByRole('button', { name: m.material_mode() }).click();
  await expect(page.getByText(m.files_office_size_limit())).toBeVisible({
    timeout: 30_000,
  });
  await expect(officeEditMenu(page, 'docx')).toHaveCount(0);
  // The saved view loads into a fresh frame.
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText(m.error_file_body())).toHaveCount(0);
});

test('pptx Insert › Image shrinks a picture toward the growth budget and refuses one that still does not fit', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/workspaces/ws_bio?file=bio-office-pptx');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  // About 16 KB of room past the slack: under the plan cap, so the budget is
  // the cap the photo is shrunk toward, and no JPEG of it gets that small.
  await page.evaluate(() =>
    sessionStorage.setItem(
      'capy.mock.growthBudgetBytes.bio-office-pptx',
      '20000'
    )
  );
  await page.getByRole('button', { name: m.material_mode() }).click();
  await expect(officeEditMenu(page, 'pptx')).toBeVisible({ timeout: 30_000 });
  const before = media(await download(page, 'pptx'));
  const buffer = Buffer.from(await makeImage(page, 'photo'), 'base64');
  await insert(page, 'pptx', {
    buffer,
    mimeType: 'image/jpeg',
    name: 'photo.jpg',
  });
  await expect(page.getByText(m.files_office_image_budget())).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText(m.error_file_body())).toHaveCount(0);
  expect(media(await download(page, 'pptx')).size).toBe(before.size);
});
