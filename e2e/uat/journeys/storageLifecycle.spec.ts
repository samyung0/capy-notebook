/* biome-ignore-all lint/suspicious/noMisplacedAssertion: The helpers execute only inside the journey. */
// Account lifecycle over the storage limit (openwiki/authorization-permissions-lifecycles.md,
// "Account lifecycle gates"; openwiki/backend-storage-quota.md). A Pro owner
// stores more than the Free limit, lapses and is frozen, resubscribes, lapses
// again into grace and frees space back to active, all through real Stripe
// subscriptions and webhooks. The app compares Stripe's timestamps, which
// follow the test clock, with real time:
// - the clock starts 21 days back, so a monthly period started then still ends
//   in the real future (Pro is live at once, no renewal needed), while a
//   cancellation at that clock time is a lapse 21 days old: frozen, its 14-day
//   grace ended a week ago;
// - a second subscription on the same clock is live again (active), and the
//   clock moved to 3 days back makes its cancellation a lapse inside grace.
// The latest closure wins (applyQuotaState takes the max over closed Pro rows),
// so one account goes frozen, active, grace, active. Uploader pays (Sam
// 2026-10-18): the creator pays for a note wherever it sits, freezing and a
// full account narrow only what that account pays for, and a workspace carries
// no storage state.
// Ballast files are store-only (unknown format, no ingest job), and both
// workspaces have Auto process edits off: no parser, embedding or model call.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { m } from '../../i18n';
import {
  api,
  fileRow,
  invite,
  noProviderCalls,
  object,
  string,
  upload,
} from './files';
import {
  contentText,
  lineAfter,
  materialRow,
  notesWorkspace,
  openNote,
} from './note';
import {
  advanceStripeClock,
  cleanupStripeTestClock,
  stringField,
  stripePeriodEnd,
  stripeRequest,
  verifyStripeSandbox,
} from './providers';
import { type Actor, expect, test, type UatRun } from './runtime';

const DAY = 86_400;
/** plan_limits (server/migrations/0001_init.sql). */
const FREE_STORAGE = 100_000_000;
const PRO_STORAGE = 1_000_000_000;
const FREE_FILE = 10 * 1024 * 1024;
const PRO_FILE = 30 * 1024 * 1024;
/** overQuotaBufferDays (server/internal/store/account_state.go). */
const GRACE_DAYS = 14;
/** Four files put the owner over the Free limit; with one purged it is under. */
const BALLAST = 26_000_000;

type Account = {
  state: string;
  planTier: string;
  storageUsedBytes: number;
  storageLimitBytes: number;
  storageUsage: string;
  graceEndsAt?: string;
};

const account = async (actor: Actor) =>
  object(object(await api(actor, '/api/me')).account) as Account;

const waitForState = (run: UatRun, actor: Actor, state: string) =>
  run.poll(
    `account ${state}`,
    () => account(actor),
    (value) => value.state === state,
    120_000
  );

/** A 403 with the machine code `code`; returns its details, if any. */
async function refused(
  actor: Actor,
  path: string,
  method: string,
  body: unknown,
  code: string
) {
  const response = await actor.request(path, method, body);
  const detail = `${method} ${path}: ${JSON.stringify(response.body)}`;
  assert.equal(response.status, 403, detail);
  const { errors } = object(response.body);
  assert(Array.isArray(errors) && errors.length === 1, detail);
  const error = object(errors[0]);
  assert.equal(error.message, code, detail);
  return error.value == null ? undefined : object(error.value);
}

/** The material room token's access: `write`, or `read` for view only. */
const roomAccess = async (actor: Actor, materialId: string) =>
  string(
    object(
      await api(
        actor,
        `/api/materials/${materialId}/collaboration-token`,
        'POST',
        undefined,
        201
      )
    ).access
  );

