import type { AppNotification } from '@/api/types';
import { Icon, type IconName } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

type NotificationKind = AppNotification['kind'];

const KIND_ICON: Record<NotificationKind, IconName> = {
  event: 'schedule',
  quiz: 'quiz',
  system: 'bell',
  workspace_invite: 'workspaces',
  workspace_member_removed: 'workspaces',
  workspace_role_changed: 'workspaces',
};

function dataString(data: AppNotification['data'], key: string): string {
  if (typeof data !== 'object' || data === null) return '';
  const value = (data as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function notificationCopy(notification: AppNotification) {
  const code = dataString(notification.data, 'code');
  const eventName = dataString(notification.data, 'eventName');
  const fileName = dataString(notification.data, 'fileName');
  const location = dataString(notification.data, 'location');
  const score = dataString(notification.data, 'score');
  const workspaceName = dataString(notification.data, 'workspaceName');
  const role = dataString(notification.data, 'role');
  const time = dataString(notification.data, 'time');
  const quizName = dataString(notification.data, 'quizName');
  switch (notification.kind) {
    case 'event':
      if (code === 'event_starting') {
        return {
          body: m.notification_event_starting_body({
            eventName,
            location,
            time,
          }),
          title: m.notification_event_starting_title(),
        };
      }
      break;
    case 'quiz':
      if (code === 'quiz_attempt_graded') {
        return {
          body: m.notification_quiz_attempt_graded_body({ quizName, score }),
          title: m.notification_quiz_attempt_graded_title(),
        };
      }
      break;
    case 'system':
      if (code === 'source_duplicate') {
        return {
          body: m.notification_system_source_duplicate_body({ fileName }),
          title: m.notification_system_source_duplicate_title(),
        };
      }
      if (code === 'source_ready') {
        return {
          body: m.notification_system_source_ready_body({ fileName }),
          title: m.notification_system_source_ready_title(),
        };
      }
      if (code === 'source_stored') {
        return {
          body: m.notification_system_source_stored_body({ fileName }),
          title: m.notification_system_source_stored_title(),
        };
      }
      if (code === 'welcome') {
        return {
          body: m.notification_system_welcome_body(),
          title: m.notification_system_welcome_title(),
        };
      }
      break;
    case 'workspace_invite':
      return {
        body: m.notification_workspace_invite_body({ workspaceName }),
        title: m.notification_workspace_invite_title(),
      };
    case 'workspace_role_changed':
      return {
        body: m.notification_workspace_role_changed_body({
          role: roleLabel(role),
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
  return {
    body: '',
    title: m.notifications_title(),
  };
}

function roleLabel(role: string) {
  switch (role) {
    case 'editor':
      return m.notification_role_editor();
    case 'commenter':
      return m.notification_role_commenter();
    case 'viewer':
      return m.notification_role_viewer();
    default:
      return role;
  }
}

export function NotificationItem({
  className,
  notification,
}: {
  className?: string;
  notification: AppNotification;
}) {
  const copy = notificationCopy(notification);
  return (
    <span className={cn('t-body flex w-full gap-3 text-left', className)}>
      <span className="relative mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-button text-tint-accent-1-fg/70 group-hover:text-tint-accent-1-fg/95">
        <Icon name={KIND_ICON[notification.kind]} size={20} />
        {!notification.readAt && (
          <span className="absolute -top-px -right-px h-1.5 w-1.5 animate-pulse rounded-full bg-solid-error ring-1 ring-surface" />
        )}
      </span>
      <span className="flex min-w-0 flex-col">
        <span
          className={cn(
            'font-semibold',
            notification.readAt ? 'text-fg' : 'text-fg-strong'
          )}
        >
          {copy.title}
        </span>
        <span className="text-fg-secondary">{copy.body}</span>
      </span>
    </span>
  );
}
