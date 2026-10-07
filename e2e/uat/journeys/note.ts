/* biome-ignore-all lint/suspicious/noMisplacedAssertion: These steps execute only inside the UAT tests. */
// Steps of the Plate note journey (note.spec.ts): live collaboration, note
// and quiz images, embedded quiz and flashcard blocks, the Markdown export and
// the read view with an interactive block. See openwiki/frontend/plate-editor.md
// and the editor assets in openwiki/backend-storage-quota.md.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
import type { Locator, Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { m } from '../../i18n';
import {
  api,
  noProviderCalls,
  object,
  sha256,
  string,
  workspace,
} from './files';
import { type Actor, expect, type UatRun } from './runtime';

/** The server's cap on images uploaded through a quiz or flashcard set. */
export const QUIZ_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** UAT's VITE_EMBED_ORIGIN, the interactive block frame (deployment-runbook.md). */
const EMBED_ORIGIN = 'https://uat.capy-embed.pages.dev';
/** The test snippet's height; the frame starts at 240 px until it reports it. */
const EMBED_HEIGHT = 437;

/**
 * An RGB PNG of random 2x2 pixel blocks: incompressible, so a 2400x1600 one is
 * about 5.8 MB, and the browser's 2000 px WebP re-encode still lands near,
 * but under, 2 MB (about 2.07 MB at quality 0.9 in Chromium).
 */
export function noisePng(width: number, height: number) {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y += 2) {
    const pixels = randomBytes(Math.ceil(width / 2) * 3);
    for (const line of [y, y + 1].filter((value) => value < height))
      for (let x = 0; x < width; x++)
        pixels.copy(
          raw,
          line * row + 1 + x * 3,
          (x >> 1) * 3,
          (x >> 1) * 3 + 3
        );
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export type AssetRow = {
  id: string;
  material_id: string;
  user_id: string;
  created_by: string;
  object_path: string;
  content_type: string;
  size_bytes: string;
  status: string;
  aged: boolean;
  /** In the hidden trash: a save stopped using it; purged after a day. */
  trashed: boolean;
};

/** The material's editor asset rows; `aged` once completed over 60 s ago. */
export async function materialAssets(run: UatRun, materialId: string) {
  return run.query<AssetRow>(
    `SELECT id,material_id,user_id,created_by,object_path,content_type,size_bytes,status,
    completed_at < now() - interval '60 seconds' AS aged, trashed_at IS NOT NULL AS trashed
    FROM editor_assets WHERE material_id=%s ORDER BY created_at`,
    [materialId]
  );
}

export async function materialRow(run: UatRun, materialId: string) {
  const rows = await run.query<{
    kind: string;
    content: unknown;
    size_bytes: string;
    created_by: string | null;
    owner_user_id: string;
    workspace_id: string | null;
    parent_material_id: string | null;
    trashed_at: string | null;
  }>(
    `SELECT kind,content,size_bytes,created_by,owner_user_id,workspace_id,parent_material_id,trashed_at
    FROM materials WHERE id=%s`,
    [materialId]
  );
  assert.equal(rows.length, 1, `missing material ${materialId}`);
  return rows[0];
}

/** The projected content as JSON text. The projection is written only after
 * the collaboration service durably stored the Yjs state it came from. */
export const contentText = async (run: UatRun, materialId: string) =>
  JSON.stringify((await materialRow(run, materialId)).content);

type TopNode = {
  type: string;
  id: string;
  materialId?: string;
  html?: string;
  title?: string;
};

/** The note's top-level nodes of `type`, in document order. */
async function topNodes(run: UatRun, noteId: string, type: string) {
  const { value } = object((await materialRow(run, noteId)).content) as {
    value: TopNode[];
  };
  return value.filter((node) => node.type === type);
}

/** The note's quiz and flashcard blocks, in document order. */
export const refBlocks = (run: UatRun, noteId: string) =>
  topNodes(run, noteId, 'material_ref');

/** The owner's storage charge. */
export const charge = async (run: UatRun) =>
  Number(object(await api(run.owner, '/api/billing')).storageUsedBytes);

export async function blobRefs(run: UatRun, path: string) {
  const rows = await run.query<{ ref_count: number }>(
    'SELECT ref_count FROM blobs WHERE object_path=%s',
    [path]
  );
  return rows.length ? Number(rows[0].ref_count) : 0;
}

/** Waits until every listed asset completed over a minute ago, so the next
 * save that drops it deletes it (pruneMaterialAssetsTx). */
export async function aged(run: UatRun, materialId: string, ids: string[]) {
  await run.poll(
    `editor assets of ${materialId} older than a minute`,
    () => materialAssets(run, materialId),
    (rows) => ids.every((id) => rows.some((row) => row.id === id && row.aged)),
    150_000
  );
}

/**
 * A workspace with "Auto process edits" off: workspace notes are otherwise
 * indexed (embedded) once idle, and this journey makes no provider call.
 */
export async function notesWorkspace(run: UatRun, label: string) {
  const workspaceId = await workspace(run, label);
  await api(run.owner, `/api/workspaces/${workspaceId}`, 'PATCH', {
    autoProcess: false,
  });
  const [row] = await run.query(
    'SELECT auto_process FROM workspaces WHERE id=%s',
    [workspaceId]
  );
  assert.equal(row?.auto_process, false);
  return workspaceId;
}

/** A note created through the API with one paragraph, `body`. */
export async function apiNote(run: UatRun, workspaceId: string, body: string) {
  const created = object(
    await api(
      run.owner,
      `/api/workspaces/${workspaceId}/materials`,
      'POST',
      {
        content: {
          schemaVersion: 1,
          value: [{ children: [{ text: body }], id: 'body', type: 'p' }],
        },
        kind: 'note',
        title: body,
      },
      201
    )
  );
  return string(created.id);
}

/** Files → Add file → New file → Note → Create, as the owner. */
export async function createNote(run: UatRun, workspaceId: string) {
  const page = run.owner.page;
  await page.goto(`${run.env.appUrl}/workspaces/${workspaceId}`);
  await page
    .getByRole('button', { exact: true, name: m.workspace_tab_files() })
    .click();
  await page
    .locator('[data-workspace-add-menu]')
    .getByRole('button', { exact: true, name: m.action_add_file() })
    .click();
  await page.getByRole('menuitem', { name: m.action_new_file() }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('button', { exact: true, name: m.create_kind_note() })
    .click();
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/workspaces/${workspaceId}/materials` &&
      response.request().method() === 'POST'
  );
  // The dialog's Create tab shares the name; the submit button comes last.
  await dialog
    .getByRole('button', { exact: true, name: m.action_create() })
    .last()
    .click();
  const response = await created;
  assert.equal(response.status(), 201, await response.text());
  const noteId = string(object(await response.json()).id);
  const row = await materialRow(run, noteId);
  assert.equal(row.kind, 'note');
  assert.equal(row.workspace_id, workspaceId);
  assert.equal(row.created_by, run.owner.id);
  assert.equal(row.owner_user_id, run.owner.id);
  return noteId;
}

/** Opens the note in Edit; resolves once its editor is mounted (after the
 * collaboration handshake). */
export async function openNote(
  run: UatRun,
  actor: Actor,
  workspaceId: string,
  noteId: string
) {
  await actor.page.goto(
    `${run.env.appUrl}/workspaces/${workspaceId}?material=${noteId}&mode=edit`
  );
  const editor = actor.page.locator('[contenteditable="true"]').first();
  await expect(editor).toBeVisible({ timeout: 60_000 });
  return editor;
}

/** Leaves the caret on a new empty line under the paragraph `text`. */
export async function lineAfter(page: Page, editor: Locator, text: string) {
  const line = editor.getByText(text, { exact: true });
  await expect(line).toBeVisible({ timeout: 60_000 });
  // Clicking the text's last character puts Slate's caret at its end.
  const box = await line.boundingBox();
  assert(box);
  await line.click({ position: { x: box.width - 1, y: box.height / 2 } });
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
}

/** Opens a note in Edit and leaves the caret on a new empty line under `body`. */
export async function emptyLine(
  run: UatRun,
  actor: Actor,
  workspaceId: string,
  noteId: string,
  body: string
) {
  const editor = await openNote(run, actor, workspaceId, noteId);
  await lineAfter(actor.page, editor, body);
  return editor;
}

/**
 * Note image through the slash command's file picker (the editor, under the
 * line `after`): one ready row named by the note and charged to the owner,
 * the stored bytes are the picked ones and the image renders.
 */
export async function insertNoteImage(
  run: UatRun,
  actor: Actor,
  workspaceId: string,
  noteId: string,
  after: string,
  png: Buffer,
  name: string
) {
  const { page } = actor;
  const editor = await emptyLine(run, actor, workspaceId, noteId, after);
  await page.keyboard.type('/');
  await page
    .getByRole('option', { exact: true, name: m.editor_image() })
    .click();
  const uploaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.startsWith(
        `/api/materials/${noteId}/editor-assets/uploads/`
      ) && new URL(response.url()).pathname.endsWith('/complete')
  );
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    editor.getByRole('button', { name: m.editor_add_image() }).click(),
  ]);
  await chooser.setFiles({ buffer: png, mimeType: 'image/png', name });
  const completed = await uploaded;
  assert.equal(completed.status(), 201);
  const assetId = string(object(await completed.json()).assetId);
  const image = editor.locator(`img[alt="${name}"]`);
  await expect(image).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() =>
      image.evaluate((element) => (element as HTMLImageElement).naturalWidth)
    )
    .toBeGreaterThan(0);
  await run.poll(
    'the note projects the image',
    () => contentText(run, noteId),
    (text) => text.includes(assetId)
  );
  const [asset] = (await materialAssets(run, noteId)).filter(
    (row) => row.id === assetId
  );
  assert.equal(asset.status, 'ready');
  assert.equal(asset.material_id, noteId);
  assert.equal(asset.created_by, actor.id);
  assert.equal(asset.user_id, run.owner.id);
  assert.equal(Number(asset.size_bytes), png.length);
  await run.record('blob', asset.object_path, { assetId, noteId });
  assert.equal((await run.blob(asset.object_path)).sha256, sha256(png));
  return asset;
}

/**
 * Deletes the note image (over a minute old): the save trashes its row, which
 * keeps its object reference and its charge for a day. Undo brings the node
 * back and the collaboration service's children pass restores the same asset,
 * which renders again and survives a reload.
 */
export async function deleteAndUndoNoteImage(
  run: UatRun,
  actor: Actor,
  noteId: string,
  asset: AssetRow,
  name: string
) {
  const { page } = actor;
  const image = page
    .locator('[contenteditable="true"]')
    .first()
    .locator(`img[alt="${name}"]`);
  await aged(run, noteId, [asset.id]);
  const before = await charge(run);
  const sizeBefore = Number((await materialRow(run, noteId)).size_bytes);
  const refs = await blobRefs(run, asset.object_path);
  await image.click({ button: 'right' });
  await page
    .locator('[data-slot="context-menu-content"]')
    .getByRole('menuitem', { name: m.action_delete() })
    .click();
  await expect(image).toHaveCount(0);
  await run.poll(
    'the save trashes the note image',
    async () => ({
      assets: await materialAssets(run, noteId),
      text: await contentText(run, noteId),
    }),
    ({ assets, text }) =>
      !text.includes(asset.id) &&
      assets.some((row) => row.id === asset.id && row.trashed),
    120_000
  );
  // Still charged and still holding its object until the purge.
  assert.equal(await blobRefs(run, asset.object_path), refs);
  assert.equal(
    (await charge(run)) - before,
    Number((await materialRow(run, noteId)).size_bytes) - sizeBefore
  );
  await page.keyboard.press('ControlOrMeta+z');
  await run.poll(
    'undo restores the same image',
    async () => ({
      assets: await materialAssets(run, noteId),
      text: await contentText(run, noteId),
    }),
    ({ assets, text }) =>
      text.includes(asset.id) &&
      assets.some((row) => row.id === asset.id && !row.trashed),
    120_000
  );
  await expect(image).toBeVisible({ timeout: 60_000 });
  await page.reload();
  await expect(image).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() =>
      image.evaluate((element) => (element as HTMLImageElement).naturalWidth)
    )
    .toBeGreaterThan(0);
}

/** An interactive block snippet: a fixed-height box its own script marks. */
function embedMarkdown(marker: string) {
  return [
    '```html-embed',
    `title: Tide chart ${marker}`,
    'html: |',
    '  <style>html,body{margin:0}</style>',
    `  <div id="tide" style="height:${EMBED_HEIGHT}px">Tide ${marker}</div>`,
    "  <script>document.getElementById('tide').dataset.ran = 'yes';</script>",
    '```',
    '',
  ].join('\n');
}

/**
 * The editor has no insert command for an interactive block; the toolbar's
 * Import document → Import Markdown brings in an `html-embed` fence (as the
 * agent writes it) under the line `after`. Returns the projected block.
 */
export async function importHtmlEmbed(
  page: Page,
  editor: Locator,
  run: UatRun,
  noteId: string,
  after: string,
  marker: string
) {
  await lineAfter(page, editor, after);
  await page
    .getByRole('button', { exact: true, name: m.editor_import() })
    .click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page
      .getByRole('button', { exact: true, name: m.editor_import_md() })
      .click(),
  ]);
  await chooser.setFiles({
    buffer: Buffer.from(embedMarkdown(marker)),
    mimeType: 'text/markdown',
    name: 'tide.md',
  });
  const [block] = await run.poll(
    'the note projects the interactive block',
    () => topNodes(run, noteId, 'html_embed'),
    (blocks) => blocks.length === 1 && Boolean(blocks[0].html?.includes(marker))
  );
  return { id: block.id, marker, title: string(block.title) };
}

