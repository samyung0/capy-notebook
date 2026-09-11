/// <reference lib="webworker" />

import { writeDocumentWithRust } from '@betteroffice/docx/docx/rustSaveFacade';
import { createYrsSession } from '@betteroffice/docx/yrs';
import { yrsToDocument } from '@betteroffice/docx/yrs/yrsToDocument';
import {
  initWasm as initPptx,
  openPresentation,
} from '@betteroffice/pptx/editor';
import { initWasm as initXlsx, openWorkbook } from '@betteroffice/xlsx/editor';
import type { OfficeFormat } from '@/features/files/officeProtocol';

// Applies a saved Yrs checkpoint over the published base and writes the
// result back out as a package, the same composition the collaboration
// service's headless export runs. It runs here, on the runtime origin, so the
// editor engines stay contained; the viewer then opens the exported bytes.
type Request = {
  base: ArrayBuffer;
  checkpoint: ArrayBuffer;
  format: OfficeFormat;
  id: number;
};
type Response =
  | { bytes: ArrayBuffer; id: number; type: 'exported' }
  | { id: number; message: string; type: 'error' };

export async function exportCheckpoint(
  format: OfficeFormat,
  base: Uint8Array,
  checkpoint: Uint8Array
): Promise<Uint8Array> {
  if (format === 'xlsx') {
    await initXlsx();
    const workbook = openWorkbook(base, { collaborative: true });
    try {
      workbook.applyUpdate(checkpoint);
      return workbook.save();
    } finally {
      workbook.dispose();
    }
  }
  if (format === 'pptx') {
    await initPptx();
    const deck = openPresentation(base, { initialUpdate: checkpoint });
    try {
      return deck.save();
    } finally {
      deck.dispose();
    }
  }
  const session = await createYrsSession();
  try {
    session.openDocx(base, false);
    session.loadState(checkpoint);
    const document = session.materializeDocx();
    if (!document) throw new Error('DOCX source package was not attached');
    const written = await writeDocumentWithRust(
      yrsToDocument(session, document),
      Uint8Array.from(base).buffer,
      { updateModifiedDate: false }
    );
    return new Uint8Array(written.buffer);
  } finally {
    session.destroy();
  }
}

// Absent under vitest, which imports the composition directly.
if (typeof self !== 'undefined')
  self.onmessage = (event: MessageEvent<Request>) => {
    const { base, checkpoint, format, id } = event.data;
    void exportCheckpoint(
      format,
      new Uint8Array(base),
      new Uint8Array(checkpoint)
    ).then(
      (exported) => {
        const bytes = exported.slice().buffer;
        self.postMessage({ bytes, id, type: 'exported' } satisfies Response, [
          bytes,
        ]);
      },
      (value: unknown) => {
        const message = value instanceof Error ? value.message : String(value);
        self.postMessage({ id, message, type: 'error' } satisfies Response);
      }
    );
  };
