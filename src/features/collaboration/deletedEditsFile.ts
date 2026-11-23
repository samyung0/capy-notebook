import * as Y from 'yjs';
import type { DeletedItem } from '@/api/client';
import { readRoomSeed } from '@/features/collaboration/deviceCopy';
import { officeFormatOf } from '@/features/files/fileUtils';
import { sourceDocOptions } from '@/features/files/sourceProvider';
import { downloadEditorFile } from '@/features/notes/documentAdapters';
import type { ExportFormat } from '@/features/notes/export/render';
import { keysScope, readQuestions } from '@/features/quizzes/liveQuiz';
import { m } from '@/i18n';
import {
  type DeletedDrafts,
  deletedDocument,
  type EditDraft,
  readDraftBase,
  readDrafts,
  type ShownDrafts,
} from '@/lib/editDrafts';
import { deletedNote } from './deletedNote';
import { draftFile } from './expiredDrafts';

/* A deleted item's unsent edits as a file (Epo 2026-11-20, Q39-Q43), made
 * from the stored drafts alone: no server call, no asset or embed fetched.
 * Its kind and name are the server's `item_deleted` answer's. Loaded when
 * its toast is offered (`canSaveDeletedEdits`), which is rare. */

// A file name's extension, with its dot.
const EXTENSION = /\.[^.]+$/;

/** What a file drew, by document key: the rows its Download then deletes
 * (`shownRows`); the rest stay for the next page load's offer. */
export type Drew = Map<string, ShownDrafts>;

/** A document's rows a file draws from: the toast's offered, or the open
 * page's shown. */
type OfferedRows = (key: string) => Promise<EditDraft[]>;

/** A document's rows the toast offered, as stored now: rows written since
 * (the item restored and opened again) are never drawn nor deleted. */
const offeredRows =
  (offered: DeletedDrafts['offered']): OfferedRows =>
  async (key) => {
    const ids = new Set(offered[key]);
    return (await readDrafts(key)).filter((row) => ids.has(row.id));
  };

/** A material's documents: its content's key and its keys' key, if any. A
 * quiz whose keys alone have edits still names its content document, for
 * this device's copy of its questions. */
function materialKeys(keys: string[]) {
  const answers = keys.find((key) => key.endsWith(':keys'));
  const content =
    keys.find((key) => !key.endsWith(':keys')) ??
    answers?.slice(0, -':keys'.length) ??
    '';
  return { answers, content };
}

/** Whether rows draw a document (`deletedDocument`), which is then gone. */
function draws(
  rows: EditDraft[],
  docOptions?: ConstructorParameters<typeof Y.Doc>[0]
) {
  const found = deletedDocument(rows, docOptions);
  found?.doc.destroy();
  return found;
}

/** Whether the offered drafts make a file at all, checked before the toast
 * offers Download (review 2026-11-20): none draws (update rows whose state
 * is gone), or an Office file's base is no longer stored, so a Download could
 * only fail. */
export async function canSaveDeletedEdits({
  file,
  item,
  keys,
  offered,
}: DeletedDrafts): Promise<boolean> {
  const read = offeredRows(offered);
  if (file) {
    const key = keys[0] ?? '';
    const office = officeFormatOf(item);
    const found = draws(await read(key), sourceDocOptions(office ?? 'text'));
    if (!(found && office)) return !!found;
    return !!(
      found.newest.base && (await readDraftBase(key, found.newest.base))
    );
  }
  const { answers, content } = materialKeys(keys);
  const rows = content ? await read(content) : [];
  switch (item.kind) {
    case 'note': {
      const note = deletedNote(rows);
      note?.shown.doc?.destroy();
      return !!note;
    }
    case 'quiz':
      return !!draws(rows) || (!!answers && !!draws(await read(answers)));
    case 'canvas':
      return !!draws(rows);
    // Their file holds what the drawing holds, which may be nothing.
    case 'flashcards':
    case 'diagram':
    case 'mindmap': {
      const found = deletedDocument(rows);
      const made = found && draftFile(found.doc, item.kind, undefined);
      found?.doc.destroy();
      return !!made;
    }
    default:
      return false;
  }
}

/** Saves the file of the rows the toast offered (`saveFile`). */
export const saveDeletedEdits = (drafts: DeletedDrafts) =>
  saveFile(drafts, offeredRows(drafts.offered));