/**
 * The read view (`mode=view`, the only mode a viewer has): the lines, the
 * image loaded from storage, and the interactive block running in a frame on
 * the UAT embed origin, whose height comes back from the snippet.
 */
export async function readView(
  run: UatRun,
  actor: Actor,
  workspaceId: string,
  noteId: string,
  lines: string[],
  imageName: string,
  embed: { title: string; marker: string }
) {
  const { page } = actor;
  await page.goto(
    `${run.env.appUrl}/workspaces/${workspaceId}?material=${noteId}&mode=view`
  );
  for (const line of lines)
    await expect(page.getByText(line, { exact: true })).toBeVisible({
      timeout: 60_000,
    });
  const image = page.locator(`img[alt="${imageName}"]`);
  await expect(image).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() =>
      image.evaluate((element) => (element as HTMLImageElement).naturalWidth)
    )
    .toBeGreaterThan(0);
  // Frames mount within a screen of the visible area.
  await page.getByText(embed.title).scrollIntoViewIfNeeded();
  const frame = page.locator(`iframe[title="${embed.title}"]`);
  await expect(frame).toHaveAttribute('src', `${EMBED_ORIGIN}/`, {
    timeout: 60_000,
  });
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  const box = frame.contentFrame().locator('#tide');
  await expect(box).toHaveText(`Tide ${embed.marker}`, { timeout: 60_000 });
  await expect(box).toHaveAttribute('data-ran', 'yes');
  await expect
    .poll(() =>
      frame.evaluate((element) => element.getBoundingClientRect().height)
    )
    .toBe(EMBED_HEIGHT);
}

