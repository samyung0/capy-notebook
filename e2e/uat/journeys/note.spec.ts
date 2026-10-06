import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { strFromU8 } from 'fflate';
import { invite, noProviderCalls } from './files';
import {
  apiEmbeddedQuiz,
  apiNote,
  cardImages,
  contentText,
  createNote,
  deleteAndUndoNoteImage,
  exportMarkdown,
  importHtmlEmbed,
  insertEmbedded,
  insertNoteImage,
  lineAfter,
  noisePng,
  notesWorkspace,
  openNote,
  pastedQuizCopies,
  quizImageOnSave,
  quizImageRemoved,
  readView,
  refBlocks,
  removeAndUndoQuizBlock,
  samePixels,
} from './note';
import { expect, test } from './runtime';

// Plate notes: no parser, embedding or LLM call (asserted per workspace; note
// indexing is off through the workspace's Auto process edits switch). The
// editor-feature specs cover formatting, comments, offline drafts and AI
// edits; these cover what the deployment adds: the collaboration service and
// its saves, B2 uploads and deletions, signed image reads, adopt and trash,
// and the separate embed origin.
test('note: created in the browser, two editors converge, an image stored, exported, read by a viewer and back on Undo, an interactive block framed on the embed origin', async ({
  run,
}) => {
  test.setTimeout(1_200_000);
  const workspaceId = await notesWorkspace(run, 'note');
  const editor = await run.createActor('note-editor');
  const viewer = await run.createActor('note-viewer');
  await invite(run, workspaceId, editor, 'editor');
  await invite(run, workspaceId, viewer, 'viewer');
  // No underscore: Markdown export escapes it.
  const marker = `UAT${randomUUID().replaceAll('-', '')}`;
  const ownerLine = `Owner ${marker}`;
  const editorLine = `Editor ${marker}`;

  // 1. Both type; both clients and the saved projection hold both lines.
  const noteId = await createNote(run, workspaceId);
  const ownerPage = run.owner.page;
  const ownerEditor = await openNote(run, run.owner, workspaceId, noteId);
  await ownerEditor.click();
  await ownerPage.keyboard.press('ControlOrMeta+End');
  await ownerPage.keyboard.type(ownerLine);
  const editorEditor = await openNote(run, editor, workspaceId, noteId);
  await lineAfter(editor.page, editorEditor, ownerLine);
  await editor.page.keyboard.type(editorLine);
  for (const client of [ownerEditor, editorEditor])
    for (const line of [ownerLine, editorLine])
      await expect(client.getByText(line, { exact: true })).toBeVisible();
  await run.poll(
    'the saved note holds both lines',
    () => contentText(run, noteId),
    (text) => text.includes(ownerLine) && text.includes(editorLine)
  );

  // 2. The editor picks an image under its line.
  const png = noisePng(320, 240);
  const imageName = 'marsh.png';
  const asset = await insertNoteImage(
    run,
    editor,
    workspaceId,
    noteId,
    editorLine,
    png,
    imageName
  );

  // 3. The owner imports an interactive block under its line.
  const embed = await importHtmlEmbed(
    ownerPage,
    ownerEditor,
    run,
    noteId,
    ownerLine,
    marker
  );

  // 4. The viewer's read view: lines, image, framed snippet.
  await readView(
    run,
    viewer,
    workspaceId,
    noteId,
    [ownerLine, editorLine],
    imageName,
    embed
  );

  // 5. Markdown export: the image is the stored one, the block a link to it.
  const zip = await exportMarkdown(ownerPage);
  const markdown = strFromU8(zip['document.md']);
  for (const text of [ownerLine, editorLine, `block=${embed.id}`])
    assert(markdown.includes(text), `the export lacks ${text}`);
  const exported = Object.keys(zip).filter((path) =>
    path.startsWith('assets/')
  );
  assert.equal(exported.length, 1);
  const stored = await run.blob(asset.object_path);
  assert(
    await samePixels(
      ownerPage,
      zip[exported[0]],
      Buffer.from(stored.bodyBase64, 'base64')
    ),
    'the exported image differs from the stored one'
  );

  // 6. Delete after the grace minute, then Undo.
  const restored = await deleteAndUndoNoteImage(
    run,
    editor,
    noteId,
    asset,
    png,
    imageName
  );
  await run.attach(`${noteId}-note`, {
    embed: embed.id,
    images: [asset.id, restored],
  });
  await noProviderCalls(run, workspaceId);
});

test('note embedded blocks: quiz and flashcards inserted under the note, a removed quiz block trashed hidden and back on Undo, a quiz image shrunk and uploaded on Save, pasted quiz blocks copied per block', async ({
  run,
}) => {
  test.setTimeout(1_200_000);
  const workspaceId = await notesWorkspace(run, 'embedded');
  const notes = {
    a: await apiNote(run, workspaceId, 'Note A wetland notes'),
    aBody: 'Note A wetland notes',
    b: await apiNote(run, workspaceId, 'Note B estuary notes'),
    bBody: 'Note B estuary notes',
  };
  const tideBody = 'Note C tide notes';
  const noteC = await apiNote(run, workspaceId, tideBody);

  // 1. Slash command inserts: rows embedded in note C, referenced by its blocks.
  const inserted = await insertEmbedded(
    run,
    workspaceId,
    noteC,
    tideBody,
    'quiz'
  );
  const set = await insertEmbedded(
    run,
    workspaceId,
    noteC,
    tideBody,
    'flashcards'
  );
  await run.poll(
    'note C references both',
    () => refBlocks(run, noteC),
    (blocks) =>
      blocks.length === 2 &&
      [inserted, set].every((id) =>
        blocks.some((block) => block.materialId === id)
      )
  );

  // 2. Quiz image (a quiz embedded in note A), shrunk and uploaded on Save.
  const quiz = await apiEmbeddedQuiz(run, notes.a);
  const quizImage = await quizImageOnSave(run, quiz);

  // 3. Pasted quiz blocks: kept in its own note, copied per block elsewhere.
  const copies = await pastedQuizCopies(
    run,
    workspaceId,
    notes,
    quiz,
    quizImage
  );

  // 4. The inserted quiz's block removed (hidden trash) and back on Undo.
  await removeAndUndoQuizBlock(run, workspaceId, noteC, inserted);

  // 5. The original's image removed; the copies keep theirs.
  await quizImageRemoved(run, quiz, quizImage, copies);
  await run.attach(`${workspaceId}-embedded`, {
    copies,
    inserted: [inserted, set],
    quiz,
    quizImage,
  });
  await noProviderCalls(run, workspaceId);
});

// biome-ignore lint/suspicious/noSkippedTests: card images are not deployed to UAT yet.
test.fixme('note flashcard front images: shrunk, uploaded on Save and deleted on removal', {
  annotation: {
    description: 'card images not deployed to UAT yet',
    type: 'fixme',
  },
}, async ({ run }) => {
  test.setTimeout(900_000);
  await cardImages(run);
});
