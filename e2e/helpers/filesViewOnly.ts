import { readFileSync } from 'node:fs';
import { test } from '@playwright/test';

/** Go's sourceupload.FilesEditable (Q853 A), read from the agent-tool
 * contract Go generates from it: edit_office_document is offered only while
 * files are editable (Q854 A). The mocks mirror it as src/mocks/db.ts
 * FILES_EDITABLE. */
export const FILES_EDITABLE = (
  JSON.parse(
    readFileSync(
      new URL(
        '../../pipeline/pipeline/generated/agent_tools.json',
        import.meta.url
      ),
      'utf8'
    )
  ) as { tools: { name: string }[] }
).tools.some((tool) => tool.name === 'edit_office_document');

/** The skip reason of every e2e test that edits a file while files are
 * view-only. */
export const FILES_VIEW_ONLY = 'File editing is off (Q853 A)';

/** Skips the test, describe block or file it is called in (or the rest of
 * the test) while files are view-only. */
export function skipWhileFilesViewOnly() {
  // biome-ignore lint/suspicious/noSkippedTests: files are view-only (Q853 A).
  test.skip(!FILES_EDITABLE, FILES_VIEW_ONLY);
}

/** Skips a check of the view-only refusals once files are editable again. */
export function skipWhileFilesEditable() {
  // biome-ignore lint/suspicious/noSkippedTests: those checks need view-only files.
  test.skip(FILES_EDITABLE, 'files are editable');
}
