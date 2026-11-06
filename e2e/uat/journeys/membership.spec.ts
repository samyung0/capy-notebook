import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { openWorkspaceSettings } from '../../helpers/workspace';
import { m } from '../../i18n';
import {
  api,
  fixture,
  invite,
  noProviderCalls,
  object,
  string,
  upload,
} from './files';
import {
  apiNote,
  contentText,
  lineAfter,
  lineMatch,
  notesWorkspace,
  openNote,
} from './note';
import {
  editOffice,
  openEditor,
  saved,
  savedFacts,
  saveOffice,
} from './office';
import { type Actor, expect, test, type UatRun } from './runtime';

// A member's role over time (openwiki/authorization-permissions-lifecycles.md):
// an editor saves a note line and a store-only DOCX edit from the browser, then
// the owner demotes them to viewer and removes them in the members UI. Each
// change closes only the member's own connections, with no notice, and the open
// editors reconnect with a fresh token (plate-editor.md, connection lifetime and
// refusals).
// The member's own upload stays charged to it after the removal, listed as
// lost access until it deletes it (uploader pays, Sam 2026-10-18). Then the
// workspace is shared with anyone with the link: the removed member reaches it
// only through the signed link, and loses it when the workspace goes private
// (Sam 2026-10-18). Store-only uploads and Auto process edits off: no provider
// call.
//
// A bystander, a second editor with the note and the DOCX open, stays connected
// and editable through all of it: a server closing the rooms would fail here. An
// editor who opened the note before is removed while typing, and stays on it,
// read-only under the strip; a demoted quiz editor ends read-only too. Those two
// strips need the client's reconnect work (Epo 2026-11-05, Q634).

/** editOffice's DOCX sentence for a collaborator. */
const SENTENCE = 'Collaborator confirmed the survey starts in July.';

const membership = (run: UatRun, workspaceId: string, userId: string) =>
  run.query(
    'SELECT role FROM workspace_members WHERE workspace_id=%s AND user_id=%s',
    [workspaceId, userId]
  );

/** A one-question quiz the owner creates through the API; returns its id. */
async function apiQuiz(run: UatRun, workspaceId: string, prompt: string) {
  const question = {
    children: [{ text: '' }],
    id: 'q_1',
    question: {
      id: 'q_1',
      labels: 'letters',
      layout: 'paper',
      parts: [
        {
          answer: { correct: true, type: 'boolean' },
          blocks: [{ text: prompt, type: 'text' }],
          id: 'q_1:part:1',
          marks: 1,
          solution: [],
        },
      ],
      stem: [],
    },
    type: 'quiz_question',
  };
  const created = object(
    await api(
      run.owner,
      `/api/workspaces/${workspaceId}/materials`,
      'POST',
      {
        content: {
          schemaVersion: 1,
          value: [{ children: [question], id: 'quiz_root', type: 'quiz' }],
        },
        kind: 'quiz',
        title: prompt,
      },
      201
    )
  );
  return string(created.id);
}

/** The account's stored plus reserved bytes. */
const usedBytes = async (actor: Actor) =>
  Number(object(object(await api(actor, '/api/me')).account).storageUsedBytes);

/** Whether the workspace is in the actor's workspace list. */
async function listed(actor: Actor, workspaceId: string) {
  const rows = (await api(actor, '/api/workspaces')) as unknown[];
  return rows.some((row) => object(row).id === workspaceId);
}

/**
 * The next collaboration token the page's own client gets at `path`: `read`
 * is a 201 read token, `refused` a 404. `asked` tells an editor's request (its
 * own access) from a View's read channel (`{access: 'read'}`).
 */
function browserToken(
  page: Page,
  path: string,
  asked: 'own' | 'read',
  outcome: 'read' | 'refused'
) {
  return page.waitForResponse(
    async (response) => {
      const request = response.request();
      if (
        request.method() !== 'POST' ||
        new URL(response.url()).pathname !== path ||
        (request.postData() ?? '').includes('"read"') !== (asked === 'read')
      )
        return false;
      if (outcome === 'refused') return response.status() === 404;
      return (
        response.status() === 201 &&
        object(await response.json()).access === 'read'
      );
    },
    { timeout: 120_000 }
  );
}

/**
 * The owner's members UI: Workspace settings → Sharing → the member's role
 * dropdown → View, or their trash. Returns the API's status.
 */
