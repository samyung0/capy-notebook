import { expect, it } from 'vitest';
import { m } from '@/i18n';
import { pastedFiles } from './fileDrop';

const clipboard = (files: File[], text = '') => ({
  files,
  getData: (format: string) => (format === 'text/plain' ? text : ''),
});

it('names a copied image or screenshot as pasted, and keeps a named file', () => {
  const shot = new File(['png'], 'image.png', { type: 'image/png' });
  const paper = new File(['pdf'], 'Paper 1.pdf', { type: 'application/pdf' });
  const [image, kept] = pastedFiles(clipboard([shot, paper], 'ignored'));
  expect(image.name).toBe(`${m.file_pasted_image()}.png`);
  expect(image.type).toBe('image/png');
  expect(kept).toBe(paper);
});

it('turns pasted text into a text file', async () => {
  const [file] = pastedFiles(clipboard([], '1. Name an organelle. (1 mark)'));
  expect(file.name).toBe(`${m.file_pasted_text()}.txt`);
  expect(await file.text()).toBe('1. Name an organelle. (1 mark)');
});
