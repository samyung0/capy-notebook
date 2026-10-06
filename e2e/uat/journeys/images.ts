/* biome-ignore-all lint/suspicious/noMisplacedAssertion: These steps execute only inside the UAT tests. */
// Note and quiz images (openwiki/backend-storage-quota.md, editor assets;
// openwiki/frontend/plate-editor.md, note assets and embedded quizzes). Each
// case is one exported function taking the run, so a spec only names it; it
// uses nothing but the shared actor, workspace and verifier helpers and can
// move to a Plate journey of its own unchanged.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import type { Locator, Page } from '@playwright/test';
import {
  api,
  invite,
  noProviderCalls,
  object,
  sha256,
  string,
  workspace,
} from './files';
import { type Actor, expect, type UatRun } from './runtime';

/** The server's cap on images uploaded through a quiz or flashcard set. */
const QUIZ_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

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

type AssetRow = {
  id: string;
  material_id: string;
  user_id: string;
  created_by: string;
  object_path: string;
  content_type: string;
  size_bytes: string;
  status: string;
  aged: boolean;
};

/** The material's editor asset rows; `aged` once completed over 60 s ago. */
export async function materialAssets(run: UatRun, materialId: string) {
  return run.query<AssetRow>(
    `SELECT id,material_id,user_id,created_by,object_path,content_type,size_bytes,status,
    completed_at < now() - interval '60 seconds' AS aged
    FROM editor_assets WHERE material_id=%s ORDER BY created_at`,
    [materialId]
  );
}

async function materialRow(run: UatRun, materialId: string) {
  const rows = await run.query<{
    content: unknown;
    size_bytes: string;
    parent_material_id: string | null;
    trashed_at: string | null;
  }>(
    'SELECT content,size_bytes,parent_material_id,trashed_at FROM materials WHERE id=%s',
    [materialId]
  );
  assert.equal(rows.length, 1, `missing material ${materialId}`);
  return rows[0];
}

const contentText = async (run: UatRun, materialId: string) =>
  JSON.stringify((await materialRow(run, materialId)).content);

/** The quiz ids of a note's top-level quiz blocks, in document order. */
async function quizBlocks(run: UatRun, noteId: string) {
  const { value } = object((await materialRow(run, noteId)).content) as {
    value: Array<{ type: string; id: string; materialId?: string }>;
  };
  return value.filter((node) => node.type === 'material_ref');
}

const charge = async (run: UatRun) =>
  Number(object(await api(run.owner, '/api/billing')).storageUsedBytes);

async function blobRefs(run: UatRun, path: string) {
  const rows = await run.query<{ ref_count: number }>(
    'SELECT ref_count FROM blobs WHERE object_path=%s',
    [path]
  );
  return rows.length ? Number(rows[0].ref_count) : 0;
}

/** Waits until every listed asset completed over a minute ago, so the next
 * save that drops it deletes it (pruneMaterialAssetsTx). */
async function aged(run: UatRun, materialId: string, ids: string[]) {
  await run.poll(
    `editor assets of ${materialId} older than a minute`,
    () => materialAssets(run, materialId),
    (rows) => ids.every((id) => rows.some((row) => row.id === id && row.aged)),
    150_000
  );
}

