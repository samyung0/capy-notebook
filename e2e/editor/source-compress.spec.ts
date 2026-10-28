import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { showPanelView } from '../helpers/panelView';
import { m } from '../i18n';

// Sources are compressed in the browser before their upload (Epo 2026-10-24):
// an Office file's pictures to the image rules with its EMF and WMF pictures
// removed, an image file to 5 megapixels, through a decoder loaded for one
// the browser cannot read (Q294).

const images = new URL('../fixtures/files/images/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, images));

/** A 4000x3000 gradient photo with light noise, made in the page: as PNG
 * over 10 MB, as JPEG at 2,400 px well under 2 MB. */
function photo(page: Page, type: 'image/png' | 'image/jpeg') {
  return page.evaluate(async (type) => {
    const [width, height] = [4000, 3000];
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d')!;
    const image = context.createImageData(width, height);
    let seed = 2_463_534_242;
    for (let at = 0; at < image.data.length; at += 4) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const noise = ((seed >>> 0) / 4_294_967_296 - 0.5) * 8;
      const x = (at / 4) % width;
      const y = Math.floor(at / 4 / width);
      image.data[at] = (x * 255) / width + noise;
      image.data[at + 1] = (y * 255) / height + noise;
      image.data[at + 2] = 128 + noise;
      image.data[at + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    const blob = await canvas.convertToBlob({ quality: 0.95, type });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x80_00)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x80_00));
    return btoa(binary);
  }, type);
}

/** Picks files in the add-source dialog and uploads them. */
async function upload(
  page: Page,
  files: { buffer: Buffer; mimeType: string; name: string }[]
) {
  await page.goto('/workspaces/ws_bio');
  await showPanelView(page, m.workspace_tab_files());
  await page
    .locator('[data-workspace-add-menu]')
    .getByRole('button', { exact: true, name: m.action_new_file_or_chapter() })
    .click();
  await page
    .getByRole('menuitem', { name: m.action_upload_or_import() })
    .click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: m.source_upload_computer() }).click(),
  ]);
  await chooser.setFiles(files);
  await page
    .getByRole('button', { exact: true, name: m.action_upload() })
    .click();
}

/** The stored file's id and bytes, read back through its link. */
async function stored(page: Page, name: string) {
  const link = page
    .locator('[data-workspace-file-tree]')
    .getByRole('link', { exact: true, name });
  await expect(link).toBeVisible({ timeout: 60_000 });
  const id = new URL(
    (await link.getAttribute('href'))!,
    'http://x'
  ).searchParams.get('file')!;
  const base64 = await page.evaluate(async (id) => {
    const links = await (await fetch(`/api/files/${id}/links`)).json();
    const bytes = new Uint8Array(await (await fetch(links.url)).arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x80_00)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x80_00));
    return btoa(binary);
  }, id);
  return { bytes: Buffer.from(base64, 'base64'), link };
}

/** An image's signature and size as the page decodes it. */
function decoded(page: Page, bytes: Uint8Array) {
  return page.evaluate(async (base64) => {
    const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([data]));
    const hex = [...data.subarray(0, 3)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `${hex} ${bitmap.width}x${bitmap.height}`;
  }, Buffer.from(bytes).toString('base64'));
}

