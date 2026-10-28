/* biome-ignore-all lint/suspicious/noMisplacedAssertion: The helpers execute only inside this test. */
// Account chat on the deployed stack (todo-account-chat.md): the chat outside
// any one workspace, across the owner's own workspace, a workspace they are a
// viewer in and their file with no workspace. Scripted turns (UAT's
// RETRIEVAL_UAT_SCRIPTED_TOOLS, pipeline/pipeline/retrieval/scripted.py) call
// the account tools as a model would, under the owner's operations and the
// contract, against the real index and gateway; no model is called.
//
// A tool's result text reaches the browser only for the tools that keep it
// whole (search_files_summary, list_sources, the creates), through the turn's
// saved toolEvidence, so those are asserted from the message row; a read's
// unindexed changes are not visible here (pipeline and Go tests cover them),
// only that the read of an edited, unindexed file succeeds.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type Citation, citations, scripted } from './chat';
import {
  api,
  fixture,
  invite,
  object,
  processed,
  string,
  upload,
  workspace,
} from './files';
import { materialRow } from './note';
import { test, type UatRun } from './runtime';
import { uploadStandalone } from './standaloneFiles';

type Effect = {
  operation: string;
  resource: { id: string; kind: string; workspaceId?: string };
};
type Note = { name: string; outcome: string; text: string };

/** The resource of a write's `created` effect. */
function created(end: Record<string, unknown> | undefined) {
  const found = ((end?.effects ?? []) as Effect[]).find(
    (item) => item.operation === 'created'
  );
  assert(found, `no created effect in ${JSON.stringify(end?.effects)}`);
  return found.resource;
}

/** The kept tool results of the owner's latest account chat answer. */
async function keptResults(run: UatRun) {
  const rows = await run.query(
    `SELECT m.metadata->'toolEvidence'->'tools' AS tools FROM messages m
    JOIN conversations c ON c.id=m.conversation_id
    WHERE c.user_id=%s AND c.workspace_id IS NULL AND m.role='assistant'
    ORDER BY m.created_at DESC LIMIT 1`,
    [run.owner.id]
  );
  return (rows[0]?.tools ?? []) as Note[];
}

const kept = (notes: Note[], name: string) =>
  notes.filter((note) => note.name === name).map((note) => note.text);

