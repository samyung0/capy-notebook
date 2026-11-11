import { expect, it } from 'vitest';
import { legacyOfficeTarget } from '@/features/files/fileUtils';
import { fastParseExtensions } from '@/features/workspace/sourceAnalysis';
import { biologyOfficeFixtures, convertMockLegacyFile } from './officeFixtures';
import { sourceUploadPolicy } from './sourceUploadPolicy';

// The mock worker converts a legacy Office upload as the server does: a new
// name and revision, on bytes the Office viewer opens.
it('converts a legacy Office file to its new format', () => {
  const file = { name: 'Lab report.v2.doc', revision: 1, sizeBytes: 12 };
  const url = convertMockLegacyFile(file, 'docx');
  const fixture = biologyOfficeFixtures[0];
  expect(file).toEqual({
    name: 'Lab report.v2.docx',
    revision: 2,
    sizeBytes: fixture.sizeBytes,
  });
  expect(url).toBe(fixture.sourceURL);
  expect(legacyOfficeTarget(file.name)).toBe(null);
});

it('lists the legacy formats under fast parsing, as the server policy does', () => {
  const fast = fastParseExtensions(sourceUploadPolicy);
  for (const ext of ['doc', 'xls', 'ppt']) expect(fast.has(ext)).toBe(true);
});