async function note(run: UatRun, workspaceId: string, body: string) {
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

/** Opens a note in Edit and leaves the caret on a new empty line under `body`. */
async function emptyLine(
  run: UatRun,
  actor: Actor,
  workspaceId: string,
  noteId: string,
  body: string
) {
  const { page } = actor;
  await page.goto(
    `${run.env.appUrl}/workspaces/${workspaceId}?material=${noteId}&mode=edit`
  );
  const editor = page.locator('[contenteditable="true"]').first();
  const text = editor.getByText(body, { exact: true });
  await expect(text).toBeVisible({ timeout: 60_000 });
  // Clicking the text's last character puts Slate's caret at its end.
  const box = await text.boundingBox();
  assert(box);
  await text.click({ position: { x: box.width - 1, y: box.height / 2 } });
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  return editor;
}

/**
 * Pastes quiz blocks the way Slate copies them (its fragment, also inside the
 * HTML), through the paste events a real clipboard fires, and waits for the
 * note to adopt them. A synthetic clipboard keeps the custom fragment type
 * that the system clipboard of a headless browser may drop.
 */
async function pasteQuizBlock(
  page: Page,
  editor: Locator,
  noteId: string,
  block: { id: string; materialId: string }
) {
  const adopted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/materials/${noteId}/embedded/adopt` &&
      response.request().method() === 'POST'
  );
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
  assert.equal((await adopted).status(), 200);
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
  await page.getByRole('button', { exact: true, name: 'Save' }).click();
  const confirm = page
    .getByRole('dialog', { name: 'Save your changes?' })
    .getByRole('button', { exact: true, name: 'Save' });
  if (
    await confirm.waitFor({ timeout: 5000 }).then(
      () => true,
      () => false
    )
  )
    await confirm.click();
}

/**
 * Quiz editor: a picked image over 2 MB is shrunk in the browser, nothing
 * uploads until Save, Save uploads it and the content names the new asset.
 * Returns the asset row.
 */
async function addQuizImage(run: UatRun, quizId: string, png: Buffer) {
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
    await page.getByRole('button', { exact: true, name: 'Edit' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Add block or part' }).click();
    await page.getByRole('button', { exact: true, name: 'Image' }).click();
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
      .getByRole('textbox', { name: 'Description' })
      .fill('Field photo');
    // The block's Save, then, back in the question, the question's Save.
    await dialog.getByRole('button', { exact: true, name: 'Save' }).click();
    await expect(dialog.locator('input[type="file"]')).toHaveCount(0);
    await dialog.getByRole('button', { exact: true, name: 'Save' }).click();
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
  assert(
    await contentText(run, quizId).then((text) => text.includes(asset.id))
  );
  await run.record('blob', asset.object_path, { assetId: asset.id, quizId });
  const stored = await run.blob(asset.object_path);
  assert.equal(stored.size, Number(asset.size_bytes));
  // Chromium re-encodes as WebP: RIFF....WEBP.
  const head = Buffer.from(stored.bodyBase64, 'base64').subarray(0, 12);
  assert.equal(head.toString('latin1', 8, 12), 'WEBP');
  return asset;
}

/** Quiz editor: select the image block, delete it, save the question and quiz. */
async function removeQuizImage(run: UatRun, quizId: string) {
  const page = run.owner.page;
  await page.goto(`${run.env.appUrl}/quizzes/${quizId}/edit`);
  await page.getByRole('button', { exact: true, name: 'Edit' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Select Image block' }).click();
  await dialog
    .getByRole('toolbar', { name: 'Block actions' })
    .getByRole('button', { exact: true, name: 'Delete' })
    .click();
  await expect(
    dialog.getByRole('button', { name: 'Select Image block' })
  ).toHaveCount(0);
  await dialog.getByRole('button', { exact: true, name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await saveQuiz(page, quizId);
}

/**
 * One workspace, an owner and an editor:
 * 1. Quiz editor (owner, on a quiz embedded in note A): a 5.8 MB PNG is shrunk
 *    to WebP under 2 MB in the browser, nothing reserves or uploads until
 *    Save, Save uploads it; the row names the quiz, the content names the
 *    asset and the owner's charge grows by the asset and the content.
 * 2. Pasting the quiz block into note A keeps its quiz; into note B makes B's
 *    own copy (new id, its own asset rows over the same stored object), and
 *    copying that block within B makes a second, different quiz.
 * 3. Removing the image from the original quiz and saving deletes its row and
 *    releases its bytes; the copies keep theirs and the shared object.
 * 4. Note image (editor, note A): inserted, older than a minute, deleted; the
 *    save deletes its row and its object reference. Undo brings it back under
 *    a new asset id, re-uploaded from the bytes this tab kept in IndexedDB,
 *    and it survives a reload.
 */
export async function noteAndQuizImages(run: UatRun) {
  const workspaceId = await workspace(run, 'images');
  const editor = await run.createActor('images-editor');
  await invite(run, workspaceId, editor, 'editor');
  const noteA = await note(run, workspaceId, 'Note A wetland notes');
  const noteB = await note(run, workspaceId, 'Note B estuary notes');
  const quiz = string(
    object(
      await api(
        run.owner,
        `/api/materials/${noteA}/embedded`,
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
    ).id
  );

  // 1. Quiz image, picked over 2 MB.
  const big = noisePng(2400, 1600);
  assert(big.length > QUIZ_IMAGE_MAX_BYTES);
  const beforeImage = await charge(run);
  const quizSize = Number((await materialRow(run, quiz)).size_bytes);
  const quizImage = await addQuizImage(run, quiz, big);
  assert.equal(
    (await charge(run)) - beforeImage,
    Number(quizImage.size_bytes) +
      Number((await materialRow(run, quiz)).size_bytes) -
      quizSize
  );

  // 2. Paste the quiz block into note A (its own quiz stays) and note B.
  const ownerPage = run.owner.page;
  const editorA = await emptyLine(
    run,
    run.owner,
    workspaceId,
    noteA,
    'Note A wetland notes'
  );
  await pasteQuizBlock(ownerPage, editorA, noteA, {
    id: 'block_quiz_photo',
    materialId: quiz,
  });
  await run.poll(
    'note A projects its own quiz block',
    () => quizBlocks(run, noteA),
    (blocks) => blocks.length === 1 && blocks[0].materialId === quiz
  );
  const editorB = await emptyLine(
    run,
    run.owner,
    workspaceId,
    noteB,
    'Note B estuary notes'
  );
  await pasteQuizBlock(ownerPage, editorB, noteB, {
    id: 'block_quiz_photo',
    materialId: quiz,
  });
  const [pasted] = await run.poll(
    'note B projects its own copy',
    () => quizBlocks(run, noteB),
    (blocks) =>
      blocks.length === 1 &&
      typeof blocks[0].materialId === 'string' &&
      blocks[0].materialId !== quiz
  );
  // Copy and paste of B's own block within B: the second block gets a second quiz.
  await editorB
    .getByText('Note B estuary notes', { exact: true })
    .click({ position: { x: 2, y: 2 } });
  await ownerPage.keyboard.press('End');
  await ownerPage.keyboard.press('Enter');
  await pasteQuizBlock(ownerPage, editorB, noteB, {
    id: pasted.id,
    materialId: string(pasted.materialId),
  });
  await expect(editorB.locator('.slate-material_ref')).toHaveCount(2);
  const blocks = await run.poll(
    'note B projects two quizzes',
    () => quizBlocks(run, noteB),
    (rows) =>
      rows.length === 2 && new Set(rows.map((row) => row.materialId)).size === 2
  );
  const copies = blocks.map((block) => string(block.materialId));
  assert(copies.includes(string(pasted.materialId)));
  assert(!copies.includes(quiz));
  for (const copy of copies) {
    const row = await materialRow(run, copy);
    assert.equal(row.parent_material_id, noteB);
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
    [noteA]
  );
  assert.deepEqual(
    embeddedInA.map((row) => row.id),
    [quiz]
  );

  // 4 (first half). The editor inserts an image into note A.
  const { page } = editor;
  const small = noisePng(320, 240);
  const editorNote = await emptyLine(
    run,
    editor,
    workspaceId,
    noteA,
    'Note A wetland notes'
  );
  await page.keyboard.type('/');
  await page.getByRole('option', { exact: true, name: 'Image' }).click();
  const uploaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.startsWith(
        `/api/materials/${noteA}/editor-assets/uploads/`
      ) && new URL(response.url()).pathname.endsWith('/complete')
  );
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    editorNote.getByRole('button', { name: /^Add an image/ }).click(),
  ]);
  await chooser.setFiles({
    buffer: small,
    mimeType: 'image/png',
    name: 'marsh.png',
  });
  const first = await uploaded;
  assert.equal(first.status(), 201);
  const firstId = string(object(await first.json()).assetId);
  const image = editorNote.locator('img[alt="marsh.png"]');
  await expect(image).toBeVisible({ timeout: 60_000 });
  await run.poll(
    'note A projects the image',
    () => contentText(run, noteA),
    (text) => text.includes(firstId)
  );
  const [noteImage] = (await materialAssets(run, noteA)).filter(
    (row) => row.id === firstId
  );
  assert.equal(noteImage.created_by, editor.id);
  assert.equal(noteImage.user_id, run.owner.id);
  await run.record('blob', noteImage.object_path, { assetId: firstId, noteA });
  assert.equal((await run.blob(noteImage.object_path)).sha256, sha256(small));

  // 3. Removing the original quiz's image (over a minute old) deletes its row.
  await aged(run, quiz, [quizImage.id]);
  const refs = await blobRefs(run, quizImage.object_path);
  const beforeRemoval = await charge(run);
  const sizeBefore = Number((await materialRow(run, quiz)).size_bytes);
  await removeQuizImage(run, quiz);
  assert.deepEqual(await materialAssets(run, quiz), []);
  assert(!(await contentText(run, quiz)).includes(quizImage.id));
  assert.equal(
    (await charge(run)) - beforeRemoval,
    Number((await materialRow(run, quiz)).size_bytes) -
      sizeBefore -
      Number(quizImage.size_bytes)
  );
  // The copies keep their rows and the shared object.
  assert.equal(await blobRefs(run, quizImage.object_path), refs - 1);
  for (const copy of copies)
    assert.equal((await materialAssets(run, copy)).length, 1);
  assert.equal(
    (await run.blob(quizImage.object_path)).size,
    Number(quizImage.size_bytes)
  );

  // 4 (second half). Delete the note image, then Undo.
  await aged(run, noteA, [firstId]);
  await image.click({ button: 'right' });
  await page
    .locator('[data-slot="context-menu-content"]')
    .getByRole('menuitem', { name: 'Delete' })
    .click();
  await expect(image).toHaveCount(0);
  await run.poll(
    'the save deletes the note image',
    async () => ({
      assets: await materialAssets(run, noteA),
      refs: await blobRefs(run, noteImage.object_path),
      text: await contentText(run, noteA),
    }),
    ({ assets, refs, text }) =>
      !text.includes(firstId) &&
      !assets.some((row) => row.id === firstId) &&
      refs === 0,
    120_000
  );
  const adopted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/materials/${noteA}/editor-assets/adopt` &&
      response.request().method() === 'POST'
  );
  const reuploaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.startsWith(
        `/api/materials/${noteA}/editor-assets/uploads/`
      ) && new URL(response.url()).pathname.endsWith('/complete')
  );
  await page.keyboard.press('ControlOrMeta+z');
  // The server copy is gone, so adopt answers no id and the kept bytes upload.
  const adoption = object(await (await adopted).json());
  assert.deepEqual(adoption.assets, [{ sourceId: firstId }]); // no assetId
  const second = await reuploaded;
  assert.equal(second.status(), 201);
  const secondId = string(object(await second.json()).assetId);
  assert.notEqual(secondId, firstId);
  await run.poll(
    'note A projects the re-uploaded image',
    () => contentText(run, noteA),
    (text) => text.includes(secondId) && !text.includes(firstId)
  );
  const [restored] = (await materialAssets(run, noteA)).filter(
    (row) => row.id === secondId
  );
  assert.equal(restored.status, 'ready');
  assert.notEqual(restored.object_path, noteImage.object_path);
  await run.record('blob', restored.object_path, { assetId: secondId, noteA });
  assert.equal((await run.blob(restored.object_path)).sha256, sha256(small));
  await page.reload();
  const reloaded = page
    .locator('[contenteditable="true"]')
    .first()
    .locator('img[alt="marsh.png"]');
  await expect(reloaded).toBeVisible({ timeout: 60_000 });
  assert(
    await reloaded.evaluate(
      (element) => (element as HTMLImageElement).naturalWidth > 0
    )
  );
  await run.attach(`${workspaceId}-images`, {
    copies,
    noteImages: [firstId, secondId],
    quiz,
    quizImage,
  });
  await noProviderCalls(run, workspaceId);
}