/** Toolbar Export document → Export Markdown (.md); the unzipped download. */
export async function exportMarkdown(page: Page) {
  await page
    .getByRole('button', { exact: true, name: m.editor_export() })
    .click();
  const downloaded = page.waitForEvent('download');
  await page
    .getByRole('button', { exact: true, name: m.editor_export_md() })
    .click();
  const download = await downloaded;
  assert.equal(download.suggestedFilename(), 'document.zip');
  return unzipSync(await readFile(await download.path()));
}

/**
 * Whether two images decode to the same pixels in the browser. Exports
 * redraw every raster image onto a white canvas and write PNG, so an
 * exported opaque image keeps its pixels but not its bytes.
 */
export async function samePixels(page: Page, a: Uint8Array, b: Uint8Array) {
  return page.evaluate(
    async ([first, second]) => {
      const decode = async (base64: string) => {
        const bytes = Uint8Array.from(atob(base64), (char) =>
          char.charCodeAt(0)
        );
        const bitmap = await createImageBitmap(new Blob([bytes]));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('no 2d context');
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const [x, y] = await Promise.all([decode(first), decode(second)]);
      return (
        x.width === y.width &&
        x.height === y.height &&
        x.data.every((value, index) => value === y.data[index])
      );
    },
    [Buffer.from(a).toString('base64'), Buffer.from(b).toString('base64')]
  );
}

/**
 * Inserts a quiz or flashcard set through the slash command under `body`:
 * the row is created embedded in the note and its edit page opens. Returns
 * the row's id.
 */
export async function insertEmbedded(
  run: UatRun,
  workspaceId: string,
  noteId: string,
  body: string,
  kind: 'quiz' | 'flashcards'
) {
  const page = run.owner.page;
  await emptyLine(run, run.owner, workspaceId, noteId, body);
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/materials/${noteId}/embedded` &&
      response.request().method() === 'POST'
  );
  await page.keyboard.type(`/${kind}`);
  await page
    .getByRole('option', {
      exact: true,
      name: kind === 'quiz' ? m.editor_quiz() : m.editor_flashcards(),
    })
    .click();
  const response = await created;
  assert.equal(response.status(), 201, await response.text());
  const id = string(object(await response.json()).id);
  await page.waitForURL(
    `**/${kind === 'quiz' ? 'quizzes' : 'flashcards'}/${id}/edit**`
  );
  const row = await materialRow(run, id);
  assert.equal(row.kind, kind);
  assert.equal(row.parent_material_id, noteId);
  assert.equal(row.workspace_id, workspaceId);
  assert.equal(row.trashed_at, null);
  return id;
}

/**
 * Removes the quiz's block (the quiz over a minute old, so the save trashes
 * it): the row is trashed yet never listed in the owner's trash. Undo brings
 * the block back and the collaboration service's children pass restores the
 * row under the same id.
 */
export async function removeAndUndoQuizBlock(
  run: UatRun,
  workspaceId: string,
  noteId: string,
  quizId: string
) {
  await run.poll(
    `${quizId} older than a minute`,
    () =>
      run.query<{ aged: boolean }>(
        "SELECT created_at < now() - interval '60 seconds' AS aged FROM materials WHERE id=%s",
        [quizId]
      ),
    (rows) => rows[0]?.aged === true,
    120_000
  );
  const page = run.owner.page;
  const editor = await openNote(run, run.owner, workspaceId, noteId);
  const blocks = await refBlocks(run, noteId);
  const cards = editor.locator('.slate-material_ref');
  await expect(cards).toHaveCount(blocks.length, { timeout: 60_000 });
  const card = cards.nth(
    blocks.findIndex((block) => block.materialId === quizId)
  );
  await card.click({ button: 'right', position: { x: 12, y: 12 } });
  await page
    .locator('[data-slot="context-menu-content"]')
    .getByRole('menuitem', { name: m.action_delete() })
    .click();
  await expect(cards).toHaveCount(blocks.length - 1);
  await run.poll(
    'the removed quiz is trashed',
    () => materialRow(run, quizId),
    (row) => row.trashed_at !== null,
    120_000
  );
  const trash = object(
    await api(run.owner, `/api/trash?workspaceId=${workspaceId}`)
  );
  assert(
    !(trash.items as { id: string }[]).some((item) => item.id === quizId),
    'an embedded quiz is listed in the trash'
  );
  await page.keyboard.press('ControlOrMeta+z');
  await expect(cards).toHaveCount(blocks.length);
  await run.poll(
    'the restored block restores the quiz',
    async () => ({
      blocks: await refBlocks(run, noteId),
      row: await materialRow(run, quizId),
    }),
    ({ blocks, row }) =>
      row.trashed_at === null &&
      blocks.some((block) => block.materialId === quizId),
    120_000
  );
}

/** A quiz embedded in the note through the API, with one true/false question. */
export async function apiEmbeddedQuiz(run: UatRun, noteId: string) {
  const created = object(
    await api(
      run.owner,
      `/api/materials/${noteId}/embedded`,
      'POST',
      {
        kind: 'quiz',
        questions: [
          {
            id: 'q_photo',
            labels: 'letters',
            layout: 'paper',
            parts: [
              {
                answer: { correct: true, type: 'boolean' },
                blocks: [
                  { text: 'The photo shows a salt marsh.', type: 'text' },
                ],
                id: 'q_photo:part:1',
                marks: 1,
                solution: [],
              },
            ],
            stem: [],
          },
        ],
      },
      201
    )
  );
  return string(created.id);
}

/**
 * Pastes quiz blocks the way Slate copies them (its fragment, also inside the
 * HTML), through the paste events a real clipboard fires. The collaboration
 * service makes them the note's own; callers poll the projection for that. A
 * synthetic clipboard keeps the custom fragment type that the system clipboard
 * of a headless browser may drop.
 */
async function pasteQuizBlock(
  editor: Locator,
  block: { id: string; materialId: string }
) {
  await editor.evaluate(
    (element, node) => {
      const fragment = btoa(encodeURIComponent(JSON.stringify([node])));
      const transfer = new DataTransfer();
      transfer.setData('application/x-slate-fragment', fragment);
      transfer.setData(
        'text/html',
        `<div data-slate-fragment="${fragment}">Quiz</div>`
      );
      transfer.setData('text/plain', 'Quiz');
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
    },
    {
      children: [{ text: '' }],
      id: block.id,
      materialId: block.materialId,
      refKind: 'quiz',
      type: 'material_ref',
    }
  );
}

/** Waits for the quiz editor's Save: the picked images upload, then the content. */
async function saveQuiz(page: Page, quizId: string) {
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/quizzes/${quizId}/content` &&
      response.request().method() === 'PATCH'
  );
  await pageSave(page);
  assert.equal((await saved).status(), 200);
}