async function changeMember(
  run: UatRun,
  workspaceId: string,
  member: Actor,
  change: 'viewer' | 'remove'
) {
  const roster = (await api(
    run.owner,
    `/api/workspaces/${workspaceId}/members`
  )) as unknown[];
  const name = string(
    roster.map(object).find((row) => row.userId === member.id)?.name
  );
  const page = run.owner.page;
  await page.goto(`${run.env.appUrl}/workspaces/${workspaceId}`);
  await openWorkspaceSettings(page);
  const settings = page.getByRole('dialog', { name: m.workspace_settings() });
  await settings
    .getByRole('tab', { exact: true, name: m.workspace_sharing() })
    .click();
  const people = settings.getByRole('region', { name: m.members_people() });
  await people.getByText(name, { exact: true }).waitFor();
  const path = `/api/workspaces/${workspaceId}/members/${member.id}`;
  const method = change === 'remove' ? 'DELETE' : 'PATCH';
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === path && r.request().method() === method
  );
  if (change === 'remove') {
    await people
      .getByRole('button', {
        exact: true,
        name: m.members_remove_named({ name }),
      })
      .click();
    await page
      .getByRole('dialog', { name: m.members_remove_confirm_title({ name }) })
      .getByRole('button', { exact: true, name: m.action_remove() })
      .click();
  } else {
    await people
      .getByRole('combobox', { exact: true, name: m.members_role_of({ name }) })
      .click();
    await page
      .getByRole('option', { exact: true, name: m.members_role_view() })
      .click();
  }
  return (await response).status();
}

/**
 * The channels a frame of the collaboration protocol closes, each with its code
 * and reason: its messages are each a varint channel, a kind (4 is CLOSED) and a
 * varint-long payload, and a CLOSED's payload is a varint code and a string.
 */
function channelsClosed(frame: Buffer) {
  const closed: string[] = [];
  let at = 0;
  const varint = () => {
    let value = 0;
    let scale = 1;
    while (at < frame.length) {
      const byte = frame[at];
      at += 1;
      value += (byte % 128) * scale;
      scale *= 128;
      if (byte < 128) break;
    }
    return value;
  };
  while (at < frame.length) {
    const channel = varint();
    const kind = frame[at];
    at += 1;
    const end = varint() + at;
    if (kind === 4) {
      const code = varint();
      const length = varint();
      const reason = frame.toString('utf8', at, at + length);
      closed.push(`channel ${channel}: ${code} ${reason}`);
    }
    at = end;
  }
  return closed;
}

/** Listens to the page's collaboration sockets: frames heard, and every channel
 * or socket closed. Attach before the page opens its room. */
function watchRooms(run: UatRun, page: Page) {
  const watch = { closes: [] as string[], frames: 0 };
  const host = new URL(run.env.collabUrl).host;
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).host !== host) return;
    socket.on('framereceived', ({ payload }) => {
      watch.frames += 1;
      if (typeof payload !== 'string')
        watch.closes.push(...channelsClosed(payload));
    });
    socket.on('close', () => watch.closes.push('socket'));
  });
  return watch;
}

/** Types into the page's focused editor until the returned stop is called. */
function keepTyping(page: Page) {
  let typing = true;
  const done = (async () => {
    while (typing) {
      await page.keyboard.type('.');
      await page.waitForTimeout(250);
    }
  })();
  return () => {
    typing = false;
    return done;
  };
}

