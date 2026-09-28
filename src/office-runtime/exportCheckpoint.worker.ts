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
// A checkpoint with a seed hash is the change over seed(base): the engine
// seeds the base, the seed must hash to it, and the change applies on top.
type Request = {
  base: ArrayBuffer;
  checkpoint: ArrayBuffer;
  format: OfficeFormat;
  id: number;
  seedSHA256?: string;
};
type Response =
  | { bytes: ArrayBuffer; id: number; type: 'exported' }
  | { id: number; message: string; type: 'error' };

async function assertSeed(seed: Uint8Array, seedSHA256: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', Uint8Array.from(seed))
  );
  const hex = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  if (hex !== seedSHA256)
    throw new Error('The saved changes were made over a different seed');
}

export async function exportCheckpoint(
  format: OfficeFormat,
  base: Uint8Array,
  checkpoint: Uint8Array,
  seedSHA256?: string
): Promise<Uint8Array> {
  if (format === 'xlsx') {
    await initXlsx();
    // Opening collaboratively seeds; a complete state holds that seed too.
    const workbook = openWorkbook(base, { collaborative: true });
    try {
      if (seedSHA256)
        await assertSeed(workbook.encodeStateAsUpdate(), seedSHA256);
      workbook.applyUpdate(checkpoint);
      return workbook.save();
    } finally {
      workbook.dispose();
    }
  }
  if (format === 'pptx') {
    await initPptx();
    const deck = seedSHA256
      ? openPresentation(base)
      : openPresentation(base, { initialUpdate: checkpoint });
    try {
      if (seedSHA256) {
        await assertSeed(deck.encodeStateAsUpdate(), seedSHA256);
        deck.applyUpdate(checkpoint);
      }
      return deck.save();
    } finally {
      deck.dispose();
    }
  }
  const session = await createYrsSession();
  try {
    session.openDocx(base, !!seedSHA256);
    if (seedSHA256) await assertSeed(session.encodeState(), seedSHA256);
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
    const { base, checkpoint, format, id, seedSHA256 } = event.data;
    void exportCheckpoint(
      format,
      new Uint8Array(base),
      new Uint8Array(checkpoint),
      seedSHA256
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