async function workspaceAccess(actor: Actor, workspaceId: string) {
  const body = object(await api(actor, `/api/workspaces/${workspaceId}`));
  const { canEdit, canEditContent } = object(body.capabilities);
  return { canEdit, canEditContent };
}

/** A material's capabilities and whose full storage makes it view-only. */
async function materialAccess(actor: Actor, materialId: string) {
  const body = object(await api(actor, `/api/materials/${materialId}`));
  const { canEdit, canEditContent } = object(body.capabilities);
  return { canEdit, canEditContent, storageFull: body.storageFull };
}

const fileCap = async (actor: Actor, workspaceId: string) =>
  object(
    await api(actor, `/api/source-upload-policy?workspaceId=${workspaceId}`)
  ).maxBytes;

async function createNote(
  actor: Actor,
  workspaceId: string,
  title: string,
  line: string
) {
  return string(
    object(
      await api(
        actor,
        `/api/workspaces/${workspaceId}/materials`,
        'POST',
        {
          content: {
            schemaVersion: 1,
            value: [{ children: [{ text: line }], id: 'body', type: 'p' }],
          },
          kind: 'note',
          title,
        },
        201
      )
    ).id
  );
}

/** A comment without an anchor, as the Go gate tests send. */
const comment = {
  anchorVersion: 1,
  contentRich: [{ children: [{ text: 'Margin note' }], type: 'p' }],
};

/** A 1 KiB store-only upload's ticket request, under the Free per-file cap
 * so only the lifecycle or storage gate can refuse it: the ticket runs the
 * upload's gates before it waits in the gateway's line. */
const probe = () => ({
  batchId: randomUUID(),
  batchTotal: 1,
  contentType: 'application/octet-stream',
  name: 'probe.bin',
  parseMode: 'none',
  sizeBytes: 1024,
});