/** Saves the file of the rows the open page shows, as they were when read
 * (`shownDeletedRows`, by id and seq), a note's as Markdown or Word. */
export const saveShownEdits = (
  target: Omit<DeletedDrafts, 'offered'>,
  shown: Record<string, EditDraft[]>,
  format?: ExportFormat
) => saveFile(target, async (key) => shown[key] ?? [], format);

/** Saves the file of what an open item's recovery shows (Epo 2026-11-23),
 * from its documents as drawn, named as `saveFile` names an item's: a
 * canvas as its image, a quiz's questions with its keys as JSON, a set's or
 * a diagram's text. Throws when they hold nothing to save. */
export async function saveRecoveryFile(
  item: DeletedItem,
  content: Y.Doc | null,
  keys: Y.Doc | null
) {
  const made = await recoveryFile(item, content, keys);
  downloadEditorFile(
    made.blob,
    `${item.name} (${m.lost_edits_file()}).${made.extension}`
  );
}

async function recoveryFile(
  item: DeletedItem,
  content: Y.Doc | null,
  keys: Y.Doc | null
): Promise<Made> {
  if (item.kind === 'canvas' && content)
    return {
      blob: await boardImage(content, item.name),
      extension: 'png',
    };
  if (item.kind === 'quiz' && (content || keys)) {
    const value = content
      ? readQuestions(content, keys)
      : {
          about: m.lost_edits_questions(),
          answerKeys: keys && keysScope(keys).toJSON(),
        };
    return {
      blob: new Blob([JSON.stringify(value, null, 2)], {
        type: 'application/json',
      }),
      extension: 'json',
    };
  }
  if (
    (item.kind === 'flashcards' ||
      item.kind === 'diagram' ||
      item.kind === 'mindmap') &&
    content
  ) {
    const made = draftFile(content, item.kind, undefined);
    if (made)
      return {
        blob: new Blob([made.text], { type: 'text/plain' }),
        extension: made.extension,
      };
  }
  throw new Error(`Nothing of the ${item.kind} to save`);
}

/** Saves the file: "{title} (unsaved edits).{ext}", a file keeping its own
 * extension (none when its name has none); a note as Markdown, or as Word
 * from its open page's ⋮ (`format`). Throws when nothing in the drafts can be
 * drawn. Resolves what it drew; the caller destroys its documents. */
async function saveFile(
  { file, item, keys }: Omit<DeletedDrafts, 'offered'>,
  readOffered: OfferedRows,
  format: ExportFormat = 'markdown'
): Promise<Drew> {
  const drew: Drew = new Map();
  try {
    const suffix = ` (${m.lost_edits_file()})`;
    if (file) {
      const extension = item.name.match(EXTENSION)?.[0] ?? '';
      downloadEditorFile(
        await sourceFile(item, keys[0] ?? '', drew, readOffered),
        `${item.name.slice(0, item.name.length - extension.length)}${suffix}${extension}`
      );
      return drew;
    }
    const made = await materialFile(item, keys, drew, readOffered, format);
    downloadEditorFile(made.blob, `${item.name}${suffix}.${made.extension}`);
    return drew;
  } catch (error) {
    for (const { doc } of drew.values()) doc?.destroy();
    throw error;
  }
}

interface Made {
  blob: Blob;
  extension: string;
}

/** The document a key's drafts draw, kept in `drew`. */
function drawn(
  key: string,
  rows: EditDraft[],
  drew: Drew,
  docOptions?: ConstructorParameters<typeof Y.Doc>[0]
) {
  const found = deletedDocument(rows, docOptions);
  if (!found) throw new Error('No stored edits draw the deleted item');
  drew.set(key, { doc: found.doc, rows: found.rows });
  return found;
}

/** An Office file over the base its drafts grew from (the editor's export
 * worker, as a download of saved edits), or a text file's source. */
