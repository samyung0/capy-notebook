/* biome-ignore-all lint/suspicious/noMisplacedAssertion: The helpers execute only inside this test. */
// A scanned page: page 1 of the PDF has a text layer, page 2 is only an image,
// so the ingest worker reads page 2 with the VLM. UAT's
// INGEST_UAT_SCRIPTED_VLM reads each text-less page of a file named with
// `[uat-scripted-vlm]` as `UAT scripted page <n>: <name without markers>`,
// with no provider call but the normal per-page charge (pipeline ingest/uat.py).
// Scripted reads are cached under marker plus name, so the name carries a
// fresh token per run.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type Citation, scriptedSearch } from './chat';
import {
  fact,
  fileRow,
  pdf,
  pinnedRate,
  processed,
  scriptedPageRead,
  settledSpend,
  string,
  upload,
  workspace,
} from './files';
import { test, type UatRun } from './runtime';

/** A page of text as a scanner hands it over: Chromium draws the lines and
 * returns a JPEG; the PDF holds the picture and no text. */
async function scan(run: UatRun, lines: string[]) {
  const page = await run.owner.context.newPage();
  try {
    await page.setViewportSize({ height: 792, width: 612 });
    await page.setContent(
      `<body style="margin:72px;font:15px/1.6 serif">${lines.map((line) => `<p>${line}</p>`).join('')}</body>`
    );
    const jpeg = await page.screenshot({
      quality: 80,
      scale: 'css',
      type: 'jpeg',
    });
    return { height: 792, jpeg, width: 612 };
  } finally {
    await page.close();
  }
}

/** The VLM text block's box: the whole page, so a citation highlights it. */
const wholePage = (regions: Citation['regions'], page: number) =>
  (regions ?? []).some(
    (region) =>
      region.page === page &&
      region.space === 'page-1000-topleft' &&
      isDeepStrictEqual(region.bbox.map(Number), [0, 0, 1000, 1000])
  );

test('scanned PDF: the text-less page is read by the VLM (scripted), charged as a page read and cited on its page', async ({
  run,
}) => {
  test.setTimeout(1_800_000);
  const workspaceId = await workspace(run, 'scan');
  const token = `UAT_${randomUUID().replaceAll('-', '')}`;
  const read = `UAT scripted page 2: scan ${token}`;
  // The run nonce on the scanned page makes the bytes new; page 1 carries
  // neither it nor the token, so only page 2's read matches a search for it.
  const bytes = pdf([
    [fact, 'The launch code is LARCH-17.', 'The field survey continues.'],
    await scan(run, [
      'Field survey sheet',
      'Reed beds were counted along the north transect.',
      `Sheet ${randomUUID()}`,
    ]),
  ]);
  const fileId = await upload(
    run,
    workspaceId,
    `scan [uat-scripted-vlm] ${token}.pdf`,
    bytes
  );

  // Whatever the outcome, page 2 must hold the scripted read: without the
  // switch the marker is plain name text and the page is read for real.
  const outcome = await run.poll(
    'scanned PDF ingest outcome',
    () => fileRow(run, fileId),
    (row) => row.status === 'ready' || row.status === 'failed',
    900_000
  );
  const chunks = await run.query(
    `SELECT c.id,c.indexed_text,c.page_start,c.page_end,c.regions FROM rag_chunks c
    JOIN rag_file_contents f ON f.content_id=c.content_id AND f.workspace_id=c.workspace_id WHERE f.file_id=%s`,
    [fileId]
  );
  const pageTwo = chunks.filter((chunk) =>
    string(chunk.indexed_text).includes(read)
  );
  assert.equal(
    pageTwo.length,
    1,
    `page 2 was not read as "${read}" (file ${outcome.status}): UAT ingest needs INGEST_UAT_SCRIPTED_VLM=true`
  );
  const [chunk] = pageTwo;
  const regions = chunk.regions as Citation['regions'];
  assert(Number(chunk.page_start) <= 2 && Number(chunk.page_end) === 2);
  assert(wholePage(regions, 2), 'the read page has no whole-page box');
  await processed(run, fileId, [read]);

  // Charges, at the rates the job pinned: the one page read at the VLM page
  // rate, owner-paid and settled (processed checked the sessions), with no
  // provider usage since the read was scripted; the parse charges only the
  // page with a text layer, at the digital page rate.
  const [session, ...others] = await settledSpend(run, fileId);
  assert.equal(others.length, 0);
  const id = string(session.id);
  const pageRead = await scriptedPageRead(run, id);
  const parses = await run.query(
    `SELECT actor_user_id,parse_pages,parse_ocr_pages,credit_micros FROM usage_events
    WHERE kind='parse' AND metadata->>'fileId'=%s`,
    [fileId]
  );
  assert.equal(parses.length, 1, 'one parse');
  assert.deepEqual(
    [
      parses[0].actor_user_id,
      Number(parses[0].parse_pages),
      Number(parses[0].parse_ocr_pages),
      Number(parses[0].credit_micros),
    ],
    [run.owner.id, 2, 1, await pinnedRate(run, id, 'digital_parse_page')]
  );

  // A scripted search for the token cites the read: its page and its box.
  const cited = await scriptedSearch(run, workspaceId, `scan ${token}`);
  assert.equal(cited.length, 1, 'the answer has no citation');
  assert.deepEqual(
    [cited[0].fileId, cited[0].chunkId],
    [fileId, chunk.id],
    'the cited passage is not the read page'
  );
  assert(Number(cited[0].pageStart) <= 2 && cited[0].pageEnd === 2);
  assert(wholePage(cited[0].regions, 2), 'the citation has no page 2 box');
  await run.attach(`${fileId}-scan`, { chunk, cited, pageRead, parses });
});