/**
 * The edit page's Save, confirmed when the page asks "Save your changes?"
 * (the confirmation is in flight on 2026-10-06; without it Save saves at once).
 */
async function pageSave(page: Page) {
  await page
    .getByRole('button', { exact: true, name: m.action_save() })
    .click();
  const confirm = page
    .getByRole('dialog', { name: m.edit_save_confirm_title() })
    .getByRole('button', { exact: true, name: m.action_save() });
  if (
    await confirm.waitFor({ timeout: 5000 }).then(
      () => true,
      () => false
    )
  )
    await confirm.click();
}

/**
 * Quiz editor: a picked image over 2 MB is shrunk to WebP in the browser,
 * nothing reserves or uploads until Save, Save uploads it and the content
 * names the new asset; the owner's charge grows by the asset plus the
 * content. Returns the asset row.
 */
export async function quizImageOnSave(run: UatRun, quizId: string) {
  const png = noisePng(2400, 1600);
  assert(png.length > QUIZ_IMAGE_MAX_BYTES);
  const before = await charge(run);
  const quizSize = Number((await materialRow(run, quizId)).size_bytes);
  const page = run.owner.page;
  const uploads: string[] = [];
  const watch = (request: { url(): string; method(): string }) => {
    const url = new URL(request.url());
    if (
      url.pathname.includes('/editor-assets/') ||
      (request.method() === 'PUT' && url.host !== new URL(run.env.apiUrl).host)
    )
      uploads.push(`${request.method()} ${url.pathname}`);
  };
  page.on('request', watch);
  try {
    await page.goto(`${run.env.appUrl}/quizzes/${quizId}/edit`);
    await page
      .getByRole('button', { exact: true, name: m.action_edit() })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByRole('button', { name: m.question_ui_add_block_or_part() })
      .click();
    await page
      .getByRole('button', { exact: true, name: m.question_ui_image() })
      .click();
    await dialog.locator('input[type="file"]').setInputFiles({
      buffer: png,
      mimeType: 'image/png',
      name: 'field-photo.png',
    });
    // The shrunk copy previews from a browser object URL.
    await expect(dialog.locator('img[src^="blob:"]').first()).toBeVisible({
      timeout: 60_000,
    });
    await dialog
      .getByRole('textbox', { name: m.question_ui_description() })
      .fill('Field photo');
    // The block's Save, then, back in the question, the question's Save.
    await dialog
      .getByRole('button', { exact: true, name: m.question_ui_save() })
      .click();
    await expect(dialog.locator('input[type="file"]')).toHaveCount(0);
    await dialog
      .getByRole('button', { exact: true, name: m.question_ui_save() })
      .click();
    await expect(dialog).toBeHidden();
    // Picked and placed, yet nothing reserved or uploaded.
    assert.deepEqual(uploads, []);
    assert.deepEqual(await materialAssets(run, quizId), []);
    const sessions = await run.query(
      'SELECT id FROM upload_sessions WHERE material_id=%s',
      [quizId]
    );
    assert.deepEqual(sessions, []);
    const completed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.startsWith(
          `/api/materials/${quizId}/editor-assets/uploads/`
        ) && new URL(response.url()).pathname.endsWith('/complete')
    );
    await saveQuiz(page, quizId);
    assert.equal((await completed).status(), 201);
  } finally {
    page.off('request', watch);
  }
  const [asset, ...rest] = await materialAssets(run, quizId);
  assert.deepEqual(rest, []);
  assert.equal(asset.status, 'ready');
  assert.equal(asset.user_id, run.owner.id);
  assert(Number(asset.size_bytes) <= QUIZ_IMAGE_MAX_BYTES);
  assert(Number(asset.size_bytes) < png.length);
  assert((await contentText(run, quizId)).includes(asset.id));
  await run.record('blob', asset.object_path, { assetId: asset.id, quizId });
  const stored = await run.blob(asset.object_path);
  assert.equal(stored.size, Number(asset.size_bytes));
  // Chromium re-encodes as WebP: RIFF....WEBP.
  const head = Buffer.from(stored.bodyBase64, 'base64').subarray(0, 12);
  assert.equal(head.toString('latin1', 8, 12), 'WEBP');
  assert.equal(
    (await charge(run)) - before,
    Number(asset.size_bytes) +
      Number((await materialRow(run, quizId)).size_bytes) -
      quizSize
  );
  return asset;
}

