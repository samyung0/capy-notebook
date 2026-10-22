import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { AppNotification } from '@/api/types';
import { m } from '@/i18n';
import { NotificationItem } from './NotificationItem';

const NON_EMPTY_BODY = /text-fg-secondary">[^<]+</;

// Every code the server sends renders its own title and body.
const sent: Pick<AppNotification, 'data' | 'kind'>[] = [
  {
    data: { code: 'source_batch', done: 2, failed: 1, source: 'upload' },
    kind: 'system',
  },
  {
    data: { code: 'source_batch', done: 2, failed: 0, source: 'import' },
    kind: 'system',
  },
  {
    data: { code: 'pending_edits_too_large', fileName: 'Notes' },
    kind: 'system',
  },
  {
    data: { code: 'model_deprecated', fromName: 'A', toName: 'B' },
    kind: 'system',
  },
  { data: { code: 'over_quota_started' }, kind: 'system' },
  {
    data: { code: 'over_quota_t7', graceEndsAt: '2026-10-20T00:00:00Z' },
    kind: 'system',
  },
  {
    data: { code: 'over_quota_t3', graceEndsAt: '2026-10-20T00:00:00Z' },
    kind: 'system',
  },
  { data: { code: 'over_quota_frozen' }, kind: 'system' },
  { data: { code: 'account_deletion_requested' }, kind: 'system' },
  { data: { code: 'account_deletion_cancelled' }, kind: 'system' },
  {
    data: {
      code: 'workspace_invite_accepted',
      memberName: 'Mia',
      workspaceName: 'Bio',
    },
    kind: 'system',
  },
  {
    data: {
      code: 'office_maintenance',
      hours: 4,
      reminder: false,
      startsAt: '2026-10-13T02:00:00Z',
    },
    kind: 'system',
  },
  { data: { workspaceName: 'Bio' }, kind: 'workspace_invite' },
  {
    data: { role: 'editor', workspaceName: 'Bio' },
    kind: 'workspace_role_changed',
  },
  { data: { workspaceName: 'Bio' }, kind: 'workspace_member_removed' },
];

// Files the user removed from the transfer panel are reported as removed,
// never as failed (Epo 2026-10-22).
it.each([
  [
    'upload',
    { done: 2, failed: 0, removed: 1 },
    m.notification_system_source_uploaded_removed_body({
      done: 2,
      removed: 1,
      workspaceName: 'Bio',
    }),
  ],
  [
    'import',
    { done: 2, failed: 1, removed: 1 },
    m.notification_system_source_imported_failed_removed_body({
      done: 2,
      failed: 1,
      removed: 1,
      workspaceName: 'Bio',
    }),
  ],
])('reports removed files of an %s batch', (source, counts, body) => {
  const html = renderToStaticMarkup(
    <NotificationItem
      notification={{
        at: '2026-10-06T00:00:00Z',
        data: { code: 'source_batch', source, ...counts },
        id: 'n',
        kind: 'system',
        workspaceName: 'Bio',
      }}
    />
  );
  expect(html).toContain(body);
});

it.each(sent)('renders copy for $kind $data.code', (item) => {
  const html = renderToStaticMarkup(
    <NotificationItem
      notification={{ ...item, at: '2026-10-06T00:00:00Z', id: 'n' }}
    />
  );
  expect(html).not.toContain(m.notifications_title());
  expect(html).toMatch(NON_EMPTY_BODY);
});
