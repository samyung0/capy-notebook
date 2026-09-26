import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  fixture,
  invite,
  noProviderCalls,
  openFile,
  sha256,
  string,
  upload,
  workspace,
} from './files';
import {
  officeCharge,
  openEditor,
  publishWhileEditing,
  saved,
  savedExport,
  seedBytes,
  storageCharge,
} from './office';
import {
  assertRichPreserved,
  editRich,
  expectRichContent,
  pasteRich,
  richEdited,
  richFiles,
  richPaste,
} from './richContent';
import { test } from './runtime';

// Store-only uploads: no parser, embedding or LLM call. The basic Office
// journeys cover parsing and indexing; these cover editing, export fidelity,
// publication under an open editor and the storage charge. PPTX does not
// publish: its editor takes text only as single-key presses, too slow to
// reach the automatic trigger, so the basic PPTX journey and the fork's
// rebase tests cover its publication.
for (const format of ['docx', 'xlsx', 'pptx'] as const) {
  const publishes = format !== 'pptx';
  test(`rich-content ${format}: store-only, two editors, charge and preserved content${publishes ? ', export-only publication under an open editor' : ''}`, async ({
    run,
  }) => {
    test.setTimeout(1_200_000);
    const workspaceId = await workspace(run, `rich-${format}`);
    const marker = `UAT_${randomUUID().replaceAll('-', '')}`;
    const name = richFiles[format];
    const bytes = await fixture(name, marker, 'rich-content');
    const seed = await seedBytes(format, bytes);
    const before = await storageCharge(run);
    const fileId = await upload(run, workspaceId, name, bytes, true);
    const editor = await run.createActor(`rich-${format}-editor`);
    await invite(run, workspaceId, editor, 'editor');

    const ownerFrame = await openEditor(run, run.owner, workspaceId, fileId);
    await saved(run.owner.page);
    // Opening persists nothing: the charge is the source alone.
    const opened = await officeCharge(run, fileId, before);
    assert.equal(opened.state_bytes, null);
    assert.deepEqual(opened.pending_effects, []);

    const editorFrame = await openEditor(run, editor, workspaceId, fileId);
    await editRich(run.owner.page, ownerFrame, format, false);
    await editRich(editor.page, editorFrame, format, true);
    const edited = await run.poll(
      `saved ${format} edits`,
      () => savedExport(run, fileId),
      (result) => richEdited(format, result.bytes),
      180_000
    );
    assertRichPreserved(format, bytes, edited.bytes, marker);
    // The owner's editor shows the collaborator's edit as well as its own.
    await expectRichContent(ownerFrame, format, marker, 'edit');
    // Edits charge their effects and the state's growth beyond seed(base).
    const editCharge = async () => {
      await saved(run.owner.page);
      await saved(editor.page);
      const charged = await officeCharge(run, fileId, before);
      assert.equal(Number(charged.seed_bytes), seed);
      assert(Array.isArray(charged.pending_effects));
      assert(charged.pending_effects.length > 0);
      return charged;
    };
    if (format === 'pptx') {
      await editCharge();
      // The viewer exports the saved state over the unpublished source.
      await openFile(run, editor, workspaceId, fileId, 'view');
      await expectRichContent(
        editor.page.frameLocator('iframe[src*="office-runtime"]'),
        format,
        marker,
        'view'
      );
      await noProviderCalls(run, workspaceId);
      return;
    }

    // The paste passes the automatic trigger; 60 s after this save the file
    // publishes export-only, so the charge check and the wait start now.
    const paste = richPaste(marker);
    await pasteRich(run.owner.page, ownerFrame, format, paste);
    const charged = await editCharge();
    assert(Number(charged.net_tokens) >= 3000);
    const published = await publishWhileEditing(run, editor, fileId);
    // Export-only: the saved edits became the file's bytes, and no index.
    assert.equal(published.indexed, false);
    const source = await run.blob(string(published.blob_path));
    const publishedBytes = Buffer.from(source.bodyBase64, 'base64');
    assertRichPreserved(format, bytes, publishedBytes, marker, paste);

    // Round trip: the reloaded page edits the published file, its viewer
    // shows it, and with no later edits the saved state is seed(published).
    await expectRichContent(
      editor.page.frameLocator('iframe[src*="office-runtime"]'),
      format,
      marker,
      'edit'
    );
    const current = await savedExport(run, fileId);
    assert.equal(current.row.state, null);
    assert.equal(sha256(current.bytes), published.source_sha256);
    await openFile(run, editor, workspaceId, fileId, 'view');
    await expectRichContent(
      editor.page.frameLocator('iframe[src*="office-runtime"]'),
      format,
      marker,
      'view'
    );
    const reopened = await openEditor(run, run.owner, workspaceId, fileId);
    await saved(run.owner.page);
    const republished = await officeCharge(run, fileId, before);
    assert.equal(republished.state_bytes, null);
    await expectRichContent(reopened, format, marker, 'edit');
    await noProviderCalls(run, workspaceId);
  });
}
