/* biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared assertion helpers execute inside the UAT tests. */
// Chat turns from the browser panel. Scripted turns (UAT's
// RETRIEVAL_UAT_SCRIPTED_TOOLS, pipeline/pipeline/retrieval/scripted.py) run
// the tool calls a `[uat-scripted-tools]` message names instead of a model's.
import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import { m } from '../../i18n';
import type { UatRun } from './runtime';

export type Frame = Record<string, unknown> & { type: string };
export type Call = { name: string; arguments: Record<string, unknown> };
export type Citation = {
  chunkId: string;
  fileId: string;
  n: number;
  pageEnd?: number;
  pageStart?: number;
  regions?: { bbox: number[]; page: number; space: string }[];
};

/** Sends a message from the chat panel; returns the frames the gateway
 * streamed, which must end in an answer and carry no error. */
export async function send(page: Page, text: string) {
  await page
    .getByRole('textbox', { exact: true, name: m.chat_placeholder() })
    .fill(text);
  const streamed = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname.endsWith('/chat/stream') &&
      r.request().method() === 'POST',
    { timeout: 300_000 }
  );
  await page.getByRole('button', { exact: true, name: m.chat_send() }).click();
  const response = await streamed;
  assert.equal(response.status(), 200);
  const frames = (await response.text())
    .split('\n\n')
    .map((event) =>
      event
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n')
    )
    .filter(Boolean)
    .map((data) => JSON.parse(data) as Frame);
  assert.deepEqual(
    frames.filter((frame) => frame.type === 'error'),
    [],
    'the turn streamed an error'
  );
  assert(
    frames.some(
      (frame) => frame.type === 'block_end' && frame.kind === 'answer'
    ),
    'the turn streamed no answer'
  );
  const done = frames.at(-1);
  assert.deepEqual([done?.type, done?.status], ['done', 'complete']);
  return frames;
}

/** Sends a scripted turn; every call must succeed. Returns each call's
 * tool_end frame in script order, and the frames. */
export async function scripted(page: Page, steps: (Call[] | string)[]) {
  const frames = await send(
    page,
    `[uat-scripted-tools]${JSON.stringify({ steps })}`
  );
  const calls = steps.flatMap((step) => (typeof step === 'string' ? [] : step));
  const starts = frames.filter((frame) => frame.type === 'tool_start');
  assert.deepEqual(
    starts.map((frame) => frame.name),
    calls.map((call) => call.name),
    'the turn did not follow its script: UAT retrieval needs RETRIEVAL_UAT_SCRIPTED_TOOLS=true'
  );
  const ends = starts.map((start) =>
    frames.find(
      (frame) => frame.type === 'tool_end' && frame.callId === start.callId
    )
  );
  for (const [i, end] of ends.entries())
    assert.equal(
      end?.outcome,
      'succeeded',
      `${calls[i].name}: ${JSON.stringify(end?.error)}`
    );
  return { ends, frames };
}

/** The answer's citations: the turn's last citations frame. */
export const citations = (frames: Frame[]) =>
  (frames.filter((frame) => frame.type === 'citations').at(-1)?.citations ??
    []) as Citation[];

/** A scripted turn in the workspace's chat panel that searches for `query`
 * and answers citing passage 1; returns the answer's citations. */
export async function scriptedSearch(
  run: UatRun,
  workspaceId: string,
  query: string
) {
  const page = run.owner.page;
  await page.goto(`${run.env.appUrl}/workspaces/${workspaceId}`);
  await page
    .getByRole('tab', { exact: true, name: m.workspace_tab_chat() })
    .click();
  const { frames } = await scripted(page, [
    [{ arguments: { query }, name: 'search_workspace' }],
    'root = Answer([a])\na = Md("Scripted search ran.", [1])',
  ]);
  return citations(frames);
}
