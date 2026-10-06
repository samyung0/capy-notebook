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
  { data: { code: 'over_quota_frozen' }, kind: 'system' },
  { data: { code: 'account_deletion_requested' }, kind: 'system' },
  { data: { code: 'account_deletion_cancelled' }, kind: 'system' },
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

it.each(sent)('renders copy for $kind $data.code', (item) => {
  const html = renderToStaticMarkup(
    <NotificationItem
      notification={{ ...item, at: '2026-10-06T00:00:00Z', id: 'n' }}
    />
  );
  expect(html).not.toContain(m.notifications_title());
  expect(html).toMatch(NON_EMPTY_BODY);
});