test('account chat: search, list, read and write across workspaces and no workspace', async ({
  run,
}) => {
  test.setTimeout(2_400_000);
  const page = run.owner.page;
  const marker = `UAT_${randomUUID().replaceAll('-', '')}`;
  const member = await run.createActor('member');

  // The owner's workspace and a text file in it, indexed.
  const own = await workspace(run, 'account chat');
  const ownText = await upload(
    run,
    own,
    `own-${marker}.txt`,
    await fixture('notes.txt', marker)
  );
  // A workspace the member owns, where the owner is a viewer.
  const memberName = `UAT account member ${marker.slice(4, 12)}`;
  const shared = string(
    object(
      await api(member, '/api/workspaces', 'POST', { name: memberName }, 201)
    ).id
  );
  await run.record('workspace', shared, { ownerId: member.id });
  const memberText = await upload(
    run,
    shared,
    `member-${marker}.txt`,
    await fixture('notes.txt', marker),
    false,
    member
  );
  await invite(run, shared, run.owner, 'viewer', member);
  // The owner's file with no workspace, stored only (found by its name).
  const loose = await uploadStandalone(
    run,
    `loose-${marker}.bin`,
    Buffer.from(`loose ${marker}`)
  );
  await processed(run, ownText, [marker]);
  await processed(run, memberText, [marker]);
  // The agent's edit below stays unindexed.
  await api(run.owner, `/api/workspaces/${own}`, 'PATCH', {
    autoProcess: false,
  });

  await page.goto(`${run.env.appUrl}/chat`);

  // Turn 1: find, list and read, then answer citing passage 1 (the read).
  const first = await scripted(page, [
    [
      { arguments: { query: marker }, name: 'search_files_summary' },
      { arguments: {}, name: 'list_sources' },
      { arguments: { workspace_id: shared }, name: 'list_sources' },
      { arguments: { file_id: memberText }, name: 'read_document' },
    ],
    [
      {
        arguments: { query: 'launch code LARCH-17' },
        name: 'search_files_content',
      },
    ],
    'root = Answer([a])\na = Md("Scripted account reads ran.", [1])',
  ]);
  // An account citation says where its source lives.
  const [cited] = citations(first.frames) as (Citation & {
    workspaceId?: string;
    workspaceName?: string;
  })[];
  assert(cited, 'the answer has no citations');
  assert.deepEqual(
    [cited.fileId, cited.workspaceId, cited.workspaceName],
    [memberText, shared, memberName]
  );
  const reads = await keptResults(run);
  const [summary] = kept(reads, 'search_files_summary');
  const [loosely, inShared] = kept(reads, 'list_sources');
  assert(summary?.includes(`file_id=${ownText}`), summary);
  assert(summary.includes(`file_id=${memberText}`), summary);
  assert(summary.includes(`file_id=${loose}, no workspace`), summary);
  // Edit rights: the viewer's file is view only, the owner's text editable.
  assert(
    summary.includes(`workspace_id=${shared}, view only`) &&
      summary.includes(`workspace_id=${own}, view and edit`),
    summary
  );
  assert(loosely?.startsWith('You did not name a workspace_id'), loosely);
  assert(loosely.includes(`file_id=${loose}`), loosely);
  assert(
    inShared?.startsWith(
      `The ${memberName} workspace (workspace_id=${shared})`
    ),
    inShared
  );
  assert(inShared.includes(`file_id=${memberText}`), inShared);

  // Turn 2: an edit of the owner's text file and one refused in the viewer's
  // workspace; creates in the owner's workspace, in no workspace and refused
  // in the viewer's; and a new workspace.
  const workspaceName = `UAT account made ${marker.slice(4, 12)}`;
  const second = await scripted(
    page,
    [
      [
        { arguments: { name: 'editing' }, name: 'read_skill' },
        { arguments: { name: 'note_building' }, name: 'read_skill' },
        {
          arguments: { target: { id: ownText, kind: 'source_file' } },
          name: 'inspect_document',
        },
        {
          arguments: { target: { id: memberText, kind: 'source_file' } },
          name: 'inspect_document',
        },
      ],
      [
        {
          arguments: {
            commands: [
              {
                expected_text: marker,
                text: `${marker} edited`,
                type: 'replace_text',
              },
            ],
            target: { id: ownText, kind: 'source_file' },
          },
          name: 'edit_document',
        },
        {
          arguments: {
            commands: [
              {
                expected_text: marker,
                text: `${marker} edited`,
                type: 'replace_text',
              },
            ],
            target: { id: memberText, kind: 'source_file' },
          },
          name: 'edit_document',
        },
        {
          arguments: {
            content: `In a workspace ${marker}.`,
            kind: 'note',
            title: 'Account note in a workspace',
            workspace_id: own,
          },
          name: 'create_material',
        },
        {
          arguments: {
            content: `With no workspace ${marker}.`,
            kind: 'note',
            title: 'Account note with no workspace',
          },
          name: 'create_material',
        },
      ],
      [
        {
          arguments: {
            content: `Not allowed ${marker}.`,
            kind: 'note',
            title: 'Account note refused',
            workspace_id: shared,
          },
          name: 'create_material',
        },
        {
          arguments: {
            description: `Made by account chat ${marker}`,
            name: workspaceName,
            tags: ['uat'],
          },
          name: 'create_workspace',
        },
      ],
      'root = Answer([a])\na = Md("Scripted account writes ran.")',
    ],
    { 5: 'refused', 8: 'refused' }
  );
  const inWorkspace = created(second.ends[6]);
  const noWorkspace = created(second.ends[7]);
  for (const [id, expected] of [
    [inWorkspace.id, own],
    [noWorkspace.id, null],
  ] as const) {
    const row = await materialRow(run, id);
    assert.deepEqual(
      [row.kind, row.workspace_id, row.created_by],
      ['note', expected, run.owner.id]
    );
  }
  // The new workspace: the owner's, named as asked, with its description.
  const made = await run.query(
    'SELECT id,description FROM workspaces WHERE user_id=%s AND name=%s',
    [run.owner.id, workspaceName]
  );
  assert.equal(made.length, 1);
  await run.record('workspace', string(made[0].id), { ownerId: run.owner.id });
  assert.equal(made[0].description, `Made by account chat ${marker}`);
  assert(
    kept(await keptResults(run), 'create_workspace')[0]?.includes(
      `workspace_id=${made[0].id}`
    )
  );
  // The edit is saved and waits unindexed (auto processing is off).
  await run.poll(
    'the edit pending',
    () =>
      run.query(
        'SELECT pending_effects FROM source_documents WHERE file_id=%s',
        [ownText]
      ),
    (rows) =>
      Array.isArray(rows[0]?.pending_effects) &&
      rows[0].pending_effects.length > 0
  );

  // Turn 3: a read of the edited, unindexed file carries its changes.
  await scripted(page, [
    [{ arguments: { file_id: ownText }, name: 'read_document' }],
    'root = Answer([a])\na = Md("Scripted account read ran.")',
  ]);
});
