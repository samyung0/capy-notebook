import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { m } from '@/i18n';
import { FileNotIndexedBanner } from './FileStates';

const strip = (status: 'ready' | 'failed' | 'processing') =>
  renderToStaticMarkup(
    <FileNotIndexedBanner
      file={{ indexed: false, name: 'essay.doc', status }}
    />
  ).replaceAll('&#x27;', "'");

// A legacy Office name alone says nothing: a hand-in's .doc is stored and
// never converted, and reads as any file without an index.
it('says a ready .doc is not indexed, and only a failed one that it was not converted', () => {
  expect(strip('ready')).toContain(m.files_not_indexed());
  expect(strip('ready')).toContain('role="status"');
  expect(strip('failed')).toContain(m.files_convert_failed());
  expect(strip('failed')).toContain('role="alert"');
  expect(strip('processing')).toBe('');
});