test('a DOCX upload stores its large picture compressed and its WMF equation removed, and still opens', async ({
  page,
}) => {
  test.setTimeout(240_000);
  // exchange-plan.docx, its first picture a 4000x3000 PNG photo, with a WMF
  // equation preview and its OLE object.
  const parts = unzipSync(
    readFileSync(
      new URL(
        '../fixtures/files/rich-content/exchange-plan.docx',
        import.meta.url
      )
    )
  );
  parts['word/media/image1.png'] = Buffer.from(
    await photo(page, 'image/png'),
    'base64'
  );
  parts['word/media/image9.wmf'] = Uint8Array.from([
    0xd7,
    0xcd,
    0xc6,
    0x9a,
    ...new Array(40).fill(0),
  ]);
  parts['word/embeddings/oleObject1.bin'] = Uint8Array.from([1, 2, 3]);
  parts['word/document.xml'] = strToU8(
    strFromU8(parts['word/document.xml']).replace(
      '<w:sectPr',
      '<w:p><w:r><w:object><v:shape id="_x0000_i1025" style="width:50pt;height:20pt"><v:imagedata r:id="rId101" o:title=""/></v:shape>' +
        '<o:OLEObject Type="Embed" ProgID="Equation.3" ShapeID="_x0000_i1025" DrawAspect="Content" ObjectID="_1" r:id="rId102"/></w:object></w:r></w:p><w:sectPr'
    )
  );
  parts['word/_rels/document.xml.rels'] = strToU8(
    strFromU8(parts['word/_rels/document.xml.rels']).replace(
      '</Relationships>',
      '<Relationship Id="rId101" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image9.wmf"/>' +
        '<Relationship Id="rId102" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="embeddings/oleObject1.bin"/></Relationships>'
    )
  );
  const picked = Buffer.from(zipSync(parts));
  expect(picked.length).toBeGreaterThan(10_000_000);

  await upload(page, [
    {
      buffer: picked,
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      name: 'plan.docx',
    },
  ]);
  // The count of removed pictures reaches the toast.
  await expect(
    page.getByText(m.source_pictures_removed({ name: 'plan.docx' }))
  ).toBeVisible({ timeout: 120_000 });
  await expect(
    page.getByText(m.source_pictures_removed_body_one())
  ).toBeVisible();

  const { bytes, link } = await stored(page, 'plan.docx');
  expect(bytes.length).toBeLessThan(picked.length / 4);
  const out = unzipSync(bytes);
  expect(Object.keys(out)).not.toContain('word/media/image1.png');
  expect(Object.keys(out)).not.toContain('word/media/image9.wmf');
  expect(Object.keys(out)).not.toContain('word/embeddings/oleObject1.bin');
  expect(out['word/media/image1.jpeg'].length).toBeLessThanOrEqual(2_097_152);
  expect(await decoded(page, out['word/media/image1.jpeg'])).toBe(
    'ffd8ff 2400x1800'
  );
  expect(strFromU8(out['word/_rels/document.xml.rels'])).toContain(
    'Target="media/image1.jpeg"'
  );

  // It opens in the viewer. From the keyboard: the toast and the mock
  // scenario panel cover the new row at the foot of the tree.
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { exact: true, name: 'plan.docx' })
  ).toBeVisible();
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText(m.error_file_body())).toHaveCount(0);
  // The file's own text, not a blank document: an upload has no saved edits,
  // so the view read carries no state and the base opens as is.
  await expect(
    frame.locator('.layout-run-text').filter({ hasText: '書' }).first()
  ).toBeAttached();
});

test('an image source arrives at 5 megapixels at most, HEIC, TIFF and JPEG 2000 through their decoders and saved as JPEG even when small, an SVG as PNG, and a corrupt HEIC is refused', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const manifest = JSON.parse(fixture('manifest.json').toString()) as {
    source: Record<string, [string, number, number]>;
  };
  const photoJpeg = Buffer.from(await photo(page, 'image/jpeg'), 'base64');
  await upload(page, [
    { buffer: photoJpeg, mimeType: 'image/jpeg', name: 'camera.jpg' },
    // Distinct stems, since each is stored as <stem>.jpg.
    ...[
      'photo.heic',
      'photo.tif',
      'photo.jp2',
      'small.tif',
      'corrupt.heic',
    ].map((name) => ({
      buffer: fixture(name),
      mimeType: 'application/octet-stream',
      name: name.replace(/^(\w+)\.(\w+)$/, '$2-$1.$2'),
    })),
    // Drawn as PNG on the page (Q364): a viewBox-only SVG at 2,400 px on
    // its long side, a sized one at its own size.
    {
      buffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100" fill="#3a7"/></svg>'
      ),
      mimeType: 'image/svg+xml',
      name: 'logo.svg',
    },
    {
      buffer: Buffer.from(
        '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"><circle cx="75" cy="75" r="60" fill="#a37"/></svg>'
      ),
      mimeType: 'image/svg+xml',
      name: 'badge.svg',
    },
  ]);
  // The 12 MP photo, as 2,581 x 1,936.
  expect(await decoded(page, (await stored(page, 'camera.jpg')).bytes)).toBe(
    'ffd8ff 2581x1936'
  );
  // small.tif is within 5 megapixels, re-saved as JPEG all the same (Q344).
  for (const name of ['photo.heic', 'photo.tif', 'photo.jp2', 'small.tif']) {
    const [, width, height] = manifest.source[name];
    const renamed = name.replace(/^(\w+)\.(\w+)$/, '$2-$1.jpg');
    expect(await decoded(page, (await stored(page, renamed)).bytes)).toBe(
      `ffd8ff ${width}x${height}`
    );
  }
  // The server receives PNGs, never an SVG.
  expect(await decoded(page, (await stored(page, 'logo.png')).bytes)).toBe(
    '89504e 2400x1200'
  );
  expect(await decoded(page, (await stored(page, 'badge.png')).bytes)).toBe(
    '89504e 300x150'
  );
  // Refused before anything was sent, with its reason.
  await expect(
    page.getByText(m.source_image_unreadable()).first()
  ).toBeVisible();
  await expect(
    page
      .locator('[data-workspace-file-tree]')
      .getByRole('link', { name: 'heic-corrupt' })
  ).toHaveCount(0);
});
