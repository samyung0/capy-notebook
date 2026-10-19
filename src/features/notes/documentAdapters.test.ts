/* A JSON or DOCX import clamps a block indent past LIST_INDENT_MAX on entry
   (Epo 2026-10-19), where a direct write refuses it. */
import { createPlateEditor } from 'platejs/react';
import { expect, it, vi } from 'vitest';
import { LIST_INDENT_MAX } from '@/features/materials/document';
import { importDocxDocument, importJsonDocument } from './documentAdapters';

const deep = {
  children: [{ text: 'deep' }],
  id: 'l1',
  indent: LIST_INDENT_MAX + 4,
  listStyleType: 'disc',
  type: 'p',
};

vi.mock('@platejs/docx-io', () => ({
  importDocx: async () => ({ nodes: [deep] }),
}));

it('clamps a JSON import indent to LIST_INDENT_MAX', () => {
  const source = JSON.stringify({ schemaVersion: 1, value: [deep] });
  const { value } = importJsonDocument(createPlateEditor(), source);
  expect(value[0]).toMatchObject({ indent: LIST_INDENT_MAX });
});

it('clamps a DOCX import indent to LIST_INDENT_MAX', async () => {
  const { value } = await importDocxDocument(
    createPlateEditor(),
    new ArrayBuffer(0),
    false
  );
  expect(value[0]).toMatchObject({ indent: LIST_INDENT_MAX });
});