/**
 * Pasting the quiz block into its own note A keeps its quiz; into note B
 * makes B's own copy (new id, its own asset row over the same stored
 * object), and copying that block within B makes a second, different quiz.
 * Returns B's two quiz ids.
 */
export async function pastedQuizCopies(
  run: UatRun,
  workspaceId: string,
  notes: { a: string; aBody: string; b: string; bBody: string },
  quiz: string,
  quizImage: AssetRow
) {
  const page = run.owner.page;
  const editorA = await emptyLine(
    run,
    run.owner,
    workspaceId,
    notes.a,
    notes.aBody
  );
  await pasteQuizBlock(editorA, {
    id: 'block_quiz_photo',
    materialId: quiz,
  });
  await run.poll(
    'note A projects its own quiz block',
    () => refBlocks(run, notes.a),
    (blocks) => blocks.length === 1 && blocks[0].materialId === quiz
  );
  const editorB = await emptyLine(
    run,
    run.owner,
    workspaceId,
    notes.b,
    notes.bBody
  );
  await pasteQuizBlock(editorB, {
    id: 'block_quiz_photo',
    materialId: quiz,
  });
  const [pasted] = await run.poll(
    'note B projects its own copy',
    () => refBlocks(run, notes.b),
    (blocks) =>
      blocks.length === 1 &&
      typeof blocks[0].materialId === 'string' &&
      blocks[0].materialId !== quiz
  );
  // Copy and paste of B's own block within B: the second block gets a second quiz.
  await editorB
    .getByText(notes.bBody, { exact: true })
    .click({ position: { x: 2, y: 2 } });
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await pasteQuizBlock(editorB, {
    id: pasted.id,
    materialId: string(pasted.materialId),
  });
  await expect(editorB.locator('.slate-material_ref')).toHaveCount(2);
  const blocks = await run.poll(
    'note B projects two quizzes',
    () => refBlocks(run, notes.b),
    (rows) =>
      rows.length === 2 && new Set(rows.map((row) => row.materialId)).size === 2
  );
  const copies = blocks.map((block) => string(block.materialId));
  assert(copies.includes(string(pasted.materialId)));
  assert(!copies.includes(quiz));
  for (const copy of copies) {
    const row = await materialRow(run, copy);
    assert.equal(row.parent_material_id, notes.b);
    assert.equal(row.trashed_at, null);
    const [own, ...more] = await materialAssets(run, copy);
    assert.deepEqual(more, []);
    assert.equal(own.status, 'ready');
    assert.notEqual(own.id, quizImage.id);
    assert.equal(own.object_path, quizImage.object_path);
    assert.equal(own.size_bytes, quizImage.size_bytes);
    const text = await contentText(run, copy);
    assert(text.includes(own.id) && !text.includes(quizImage.id));
  }
  assert.notEqual(
    (await materialAssets(run, copies[0]))[0].id,
    (await materialAssets(run, copies[1]))[0].id
  );
  const embeddedInA = await run.query(
    'SELECT id FROM materials WHERE parent_material_id=%s AND trashed_at IS NULL',
    [notes.a]
  );
  assert.deepEqual(
    embeddedInA.map((row) => row.id),
    [quiz]
  );
  return copies;
}

