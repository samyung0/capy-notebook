import { FontSliceUnavailableError } from '@betteroffice/docx-react';
import { expect, test, vi } from 'vitest';
import { fontSliceErrors } from './fontSliceErrors';

const host = () => ({
  onError: vi.fn(),
  onFontError: vi.fn(),
  onNotice: vi.fn(),
});

// Q752 B: a slice failing while editing keeps the editor open.
test('a slice failing while editing shows one notice until the browser is back online', () => {
  const calls = host();
  const errors = fontSliceErrors(calls);
  errors.report(
    new FontSliceUnavailableError('NotoSansJP-Regular/c093.zst', 'network')
  );
  errors.report(
    new FontSliceUnavailableError('NotoSansSC-Regular/c011.zst', 'network')
  );
  expect(calls.onNotice.mock.calls).toEqual([['font-slice-unavailable']]);
  expect(calls.onError).not.toHaveBeenCalled();
  expect(calls.onFontError).not.toHaveBeenCalled();
  // Back online: the editor asks again, and a failure after that is noticed.
  const retry = vi.fn();
  errors.online(retry);
  expect(retry).toHaveBeenCalledOnce();
  errors.report(
    new FontSliceUnavailableError('NotoSansJP-Regular/c093.zst', 'network')
  );
  expect(calls.onNotice).toHaveBeenCalledTimes(2);
});

test("a server's slice failure also goes to Sentry by its face", () => {
  const calls = host();
  const error = new FontSliceUnavailableError(
    'NotoSansJP-Regular/c093.zst',
    'server',
    503
  );
  fontSliceErrors(calls).report(error);
  expect(calls.onFontError).toHaveBeenCalledExactlyOnceWith(
    'NotoSansJP-Regular',
    error
  );
  expect(calls.onNotice).toHaveBeenCalledOnce();
});

// Q755 B: a face first needed while editing whose index, skeleton or the
// fonts module fails comes as the slice's error, naming the face's index.
test('a face that fails to open while editing is the same notice, reported by its face', () => {
  const calls = host();
  const errors = fontSliceErrors(calls);
  const index = FontSliceUnavailableError.from({
    file: 'NotoSansKR-Regular/slices.json',
    name: 'FontSliceError',
    reason: 'server',
    status: 404,
  });
  errors.report(index);
  errors.report(
    new FontSliceUnavailableError('NotoSansKR-Regular/slices.json', 'network')
  );
  expect(calls.onFontError).toHaveBeenCalledExactlyOnceWith(
    'NotoSansKR-Regular',
    index
  );
  expect(calls.onNotice.mock.calls).toEqual([['font-slice-unavailable']]);
  expect(calls.onError).not.toHaveBeenCalled();
});

test('every other error stays fatal, a slice failing as the document opens included', () => {
  const calls = host();
  const opening = new Error(
    'A font slice failed while the document opened: offline'
  );
  fontSliceErrors(calls).report(opening);
  expect(calls.onError).toHaveBeenCalledExactlyOnceWith(opening);
  expect(calls.onNotice).not.toHaveBeenCalled();
});