/**
 * Flashcard front images, the quiz image rule for cards: one front image per
 * card, shrunk under 2 MB in the browser and uploaded only on Save; removing
 * it and saving deletes the row. Not on main yet, so the card dialog's image
 * controls (the file input and its "Remove image") are assumed here and need
 * confirming when they land; the grid, "Add card" tile and "Edit card N/M"
 * dialog follow the flashcards rework.
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
  // The edit page is a grid of front tiles plus a dashed "Add card" tile; a
  // tile opens the "Edit card N/M" dialog, and changes stay staged until the
  // page's Save.
  await page.getByRole('button', { exact: true, name: 'Add card' }).click();
  const dialog = page.getByRole('dialog', { name: /^Edit card/ });
  await dialog.getByRole('textbox', { name: 'Front' }).fill('Salt marsh');
  await dialog
    .getByRole('textbox', { name: 'Back' })
    .fill('Coastal grassland flooded by tides');
  await dialog.locator('input[type="file"]').setInputFiles({
    buffer: noisePng(2400, 1600),
    mimeType: 'image/png',
    name: 'marsh.png',
  });
  await expect(dialog.locator('img[src^="blob:"]').first()).toBeVisible({
    timeout: 60_000,
  });
  await dialog.getByRole('button', { exact: true, name: 'Save' }).click();
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
  await dialog.getByRole('button', { name: 'Remove image' }).click();
  await dialog.getByRole('button', { exact: true, name: 'Save' }).click();
  await pageSave(page);
  await run.poll(
    'card image deleted',
    () => materialAssets(run, setId),
    (rows) => rows.length === 0
  );
  await noProviderCalls(run, workspaceId);
}