/** Quiz editor: select the image block, delete it, save the question and quiz. */
async function removeQuizImage(run: UatRun, quizId: string) {
  const page = run.owner.page;
  await page.goto(`${run.env.appUrl}/quizzes/${quizId}/edit`);
  await page
    .getByRole('button', { exact: true, name: m.action_edit() })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('button', {
      name: m.question_ui_select_block({ type: m.question_ui_image() }),
    })
    .click();
  await dialog
    .getByRole('toolbar', { name: m.question_ui_block_actions() })
    .getByRole('button', { exact: true, name: m.question_ui_delete() })
    .click();
  await expect(
    dialog.getByRole('button', {
      name: m.question_ui_select_block({ type: m.question_ui_image() }),
    })
  ).toHaveCount(0);
  await dialog
    .getByRole('button', { exact: true, name: m.question_ui_save() })
    .click();
  await expect(dialog).toBeHidden();
  await saveQuiz(page, quizId);
}

/**
 * Removing the original quiz's image (over a minute old) and saving trashes
 * its row (charged and holding the shared object until the purge); the copies
 * keep theirs.
 */
export async function quizImageRemoved(
  run: UatRun,
  quiz: string,
  quizImage: AssetRow,
  copies: string[]
) {
  await aged(run, quiz, [quizImage.id]);
  const refs = await blobRefs(run, quizImage.object_path);
  const before = await charge(run);
  const sizeBefore = Number((await materialRow(run, quiz)).size_bytes);
  await removeQuizImage(run, quiz);
  assert.deepEqual(
    (await materialAssets(run, quiz)).map((row) => [row.id, row.trashed]),
    [[quizImage.id, true]]
  );
  assert(!(await contentText(run, quiz)).includes(quizImage.id));
  assert.equal(
    (await charge(run)) - before,
    Number((await materialRow(run, quiz)).size_bytes) - sizeBefore
  );
  assert.equal(await blobRefs(run, quizImage.object_path), refs);
  for (const copy of copies)
    assert.equal((await materialAssets(run, copy)).length, 1);
  assert.equal(
    (await run.blob(quizImage.object_path)).size,
    Number(quizImage.size_bytes)
  );
}