async function sourceFile(
  item: DeletedItem,
  key: string,
  drew: Drew,
  read: OfferedRows
): Promise<Blob> {
  const office = officeFormatOf(item);
  const rows = await read(key);
  const { doc, newest } = drawn(
    key,
    rows,
    drew,
    sourceDocOptions(office ?? 'text')
  );
  if (!office)
    return new Blob([doc.getText('source').toString()], {
      type: 'text/plain;charset=utf-8',
    });
  const base = newest.base && (await readDraftBase(key, newest.base));
  if (!base) throw new Error('The deleted file’s base is not stored');
  const { exportCheckpoint } = await import(
    '@/office-runtime/exportCheckpoint'
  );
  const bytes = await exportCheckpoint(
    office,
    base.slice().buffer,
    Y.encodeStateAsUpdate(doc).slice().buffer
  );
  return new Blob([bytes.slice()]);
}

async function materialFile(
  item: DeletedItem,
  keys: string[],
  drew: Drew,
  read: OfferedRows,
  format: ExportFormat
): Promise<Made> {
  const { answers, content } = materialKeys(keys);
  const rows = content ? await read(content) : [];
  switch (item.kind) {
    case 'note': {
      const note = deletedNote(rows);
      if (!note) throw new Error('No stored edits draw the deleted note');
      drew.set(content, note.shown);
      const { runExportWorker } = await import(
        '@/features/notes/export/client'
      );
      return runExportWorker({
        assetUrls: {},
        format,
        noteUrl: location.origin,
        value: note.value,
      });
    }
    case 'canvas':
      return {
        blob: await boardImage(drawn(content, rows, drew).doc, item.name),
        extension: 'png',
      };
    case 'quiz':
      return quizJson(
        content,
        rows,
        answers,
        answers ? await read(answers) : [],
        drew
      );
    case 'flashcards':
    case 'diagram':
    case 'mindmap': {
      const made = draftFile(
        drawn(content, rows, drew).doc,
        item.kind,
        undefined
      );
      if (!made) throw new Error('The deleted item’s drafts hold nothing');
      return {
        blob: new Blob([made.text], { type: 'text/plain' }),
        extension: made.extension,
      };
    }
    default:
      throw new Error(`No file for a deleted ${item.kind}`);
  }
}

/** A quiz's questions with what its keys' drafts hold (Q43). Questions only
 * its keys were edited for come from this device's copy of its content room
 * (kept while edits are stored, `sweepDeviceCopies`); with none, the keys
 * document under a line saying the questions are not included, so it never
 * reads as the whole quiz. */
async function quizJson(
  contentKey: string,
  content: EditDraft[],
  answersKey: string | undefined,
  answers: EditDraft[],
  drew: Drew
): Promise<Made> {
  const questions = deletedDocument(content);
  if (questions)
    drew.set(contentKey, { doc: questions.doc, rows: questions.rows });
  const keys = answersKey ? deletedDocument(answers) : null;
  if (keys && answersKey)
    drew.set(answersKey, { doc: keys.doc, rows: keys.rows });
  if (!(questions || keys)) throw new Error('No stored edits to the quiz');
  const owner = contentKey.split(':')[0];
  const id = contentKey.split(':')[2];
  const copy =
    questions || !owner || !id ? null : await readRoomSeed(owner, id);
  const read = questions?.doc ?? copy?.doc;
  const value = read
    ? readQuestions(read, keys?.doc ?? null)
    : {
        about: m.lost_edits_questions(),
        answerKeys: keys && keysScope(keys.doc).toJSON(),
      };
  copy?.doc.destroy();
  return {
    blob: new Blob([JSON.stringify(value, null, 2)], {
      type: 'application/json',
    }),
    extension: 'json',
  };
}

/** A canvas as Download as image draws it (Q43 A): its drafts' document on a
 * read-only board off screen, gone once drawn. Images are not fetched: each
 * is a box saying it is not available. */
async function boardImage(doc: Y.Doc, title: string): Promise<Blob> {
  const { mountDrawingBoard } = await import(
    '@/features/blocksuite/drawingBoard'
  );
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.inert = true;
  // Laid out (a hidden board draws nothing), out of sight.
  Object.assign(host.style, {
    height: '800px',
    left: '-20000px',
    pointerEvents: 'none',
    position: 'fixed',
    top: '0',
    width: '1280px',
  });
  document.body.append(host);
  const board = mountDrawingBoard(host, {
    board: 'workspace',
    images: {},
    readOnly: true,
    room: { doc },
    title: () => title,
  });
  try {
    await board.ready;
    return await board.image();
  } finally {
    board.unmount();
    host.remove();
  }
}