/** The file's first bytes through its signed read link (a ranged GET). */
async function downloadHead(actor: Actor, fileId: string, length: number) {
  const links = object(await api(actor, `/api/files/${fileId}/links`));
  const response = await fetch(string(links.url), {
    headers: { Range: `bytes=0-${length - 1}` },
    signal: AbortSignal.timeout(30_000),
  });
  // Signed links never reach a message or evidence.
  assert(response.ok && response.body, `signed read ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < length) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel();
  return Buffer.concat(chunks).subarray(0, length);
}

/** Asking for Edit, a read-only note opens in its read view: the text, no
 * editable surface and no mode toggle. */
async function readOnlyNote(
  run: UatRun,
  actor: Actor,
  workspaceId: string,
  noteId: string,
  line: string
) {
  const { page } = actor;
  await page.goto(
    `${run.env.appUrl}/workspaces/${workspaceId}?material=${noteId}&mode=edit`
  );
  await expect(page.getByText(line, { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: m.material_mode() })
  ).toHaveCount(0);
}

/** Types `line` under `after` in the live editor, then leaves the note. */
async function typeLine(
  run: UatRun,
  actor: Actor,
  workspaceId: string,
  noteId: string,
  after: string,
  line: string
) {
  const editor = await openNote(run, actor, workspaceId, noteId);
  await lineAfter(actor.page, editor, after);
  await actor.page.keyboard.type(line);
  await expect(editor.getByText(line, { exact: true })).toBeVisible();
}

const subscriptionRow = (run: UatRun, subscriptionId: string) =>
  run.query<{ status: string; plan_tier: string; ended: number | null }>(
    `SELECT status,plan_tier,extract(epoch FROM ended_at)::bigint AS ended
    FROM user_subscriptions WHERE stripe_subscription_id=%s`,
    [subscriptionId]
  );

/** A Pro subscription on the clock's customer, live in real time. */
async function subscribe(
  run: UatRun,
  clockId: string,
  customerId: string,
  step: string
) {
  const owner = run.owner;
  const subscription = await stripeRequest(
    run.env,
    '/v1/subscriptions',
    'POST',
    {
      customer: customerId,
      'items[0][price]': run.env.stripePriceId,
      'metadata[capyUatRunId]': run.id,
      'metadata[user_id]': owner.id,
      payment_behavior: 'error_if_incomplete',
    },
    `${run.id}-${owner.id}-quota-${step}`
  );
  const id = stringField(subscription, 'id');
  await run.record('stripe-subscription', id, {
    clockId,
    customerId,
    userId: owner.id,
  });
  expect(subscription.status).toBe('active');
  expect(subscription.livemode).toBe(false);
  // Pro is live only while its period ends after real now.
  expect(stripePeriodEnd(subscription)).toBeGreaterThan(
    Date.now() / 1000 + DAY
  );
  await run.poll(
    `${step} subscription webhook`,
    () => subscriptionRow(run, id),
    (rows) => rows[0]?.status === 'active' && rows[0].plan_tier === 'pro',
    120_000
  );
  return id;
}

/** Cancels at once, at the clock's time, and returns that lapse. */
async function cancelNow(run: UatRun, clockId: string, subscriptionId: string) {
  const clock = await stripeRequest(
    run.env,
    `/v1/test_helpers/test_clocks/${clockId}`
  );
  const at = clock.frozen_time;
  assert(typeof at === 'number');
  const canceled = await stripeRequest(
    run.env,
    `/v1/subscriptions/${subscriptionId}`,
    'DELETE'
  );
  expect(canceled.status).toBe('canceled');
  // The lapse the app derives is this clock-stamped end.
  expect(canceled.ended_at).toBe(at);
  const [row] = await run.poll(
    'cancellation webhook',
    () => subscriptionRow(run, subscriptionId),
    (rows) => rows[0]?.status === 'canceled',
    120_000
  );
  // The closed row keeps its paid tier: only a paid lapse leads to grace.
  expect(row).toMatchObject({ ended: at, plan_tier: 'pro' });
  return at;
}

test('storage lifecycle: a lapsed Pro owner over the Free limit is frozen, resubscribes, lapses into grace and frees space back to active', async ({
  run,
}) => {
  test.setTimeout(1_200_000);
  const owner = run.owner;
  const price = await verifyStripeSandbox(run.env);
  // The clock offsets above assume a monthly period.
  expect(object(price.recurring)).toMatchObject({
    interval: 'month',
    interval_count: 1,
  });
  const member = await run.createActor('quota-member');
  const marker = `UAT${randomUUID().replaceAll('-', '')}`;
  const paidLine = `Paid by the owner ${marker}`;
  const memberLine = `Paid by the member ${marker}`;

  // 1. The owner's workspace and note, with the member as editor; the
  // member's own workspace and note, with the owner as editor.
  const ownerWs = await notesWorkspace(run, 'quota owner');
  const noteId = await createNote(owner, ownerWs, 'Owner note', paidLine);
  await invite(run, ownerWs, member, 'editor');
  const memberWs = string(
    object(
      await api(
        member,
        '/api/workspaces',
        'POST',
        { name: `UAT quota member ${marker.slice(3, 11)}` },
        201
      )
    ).id
  );
  await run.record('workspace', memberWs, { ownerId: member.id });
  await api(member, `/api/workspaces/${memberWs}`, 'PATCH', {
    autoProcess: false,
  });
  const memberNote = await createNote(
    member,
    memberWs,
    'Member note',
    memberLine
  );
  await invite(run, memberWs, owner, 'editor', member);

  // 2. Pro on a clock 21 days back, live at once.
  const clockName = `capy-uat-${run.id}`;
  await run.record('stripe-clock-intent', clockName, { userId: owner.id });
  const clock = await stripeRequest(
    run.env,
    '/v1/test_helpers/test_clocks',
    'POST',
    {
      frozen_time: String(Math.floor(Date.now() / 1000) - 21 * DAY),
      name: clockName,
    },
    `${run.id}-quota-clock`
  );
  const clockId = stringField(clock, 'id');
  await run.record('stripe-clock', clockId, {
    name: clockName,
    userId: owner.id,
  });
  const customer = await stripeRequest(
    run.env,
    '/v1/customers',
    'POST',
    {
      email: owner.email,
      'metadata[capyUatRunId]': run.id,
      'metadata[user_id]': owner.id,
      source: 'tok_visa',
      test_clock: clockId,
    },
    `${run.id}-${owner.id}-quota-customer`
  );
  const customerId = stringField(customer, 'id');
  await run.record('stripe-customer', customerId, {
    clockId,
    userId: owner.id,
  });
  const first = await subscribe(run, clockId, customerId, 'first');
  const pro = await waitForState(run, owner, 'active');
  expect(pro).toMatchObject({
    planTier: 'pro',
    storageLimitBytes: PRO_STORAGE,
  });
  expect(await fileCap(owner, ownerWs)).toBe(PRO_FILE);

  // 3. Store-only ballast past the Free limit.
  const ballast: { id: string; head: Buffer }[] = [];
  for (let index = 1; index <= 4; index++) {
    const bytes = randomBytes(BALLAST);
    const id = await upload(run, ownerWs, `ballast-${index}.bin`, bytes);
    const row = await fileRow(run, id);
    expect(row).toMatchObject({ parse_mode: 'none', status: 'ready' });
    ballast.push({ head: bytes.subarray(0, 64), id });
  }
  const ballastIds = ballast.map((file) => file.id);
  expect(
    await run.query(
      "SELECT count(*)::int AS jobs FROM jobs WHERE payload->>'fileId'=ANY(%s::text[])",
      [ballastIds]
    )
  ).toEqual([{ jobs: 0 }]);
  const filled = await account(owner);
  expect(filled).toMatchObject({ planTier: 'pro', state: 'active' });
  expect(filled.storageUsedBytes).toBeGreaterThan(FREE_STORAGE);

  // 4. Canceled at the clock's time, 21 days back: frozen.
  const frozenLapse = await cancelNow(run, clockId, first);
  const frozen = await waitForState(run, owner, 'over_quota_frozen');
  expect(frozen).toMatchObject({
    planTier: 'free',
    storageLimitBytes: FREE_STORAGE,
    storageUsage: 'full',
  });
  expect(Date.parse(string(frozen.graceEndsAt))).toBe(
    (frozenLapse + GRACE_DAYS * DAY) * 1000
  );
  expect(Date.parse(string(frozen.graceEndsAt))).toBeLessThan(Date.now());
  expect((await account(member)).state).toBe('active');

  // The note is read-only for its owner and its editor in the browser.
  await readOnlyNote(run, owner, ownerWs, noteId, paidLine);
  await readOnlyNote(run, member, ownerWs, noteId, paidLine);
  // Reading and downloading stay.
  await api(owner, `/api/materials/${noteId}`);
  await api(owner, `/api/files/${ballast[0].id}`);
  expect(await downloadHead(owner, ballast[0].id, 64)).toEqual(ballast[0].head);
  // Freezing is per item: the frozen owner edits nowhere, the member keeps
  // editing its workspace role.
  expect(await workspaceAccess(owner, ownerWs)).toEqual({
    canEdit: false,
    canEditContent: false,
  });
  expect(await workspaceAccess(member, ownerWs)).toEqual({
    canEdit: true,
    canEditContent: true,
  });
  await refused(
    owner,
    `/api/workspaces/${ownerWs}/materials`,
    'POST',
    { kind: 'note', title: 'Frozen growth' },
    'account_over_quota'
  );
  // The member's note there is the member's to pay for and edit.
  const frozenNote = await createNote(
    member,
    ownerWs,
    'Frozen growth',
    `Added while frozen ${marker}`
  );
  expect(await materialRow(run, frozenNote)).toMatchObject({
    created_by: member.id,
    owner_user_id: member.id,
  });
  expect(await roomAccess(member, frozenNote)).toBe('write');
  // Nobody edits what the frozen owner pays for.
  for (const actor of [owner, member]) {
    expect(await roomAccess(actor, noteId)).toBe('read');
    await refused(
      actor,
      `/api/materials/${noteId}/discussions`,
      'POST',
      comment,
      'account_over_quota'
    );
    // Chat stays open (a new thread; no model is called).
    await api(
      actor,
      `/api/workspaces/${ownerWs}/conversations`,
      'POST',
      { title: 'Frozen chat' },
      201
    );
  }
  // The frozen owner edits nowhere: not even where the member pays.
  expect(await workspaceAccess(owner, memberWs)).toEqual({
    canEdit: false,
    canEditContent: false,
  });
  expect(await roomAccess(owner, memberNote)).toBe('read');
  await refused(
    owner,
    `/api/workspaces/${memberWs}/materials`,
    'POST',
    { kind: 'note', title: 'Frozen elsewhere' },
    'account_over_quota'
  );
  await refused(
    owner,
    `/api/materials/${memberNote}/discussions`,
    'POST',
    comment,
    'account_over_quota'
  );
  // The member still edits what the member pays for.
  expect(await roomAccess(member, memberNote)).toBe('write');
  // No uploads, workspaces, organizing or widening; Free caps apply.
  expect(await fileCap(owner, ownerWs)).toBe(FREE_FILE);
  await refused(
    owner,
    `/api/workspaces/${ownerWs}/sources/uploads/tickets`,
    'POST',
    probe(),
    'account_over_quota'
  );
  await refused(
    owner,
    '/api/workspaces',
    'POST',
    { name: 'UAT frozen' },
    'account_over_quota'
  );
  await refused(
    owner,
    `/api/files/${ballast[0].id}`,
    'PATCH',
    { name: 'ballast-renamed.bin' },
    'account_over_quota'
  );
  await refused(
    owner,
    `/api/workspaces/${ownerWs}/sharing`,
    'PATCH',
    { privacy: 'link' },
    'account_over_quota'
  );
  await refused(
    owner,
    `/api/workspaces/${ownerWs}/invites`,
    'POST',
    { identifier: member.id, role: 'viewer' },
    'account_over_quota'
  );
  // Demoting narrows exposure and stays; promoting back widens it.
  await api(
    owner,
    `/api/workspaces/${ownerWs}/members/${member.id}`,
    'PATCH',
    { role: 'viewer' },
    204
  );
  await refused(
    owner,
    `/api/workspaces/${ownerWs}/members/${member.id}`,
    'PATCH',
    { role: 'editor' },
    'account_over_quota'
  );
  // Trashing stays, and a trashed file is still charged.
  await api(owner, `/api/files/${ballast[3].id}`, 'DELETE', undefined, 204);
  expect((await fileRow(run, ballast[3].id)).trashed_at).toBeTruthy();
  expect(await account(owner)).toMatchObject({
    state: 'over_quota_frozen',
    storageUsedBytes: frozen.storageUsedBytes,
  });

  // 5. Resubscribed on the same clock: active, editing again for both.
  const second = await subscribe(run, clockId, customerId, 'second');
  const resubscribed = await waitForState(run, owner, 'active');
  expect(resubscribed).toMatchObject({
    planTier: 'pro',
    storageLimitBytes: PRO_STORAGE,
  });
  expect(resubscribed.graceEndsAt).toBeUndefined();
  await api(
    owner,
    `/api/workspaces/${ownerWs}/members/${member.id}`,
    'PATCH',
    { role: 'editor' },
    204
  );
  for (const actor of [owner, member]) {
    expect(await workspaceAccess(actor, ownerWs)).toEqual({
      canEdit: true,
      canEditContent: true,
    });
    expect(await roomAccess(actor, noteId)).toBe('write');
  }
  expect(await roomAccess(owner, memberNote)).toBe('write');
  const ownerLine = `Owner again ${marker}`;
  const editorLine = `Editor again ${marker}`;
  await typeLine(run, owner, ownerWs, noteId, paidLine, ownerLine);
  await typeLine(run, member, ownerWs, noteId, ownerLine, editorLine);
  await run.poll(
    'the saved note holds both lines',
    () => contentText(run, noteId),
    (text) => text.includes(ownerLine) && text.includes(editorLine)
  );
  await api(
    member,
    `/api/materials/${noteId}/discussions`,
    'POST',
    comment,
    201
  );
  // No live editor while the account lapses again.
  for (const actor of [owner, member])
    await actor.page.goto(`${run.env.appUrl}/workspaces`);

  // 6. The clock 3 days back, canceled again: grace.
  await advanceStripeClock(
    run,
    clockId,
    Math.floor(Date.now() / 1000) - 3 * DAY
  );
  const graceLapse = await cancelNow(run, clockId, second);
  const grace = await waitForState(run, owner, 'over_quota_grace');
  expect(grace).toMatchObject({
    planTier: 'free',
    storageLimitBytes: FREE_STORAGE,
    storageUsage: 'full',
  });
  expect(Date.parse(string(grace.graceEndsAt))).toBe(
    (graceLapse + GRACE_DAYS * DAY) * 1000
  );
  expect(Date.parse(string(grace.graceEndsAt))).toBeGreaterThan(Date.now());
  // Storage growth fails the quota against the Free limit.
  const quota = await refused(
    owner,
    `/api/workspaces/${ownerWs}/sources/uploads/tickets`,
    'POST',
    probe(),
    'storage_quota_exceeded'
  );
  expect(quota).toMatchObject({
    ownerUserId: owner.id,
    storageLimitBytes: FREE_STORAGE,
  });
  // The owner's content is view-only for everyone (storageFull names whose
  // storage is full); organizing goes on and the workspace stays editable.
  for (const [actor, storageFull] of [
    [owner, 'self'],
    [member, 'payer'],
  ] as const) {
    expect(await workspaceAccess(actor, ownerWs)).toEqual({
      canEdit: true,
      canEditContent: true,
    });
    expect(await materialAccess(actor, noteId)).toEqual({
      canEdit: true,
      canEditContent: false,
      storageFull,
    });
    expect(await roomAccess(actor, noteId)).toBe('read');
    await refused(
      actor,
      `/api/materials/${noteId}/discussions`,
      'POST',
      comment,
      'storage_quota_exceeded'
    );
  }
  // A note is charged to its creator: the owner's is refused, the member's
  // is created on its own quota.
  await refused(
    owner,
    `/api/workspaces/${ownerWs}/materials`,
    'POST',
    { kind: 'note', title: 'Grace growth' },
    'storage_quota_exceeded'
  );
  const graceGrowth = await createNote(
    member,
    ownerWs,
    'Grace growth',
    `Added in grace ${marker}`
  );
  expect(await materialRow(run, graceGrowth)).toMatchObject({
    created_by: member.id,
    owner_user_id: member.id,
  });
  // Where the member pays, the owner in grace still edits; a note it adds
  // there is its own, so it fails the owner's quota.
  expect(await workspaceAccess(owner, memberWs)).toEqual({
    canEdit: true,
    canEditContent: true,
  });
  expect(await roomAccess(owner, memberNote)).toBe('write');
  expect(
    await refused(
      owner,
      `/api/workspaces/${memberWs}/materials`,
      'POST',
      { kind: 'note', title: 'Grace note' },
      'storage_quota_exceeded'
    )
  ).toMatchObject({ ownerUserId: owner.id, storageLimitBytes: FREE_STORAGE });
  const graceLine = `Owner in grace ${marker}`;
  await typeLine(run, owner, memberWs, memberNote, memberLine, graceLine);
  await run.poll(
    "the member's note holds the owner's grace line",
    () => contentText(run, memberNote),
    (text) => text.includes(graceLine)
  );
  await owner.page.goto(`${run.env.appUrl}/workspaces`);
  // A workspace stores nothing, so the owner can create one.
  const graceWs = string(
    object(
      await api(
        owner,
        '/api/workspaces',
        'POST',
        { name: `UAT grace ${marker.slice(3, 11)}` },
        201
      )
    ).id
  );
  await run.record('workspace', graceWs, { ownerId: owner.id });
  await api(owner, `/api/files/${ballast[0].id}`, 'PATCH', {
    name: 'ballast-1-kept.bin',
  });
  await api(owner, `/api/workspaces/${ownerWs}/sharing`, 'PATCH', {
    privacy: 'link',
  });
  await api(owner, `/api/workspaces/${ownerWs}/sharing`, 'PATCH', {
    privacy: 'private',
  });
  // Inviting passes the gate (a no-op: the member already belongs).
  await api(
    owner,
    `/api/workspaces/${ownerWs}/invites`,
    'POST',
    { identifier: member.id, role: 'editor' },
    202
  );
  await api(owner, `/api/files/${ballast[2].id}`, 'DELETE', undefined, 204);
  expect(await account(owner)).toMatchObject({
    state: 'over_quota_grace',
    storageUsedBytes: grace.storageUsedBytes,
  });

  // 7. Purging the file trashed while frozen frees space: active on Free.
  const trashed = await fileRow(run, ballast[3].id);
  await api(
    owner,
    `/api/trash/source_file/${ballast[3].id}?episodeId=${encodeURIComponent(string(trashed.trash_episode_id))}&requestId=${randomUUID()}`,
    'DELETE'
  );
  expect(
    await run.query('SELECT id FROM files WHERE id=%s', [ballast[3].id])
  ).toEqual([]);
  const freed = await account(owner);
  expect(freed).toMatchObject({
    planTier: 'free',
    state: 'active',
    storageLimitBytes: FREE_STORAGE,
  });
  expect(freed.storageUsedBytes).toBeLessThan(FREE_STORAGE);
  expect(freed.graceEndsAt).toBeUndefined();
  for (const actor of [owner, member]) {
    expect(await workspaceAccess(actor, ownerWs)).toMatchObject({
      canEdit: true,
      canEditContent: true,
    });
    expect(await roomAccess(actor, noteId)).toBe('write');
  }

  await noProviderCalls(run, ownerWs);
  await noProviderCalls(run, memberWs);
  const receipts = await run.poll(
    'subscription webhook receipts',
    () =>
      run.query<{ id: string; event_type: string; error: string | null }>(
        "SELECT id,event_type,error FROM webhook_events WHERE source='stripe' AND user_id=%s AND processed_at IS NOT NULL AND event_type IN ('customer.subscription.created','customer.subscription.deleted')",
        [owner.id]
      ),
    (rows) =>
      ['customer.subscription.created', 'customer.subscription.deleted'].every(
        (type) =>
          rows.filter((row) => row.event_type === type && row.error === null)
            .length === 2
      ),
    120_000
  );
  await run.attach('storage-lifecycle', {
    ballast: ballastIds,
    clockId,
    customerId,
    frozen: { graceEndsAt: frozen.graceEndsAt, lapse: frozenLapse },
    grace: { graceEndsAt: grace.graceEndsAt, lapse: graceLapse },
    receiptIds: receipts.map((row) => row.id),
    storage: {
      filled: filled.storageUsedBytes,
      freed: freed.storageUsedBytes,
    },
    subscriptions: [first, second],
    workspaces: { graceWs, memberWs, ownerWs },
  });
  await cleanupStripeTestClock(run.env, clockId, run.id);
});
