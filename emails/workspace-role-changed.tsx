import { Button, Heading, Text } from '@react-email/components';
// biome-ignore lint/correctness/noUnusedImports: the email renderer uses the classic JSX runtime
import * as React from 'react';
import { type EmailLocale, m } from './i18n';
import { EmailLayout } from './layout';

export interface WorkspaceRoleChangedEmailProps {
  locale: EmailLocale;
  openUrl: string;
  roleName: string;
  unsubscribeUrl: string;
  workspaceName: string;
}

function WorkspaceRoleChangedEmail({
  locale,
  openUrl,
  roleName,
  unsubscribeUrl,
  workspaceName,
}: WorkspaceRoleChangedEmailProps) {
  return (
    <EmailLayout
      footer={m.email_common_membership_footer({}, { locale })}
      locale={locale}
      preview={m.email_role_changed_preview({ workspaceName }, { locale })}
      unsubscribeUrl={unsubscribeUrl}
    >
      <Heading>{m.email_role_changed_heading({}, { locale })}</Heading>
      <Text>{m.email_role_changed_body({ workspaceName }, { locale })}</Text>
      <Text>
        {m.email_role_changed_workspace_label({}, { locale })}:{' '}
        <strong>{workspaceName}</strong>
      </Text>
      <Text>
        {m.email_role_changed_role_label({}, { locale })}:{' '}
        <strong>{roleName}</strong>
      </Text>
      <Button href={openUrl}>
        {m.email_common_open_button({}, { locale })}
      </Button>
    </EmailLayout>
  );
}

WorkspaceRoleChangedEmail.PreviewProps = {
  locale: 'en',
  openUrl: 'https://example.com/workspaces/acme',
  roleName: m.notification_role_editor({}, { locale: 'en' }),
  unsubscribeUrl: 'https://example.com/settings',
  workspaceName: 'Acme',
} satisfies WorkspaceRoleChangedEmailProps;

export default WorkspaceRoleChangedEmail;
