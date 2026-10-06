import { useState } from 'react';
import type { AppNotification } from '@/api/types';
import { ContentSwap } from '@/components/ui/ContentSwap';
import { Icon, type IconName } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

type NotificationKind = AppNotification['kind'];

const KIND_ICON: Record<NotificationKind, IconName> = {
  system: 'bell',
  workspace_invite: 'workspaces',
  workspace_member_removed: 'workspaces',
  workspace_role_changed: 'workspaces',
};

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

function systemCopy(data: AppNotification['data']) {
  switch (dataString(data, 'code')) {
    case 'source_batch': {
      const done = dataNumber(data, 'done');
      const failed = dataNumber(data, 'failed');
      if (dataString(data, 'source') === 'import') {
        return {
          body: failed
            ? m.notification_system_source_imported_failed_body({
                done,
                failed,
              })
            : m.notification_system_source_imported_body({ done }),
          title: m.notification_system_source_import_title(),
        };
      }
      return {
        body: failed
          ? m.notification_system_source_uploaded_failed_body({ done, failed })
          : m.notification_system_source_uploaded_body({ done }),
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
    case 'account_deletion_cancelled':
      return {
        body: m.notification_system_deletion_cancelled_body(),
        title: m.notification_system_deletion_cancelled_title(),
      };
  }
  return { body: '', title: m.notifications_title() };
}

function notificationCopy(notification: AppNotification) {
  const workspaceName = dataString(notification.data, 'workspaceName');
  switch (notification.kind) {
    case 'system':
      return systemCopy(notification.data);
    case 'workspace_invite':
      return {
        body: m.notification_workspace_invite_body({ workspaceName }),
        title: m.notification_workspace_invite_title(),
      };
    case 'workspace_role_changed':
      return {
        body: m.notification_workspace_role_changed_body({
          role: roleLabel(dataString(notification.data, 'role')),
          workspaceName,
        }),
        title: m.notification_workspace_role_changed_title(),
      };
    case 'workspace_member_removed':
      return {
        body: m.notification_workspace_member_removed_body({ workspaceName }),
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

export function NotificationItem({
  className,
  notification,
  reveal = false,
}: {
  className?: string;
  notification: AppNotification;
  reveal?: boolean;
}) {
  const copy = notificationCopy(notification);
  const [revealOnMount] = useState(reveal);
  return (
    <span
      className={cn(
        't-body flex w-full gap-3 text-left',
        revealOnMount && 'motion-text-reveal',
        className
      )}
    >
      <span className="relative mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-button text-tint-accent-1-fg/70 group-hover:text-tint-accent-1-fg/95">
        <Icon name={KIND_ICON[notification.kind]} size={20} />
        {!notification.readAt && (
          <span className="absolute -top-px -right-px h-1.5 w-1.5 animate-pulse rounded-full bg-solid-error ring-1 ring-surface" />
        )}
      </span>
      <ContentSwap
        className="flex-1"
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
        </span>
      </ContentSwap>
    </span>
  );
}