test('membership: an editor demoted to viewer has open note, Office and quiz editors turn read-only and keeps reading; an editor removed while typing stays on its note read-only; removed, loses the workspace, its tokens and its open room, deletes what it uploaded and comes back only through the signed link; a second editor stays connected and editable throughout', async ({
  run,
}) => {
  test.setTimeout(1_200_000);
  const workspaceId = await notesWorkspace(run, 'membership');
  const marker = `UAT${randomUUID().replaceAll('-', '')}`;
  const body = `Membership ${marker}`;
  const memberLine = `Member ${marker}`;
  const bystanderLine = `Bystander ${marker}`;
  const typistLine = `Typist ${marker}`;
  const bystanderSentence = `Bystander ${marker} kept editing.`;
  const noteId = await apiNote(run, workspaceId, body);
  const quizId = await apiQuiz(run, workspaceId, `Quiz ${marker}`);
  const fileId = await upload(
    run,
    workspaceId,
    'lesson.docx',
    await fixture('lesson.docx', marker),
    true
  );
  const member = await run.createActor('member');
  await invite(run, workspaceId, member, 'editor');
  // The member uploads a small store-only file there and pays for it.
  const baseline = await usedBytes(member);
  const leftBehindName = 'left-behind.bin';
  const leftBehind = Buffer.from(`Left behind ${marker}`);
  const memberFile = await upload(
    run,
    workspaceId,
    leftBehindName,
    leftBehind,
    false,
    member
  );
  expect(await usedBytes(member)).toBe(baseline + leftBehind.length);
  const noteToken = `/api/materials/${noteId}/collaboration-token`;
  const fileToken = `/api/files/${fileId}/collaboration-token`;
  const quizToken = `/api/materials/${quizId}/collaboration-token`;

  // 1. Editor: write tokens; a DOCX sentence and a note line saved from the
  // browser, both editors left open (the DOCX in a second tab).
  expect(
    object(await api(member, `/api/workspaces/${workspaceId}`))
  ).toMatchObject({ capabilities: { canEdit: true }, role: 'editor' });
  assert(await listed(member, workspaceId));
  for (const path of [noteToken, fileToken, quizToken])
    expect(object(await api(member, path, 'POST', undefined, 201)).access).toBe(
      'write'
    );
  const office: Actor = { ...member, page: await member.context.newPage() };
  const frame = await openEditor(run, office, workspaceId, fileId, 'docx');
  await editOffice(office, frame, 'docx', true);
  await savedFacts(run, fileId, [SENTENCE]);
  // Saved before the demotion below closes this connection.
  await saved(office.page);
  const editor = await openNote(run, member, workspaceId, noteId);
  await lineAfter(member.page, editor, body);
  await member.page.keyboard.type(memberLine);
  await run.poll(
    'the saved note holds the member line',
    () => contentText(run, noteId),
    (text) => text.includes(memberLine)
  );
  const quizTab = await member.context.newPage();
  await quizTab.goto(
    `${run.env.appUrl}/workspaces/${workspaceId}?material=${quizId}`
  );
  await expect(quizTab.locator('[data-question-row="q_1"]')).toBeVisible({
    timeout: 60_000,
  });

  // The bystander: a second editor on the note and the DOCX.
  const bystander = await run.createActor('bystander');
  await invite(run, workspaceId, bystander, 'editor');
  const bystanderOffice: Actor = {
    ...bystander,
    page: await bystander.context.newPage(),
  };
  const noteRooms = watchRooms(run, bystander.page);
  const officeRooms = watchRooms(run, bystanderOffice.page);
  const bystanderFrame = await openEditor(
    run,
    bystanderOffice,
    workspaceId,
    fileId,
    'docx'
  );
  const bystanderEditor = await openNote(run, bystander, workspaceId, noteId);
  const bystanderTypes = async (after: string, line: string) => {
    await lineAfter(bystander.page, bystanderEditor, after);
    await bystander.page.keyboard.type(line);
    await run.poll(
      `the saved note holds "${line}"`,
      () => contentText(run, noteId),
      (text) => text.includes(line)
    );
  };
  await bystanderTypes(body, bystanderLine);

  // An editor who has opened the note before, on it again and typing.
  const typist = await run.createActor('typist');
  await invite(run, workspaceId, typist, 'editor');
  await lineAfter(
    typist.page,
    await openNote(run, typist, workspaceId, noteId),
    body
  );
  await typist.page.keyboard.type(typistLine);
  await run.poll(
    'the saved note holds the typist line',
    () => contentText(run, noteId),
    (text) => text.includes(typistLine)
  );
  await lineAfter(
    typist.page,
    await openNote(run, typist, workspaceId, noteId),
    typistLine
  );

  // From here on, nothing closes under the bystander.
  noteRooms.closes.length = 0;
  officeRooms.closes.length = 0;

  // 2. Demoted to viewer: each open editor reconnects on a read token and
  // drops to View under the read-only strip; the note's View joins its room
  // on a read channel. The member still reads but cannot write.
  const noteReadOnly = browserToken(member.page, noteToken, 'own', 'read');
  const officeReadOnly = browserToken(office.page, fileToken, 'own', 'read');
  const viewJoined = browserToken(member.page, noteToken, 'read', 'read');
  expect(await changeMember(run, workspaceId, member, 'viewer')).toBe(204);
  await Promise.all([noteReadOnly, officeReadOnly, viewJoined]);
  for (const page of [member.page, office.page])
    await expect(page.getByText(m.editor_read_only_strip())).toBeVisible();
  await expect(member.page.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(
    member.page.getByText(memberLine, { exact: true })
  ).toBeVisible();
  // The quiz: no editing rows, the question still reads, under the strip.
  await expect(quizTab.locator('[data-question-row]')).toHaveCount(0, {
    timeout: 120_000,
  });
  await expect(quizTab.locator('[data-question-id="q_1"]')).toBeVisible();
  await expect(quizTab.getByText(m.editor_read_only_strip())).toBeVisible();
  expect(await membership(run, workspaceId, member.id)).toEqual([
    { role: 'viewer' },
  ]);
  expect(
    object(await api(member, `/api/workspaces/${workspaceId}`))
  ).toMatchObject({
    capabilities: { canEdit: false, canManageMembers: false, canView: true },
    role: 'viewer',
  });
  const read = object(await api(member, `/api/materials/${noteId}`));
  expect(read.capabilities).toMatchObject({ canEdit: false, canView: true });
  assert(JSON.stringify(read.content).includes(memberLine));
  await api(member, `/api/files/${fileId}`);
  for (const path of [noteToken, fileToken, quizToken])
    expect(object(await api(member, path, 'POST', undefined, 201)).access).toBe(
      'read'
    );
  // A viewer's content write: the material's 403 (sharing e2e).
  await api(
    member,
    `/api/materials/${noteId}/metadata`,
    'PATCH',
    { title: `Viewer ${marker}` },
    403
  );
  await office.page.close();
  await quizTab.close();
  await bystanderTypes(bystanderLine, `Demoted ${marker}`);

  // 3. Removed while typing: the room closes on them and their rejoin is refused
  // at the token, and they stay on the note, read-only under the strip.
  const stopTyping = keepTyping(typist.page);
  expect(await changeMember(run, workspaceId, typist, 'remove')).toBe(204);
  await expect(typist.page.getByText(m.editor_access_lost())).toBeVisible({
    timeout: 120_000,
  });
  await stopTyping();
  await expect(typist.page.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(typist.page.getByText(lineMatch(typistLine))).toBeVisible();
  expect(await membership(run, workspaceId, typist.id)).toEqual([]);
  await api(typist, noteToken, 'POST', undefined, 404);
  await api(typist, `/api/materials/${noteId}`, 'GET', undefined, 404);

  // 4. Removed: the open View's room closes and its rejoin is refused; every
  // read, token and write answers the non-disclosing 404.
  const viewRefused = browserToken(member.page, noteToken, 'read', 'refused');
  expect(await changeMember(run, workspaceId, member, 'remove')).toBe(204);
  await viewRefused;
  expect(await membership(run, workspaceId, member.id)).toEqual([]);
  const refused: Array<[string, string, unknown?]> = [
    ['GET', `/api/workspaces/${workspaceId}`],
    ['GET', `/api/workspaces/${workspaceId}/members`],
    ['GET', `/api/materials/${noteId}`],
    ['GET', `/api/files/${fileId}`],
    ['GET', `/api/files/${memberFile}`],
    ['POST', noteToken],
    ['POST', fileToken],
    ['POST', quizToken],
    ['PATCH', `/api/materials/${noteId}/metadata`, { title: `Gone ${marker}` }],
  ];
  for (const [method, path, payload] of refused)
    await api(member, path, method, payload, 404);
  assert(!(await listed(member, workspaceId)));
  // Both changes reach the member in the app only: the invite is its one email.
  const mail = await run.query(
    'SELECT template FROM email_outbox WHERE user_id=%s OR to_email=%s',
    [member.id, member.email]
  );
  assert.deepEqual(
    mail.map((row) => row.template),
    ['workspace-invite']
  );
  const notifications = object(await api(member, '/api/notifications'))
    .items as unknown[];
  expect(
    notifications
      .map(object)
      .filter(
        (item) =>
          (item.data as { workspaceId?: unknown } | null)?.workspaceId ===
          workspaceId
      )
      .map((item) => item.kind)
  ).toEqual(
    expect.arrayContaining([
      'workspace_role_changed',
      'workspace_member_removed',
    ])
  );

  // What the member saved while an editor stays.
  assert((await contentText(run, noteId)).includes(memberLine));
  await savedFacts(run, fileId, [SENTENCE]);

  // The bystander heard no close through it all, with no strip, and still edits
  // both, with its write tokens.
  await bystanderTypes(`Demoted ${marker}`, `Removed ${marker}`);
  const input = bystanderFrame.getByRole('textbox', { name: 'Document input' });
  await input.focus();
  await input.press('ControlOrMeta+End');
  await input.press('Enter');
  await input.pressSequentially(bystanderSentence);
  await saveOffice(bystanderOffice.page, 'docx');
  await savedFacts(run, fileId, [SENTENCE, bystanderSentence]);
  for (const rooms of [noteRooms, officeRooms]) {
    expect(rooms.frames).toBeGreaterThan(0);
    expect(rooms.closes).toEqual([]);
  }
  for (const page of [bystander.page, bystanderOffice.page]) {
    await expect(page.getByText(m.editor_read_only_strip())).toHaveCount(0);
    await expect(page.getByText(m.editor_access_lost())).toHaveCount(0);
  }
  await expect(bystanderEditor).toBeVisible();
  for (const path of [noteToken, fileToken])
    expect(
      object(await api(bystander, path, 'POST', undefined, 201)).access
    ).toBe('write');
  expect(await membership(run, workspaceId, bystander.id)).toEqual([
    { role: 'editor' },
  ]);

  // 5. The member still pays for its upload: its Files page lists it as lost
  // access (name and size only), and it deletes it, trash then purge, which
  // gives the bytes back.
  const { items: files } = object(await api(member, '/api/files')) as {
    items: Record<string, unknown>[];
  };
  expect(files.find((file) => file.id === memberFile)).toMatchObject({
    lostAccess: true,
    name: leftBehindName,
    sizeBytes: leftBehind.length,
  });
  await member.page.goto(`${run.env.appUrl}/files`);
  await expect(
    member.page
      .locator('[data-item]')
      .filter({ hasText: leftBehindName })
      .getByTitle(m.files_lost_access())
  ).toBeVisible();
  await api(member, `/api/files/${memberFile}`, 'DELETE', undefined, 204);
  const { items: trash } = object(await api(member, '/api/trash')) as {
    items: Record<string, unknown>[];
  };
  const trashed = object(trash.find((item) => item.id === memberFile));
  expect(trashed).toMatchObject({ canRestore: false, lostAccess: true });
  await api(
    member,
    `/api/trash/source_file/${memberFile}?episodeId=${encodeURIComponent(string(trashed.episodeId))}&requestId=${randomUUID()}`,
    'DELETE'
  );
  expect(await usedBytes(member)).toBe(baseline);

  // 6. Shared with anyone with the link: the bare id is not enough for an
  // account that never presented the link; the summary page's Open presents
  // it once and the workspace reads by id from then on. Making it private
  // clears that grant, so a new link share needs the link again.
  const sharing = `/api/workspaces/${workspaceId}/sharing`;
  const sharePath = string(
    object(await api(run.owner, sharing, 'PATCH', { privacy: 'link' }))
      .sharePath
  );
  await api(member, `/api/workspaces/${workspaceId}`, 'GET', undefined, 404);
  await member.page.goto(`${run.env.appUrl}${sharePath}`);
  const redeemed = member.page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/share/redeem' &&
      response.request().method() === 'POST'
  );
  await member.page.getByRole('link', { name: m.summary_open() }).click();
  const redemption = await redeemed;
  expect(redemption.status()).toBe(200);
  expect(object(await redemption.json())).toMatchObject({
    id: workspaceId,
    kind: 'workspace',
  });
  await expect(member.page).toHaveURL(
    (url) => url.pathname === `/workspaces/${workspaceId}`
  );
  const visitor = object(await api(member, `/api/workspaces/${workspaceId}`));
  expect(visitor.role).toBeUndefined();
  expect(visitor.capabilities).toMatchObject({ canEdit: false, canView: true });
  await api(member, `/api/materials/${noteId}`);
  await api(run.owner, sharing, 'PATCH', { privacy: 'private' });
  await api(member, `/api/workspaces/${workspaceId}`, 'GET', undefined, 404);
  await api(run.owner, sharing, 'PATCH', { privacy: 'link' });
  await api(member, `/api/workspaces/${workspaceId}`, 'GET', undefined, 404);
  await run.attach(`${workspaceId}-membership`, {
    bystanderId: bystander.id,
    fileId,
    memberFile,
    memberId: member.id,
    noteId,
    quizId,
    typistId: typist.id,
  });
  await noProviderCalls(run, workspaceId);
});
