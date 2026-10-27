import type { AppNotification } from '@/api/types';
import { Avatar } from '@/components/ui/Avatar';
import { ContentSwap } from '@/components/ui/ContentSwap';
import { FileIcon } from '@/components/ui/FileIcon';
import { Icon } from '@/components/ui/Icon';
import { LogoMark } from '@/components/ui/Logo';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { getLocale, m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName } from '@/lib/fileIcons';
import { iconUrl } from '@/lib/icon-catalog';

function dataValue(data: AppNotification['data'], key: string): unknown {
  if (typeof data !== 'object' || data === null) return;
  return (data as Record<string, unknown>)[key];
}

function dataString(data: AppNotification['data'], key: string): string {
  const value = dataValue(data, key);
  return typeof value === 'string' ? value : '';
}

function dataNumber(data: AppNotification['data'], key: string): number {
  const value = dataValue(data, key);
  return typeof value === 'number' ? value : 0;
}

/** The workspace's current name, joined by the server, else the one the
 * notification was written with. */
function workspaceName(notification: AppNotification): string {
  return (
    notification.workspaceName || dataString(notification.data, 'workspaceName')
  );
}

interface SourceBatchCounts {
  done: number;
  failed: number;
  removed: number;
  workspaceName: string;
}

/** A batch's body names its failed and removed files only when it has any. */
function sourceBatchBody(
  counts: SourceBatchCounts,
  copy: Record<
    'failed' | 'failedRemoved' | 'plain' | 'removed',
    (counts: SourceBatchCounts) => string
  >
) {
  if (counts.failed && counts.removed) return copy.failedRemoved(counts);
  if (counts.failed) return copy.failed(counts);
  if (counts.removed) return copy.removed(counts);
  return copy.plain(counts);
}

function systemCopy(notification: AppNotification) {
  const { data } = notification;
  switch (dataString(data, 'code')) {
    case 'source_batch': {
      const counts = {
        done: dataNumber(data, 'done'),
        failed: dataNumber(data, 'failed'),
        // Files the user removed from the transfer panel (Epo 2026-10-22).
        removed: dataNumber(data, 'removed'),
        workspaceName: workspaceName(notification),
      };
      if (dataString(data, 'source') === 'import') {
        return {
          body: sourceBatchBody(counts, {
            failed: m.notification_system_source_imported_failed_body,
            failedRemoved:
              m.notification_system_source_imported_failed_removed_body,
            plain: m.notification_system_source_imported_body,
            removed: m.notification_system_source_imported_removed_body,
          }),
          title: m.notification_system_source_import_title(),
        };
      }
      return {
        body: sourceBatchBody(counts, {
          failed: m.notification_system_source_uploaded_failed_body,
          failedRemoved:
            m.notification_system_source_uploaded_failed_removed_body,
          plain: m.notification_system_source_uploaded_body,
          removed: m.notification_system_source_uploaded_removed_body,
        }),
        title: m.notification_system_source_upload_title(),
      };
    }
    case 'pending_edits_too_large':
      return {
        body: m.notification_system_pending_edits_body({
          fileName: dataString(data, 'fileName'),
        }),
        title: m.notification_system_pending_edits_title(),
      };
    case 'model_deprecated':
      return {
        body: m.notification_system_model_deprecated_body({
          fromName: dataString(data, 'fromName'),
          toName: dataString(data, 'toName'),
        }),
        title: m.notification_system_model_deprecated_title(),
      };
    case 'over_quota_started':
      return {
        body: m.notification_system_over_quota_body(),
        title: m.notification_system_over_quota_title(),
      };
    // Sent seven and three days before the freeze; the date stays right
    // whenever the notification is read.
    case 'over_quota_t7':
    case 'over_quota_t3':
      return {
        body: m.notification_system_over_quota_reminder_body({
          date: new Intl.DateTimeFormat(getLocale(), {
            dateStyle: 'medium',
          }).format(new Date(dataString(data, 'graceEndsAt'))),
        }),
        title: m.notification_system_over_quota_reminder_title(),
      };
    case 'over_quota_frozen':
      return {
        body: m.notification_system_frozen_body(),
        title: m.notification_system_frozen_title(),
      };
    case 'account_deletion_requested':
      return {
        body: m.notification_system_deletion_requested_body(),
        title: m.notification_system_deletion_requested_title(),
      };
    case 'office_maintenance':
      return {
        body: m.notification_system_office_maintenance_body({
          hours: dataNumber(data, 'hours'),
          time: new Intl.DateTimeFormat(getLocale(), {
            dateStyle: 'medium',
            timeStyle: 'short',
          }).format(new Date(dataString(data, 'startsAt'))),
        }),
        title: m.notification_system_office_maintenance_title(),
      };
    case 'account_deletion_cancelled':
      return {
        body: m.notification_system_deletion_cancelled_body(),
        title: m.notification_system_deletion_cancelled_title(),
      };
    case 'workspace_invite_accepted':
      return {
        body: m.notification_system_invite_accepted_body({
          memberName: dataString(data, 'memberName'),
          workspaceName: workspaceName(notification),
        }),
        title: m.notification_system_invite_accepted_title(),
      };
  }
  return { body: '', title: m.notifications_title() };
}