/**
 * Flashcard front images, the quiz image rule for cards: one front image per
 * card, shrunk under 2 MB in the browser and uploaded only on Save; removing
 * it and saving trashes the row. Labels from the flashcards session
 * (2026-10-06): "New card" with an "Add card" submit, "Edit card N/M" with
 * "Save", the image's hidden file input behind "Add image", and "Replace" /
 * "Remove" once set. A fixme until card images are deployed to UAT.
 */
export async function cardImages(run: UatRun) {
  const workspaceId = await workspace(run, 'card-images');
  const created = object(
    await api(run.owner, '/api/flashcards', 'POST', { workspaceId }, 201)
  );
  const setId = string(created.id);
  const page = run.owner.page;
  const uploads: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.includes('/editor-assets/'))
      uploads.push(request.url());
  });
  await page.goto(`${run.env.appUrl}/flashcards/${setId}/edit`);
  // The edit page is a grid of front tiles plus a dashed "Add card" tile,
  // which opens "New card"; a front tile opens "Edit card N/M". Dialogs only
  // stage changes until the page's Save.
  await page
    .getByRole('button', { exact: true, name: m.flashcards_add_card() })
    .click();
  let dialog = page.getByRole('dialog', { name: m.flashcards_new_card() });
  await dialog
    .getByRole('textbox', { name: m.editor_card_front() })
    .fill('Salt marsh');
  await dialog
    .getByRole('textbox', { name: m.editor_card_back() })
    .fill('Coastal grassland flooded by tides');
  await dialog.locator('input[type="file"]').setInputFiles({
    buffer: noisePng(2400, 1600),
    mimeType: 'image/png',
    name: 'marsh.png',
  });
  await expect(dialog.locator('img[src^="blob:"]').first()).toBeVisible({
    timeout: 60_000,
  });
  await dialog
    .getByRole('button', { exact: true, name: m.flashcards_add_card() })
    .click();
  assert.deepEqual(uploads, []);
  await pageSave(page);
  const [asset] = await run.poll(
    'card image saved',
    () => materialAssets(run, setId),
    (rows) => rows.length === 1 && rows[0].status === 'ready'
  );
  assert(Number(asset.size_bytes) <= QUIZ_IMAGE_MAX_BYTES);
  assert((await contentText(run, setId)).includes(asset.id));
  await run.record('blob', asset.object_path, { assetId: asset.id, setId });
  await aged(run, setId, [asset.id]);
  await page.getByRole('button', { exact: true, name: 'Salt marsh' }).click();
  dialog = page.getByRole('dialog', { name: m.flashcards_edit_card() });
  await dialog
    .getByRole('button', { exact: true, name: m.action_remove() })
    .click();
  await dialog
    .getByRole('button', { exact: true, name: m.action_save() })
    .click();
  await pageSave(page);
  await run.poll(
    'card image trashed',
    () => materialAssets(run, setId),
    (rows) => rows.length === 1 && rows[0].trashed
  );
  await noProviderCalls(run, workspaceId);
}