function notificationCopy(notification: AppNotification) {
  const name = workspaceName(notification);
  switch (notification.kind) {
    case 'system':
      return systemCopy(notification);
    case 'workspace_invite':
      return {
        body: m.notification_workspace_invite_body({ workspaceName: name }),
        title: m.notification_workspace_invite_title(),
      };
    case 'workspace_role_changed':
      return {
        body: m.notification_workspace_role_changed_body({
          role: roleLabel(dataString(notification.data, 'role')),
          workspaceName: name,
        }),
        title: m.notification_workspace_role_changed_title(),
      };
    case 'workspace_member_removed':
      return {
        body: m.notification_workspace_member_removed_body({
          workspaceName: name,
        }),
        title: m.notification_workspace_member_removed_title(),
      };
  }
}

function roleLabel(role: string) {
  switch (role) {
    case 'editor':
      return m.notification_role_editor();
    case 'viewer':
      return m.notification_role_viewer();
    default:
      return role;
  }
}

export interface NotificationSelf {
  avatarUrl?: string;
  name?: string;
}

/** Who or what the notification is about: the workspace, the member who
 * joined, you, the file, or the app itself (the Capy mark). */
function ContextIcon({
  notification,
  self,
}: {
  notification: AppNotification;
  self?: NotificationSelf;
}) {
  const code = dataString(notification.data, 'code');
  if (notification.kind !== 'system' || code === 'source_batch') {
    return notification.workspaceIconId ? (
      <img
        alt=""
        className="size-9 rounded-button"
        height={36}
        src={iconUrl(notification.workspaceIconId)}
        width={36}
      />
    ) : (
      <span className="flex size-9 items-center justify-center rounded-button bg-tint-accent-1 text-tint-accent-1-fg">
        <Icon name="workspaces" size={20} />
      </span>
    );
  }
  switch (code) {
    case 'workspace_invite_accepted':
      return (
        <Avatar
          className="size-9 text-[14.4px]"
          name={dataString(notification.data, 'memberName')}
          src={notification.memberAvatarUrl || undefined}
        />
      );
    case 'account_deletion_requested':
    case 'account_deletion_cancelled':
      return (
        <Avatar
          className="size-9 text-[14.4px]"
          name={self?.name}
          src={self?.avatarUrl}
        />
      );
    case 'pending_edits_too_large':
      return (
        <span className="flex size-9 items-center justify-center">
          <FileIcon
            className="size-6"
            name={fileIconName({
              kind: 'unknown',
              name: dataString(notification.data, 'fileName'),
            })}
          />
        </span>
      );
    default:
      return <LogoMark size={36} />;
  }
}

/** Relative today, the clock time on earlier days (the page groups by day). */
function timeLabel(at: string): string {
  const date = new Date(at);
  if (date.toDateString() === new Date().toDateString())
    return relativeTime(at);
  return new Intl.DateTimeFormat(getLocale(), { timeStyle: 'short' }).format(
    date
  );
}

export function NotificationItem({
  className,
  notification,
  self,
}: {
  className?: string;
  notification: AppNotification;
  self?: NotificationSelf;
}) {
  const copy = notificationCopy(notification);
  return (
    <span className={cn('t-body flex w-full gap-4 text-left', className)}>
      <span className="relative shrink-0">
        <ContextIcon notification={notification} self={self} />
        {!notification.readAt && (
          <span className="absolute -top-0.5 -right-0.5 size-2 animate-pulse rounded-full bg-solid-error ring-2 ring-surface" />
        )}
      </span>
      <ContentSwap
        className="min-w-0 flex-1"
        contentKey={JSON.stringify([copy.title, copy.body])}
      >
        <span className="flex min-w-0 flex-col">
          <span
            className={cn(
              'font-semibold transition-colors duration-(--motion-duration-quick)',
              notification.readAt ? 'text-fg-secondary' : 'text-fg'
            )}
          >
            {copy.title}
          </span>
          <span className="text-fg-secondary">{copy.body}</span>
          <span className="t-meta mt-0.5 text-fg-muted">
            {timeLabel(notification.at)}
          </span>
        </span>
      </ContentSwap>
    </span>
  );
}
