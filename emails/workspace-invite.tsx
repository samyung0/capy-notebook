import { Button, Heading, Link, Text } from '@react-email/components';
// biome-ignore lint/correctness/noUnusedImports: the email renderer uses the classic JSX runtime
import * as React from 'react';
import { type EmailLocale, m } from './i18n';
import { EmailLayout } from './layout';

export interface WorkspaceInviteEmailProps {
  inviteUrl: string;
  locale: EmailLocale;
  unsubscribeUrl: string;
  workspaceName: string;
}

function WorkspaceInviteEmail({
  inviteUrl,
  locale,
  unsubscribeUrl,
  workspaceName,
}: WorkspaceInviteEmailProps) {
  return (
    <EmailLayout
      footer={m.email_invite_footer({}, { locale })}
      locale={locale}
      preview={m.email_invite_preview({}, { locale })}
      unsubscribeUrl={unsubscribeUrl}
    >
      <Heading>{m.email_invite_heading({}, { locale })}</Heading>
      <Text>{m.email_invite_greeting({}, { locale })}</Text>
      <Text>{m.email_invite_body({ workspaceName }, { locale })}</Text>
      <Button href={inviteUrl}>{m.email_invite_button({}, { locale })}</Button>
      <Text>
        {m.email_invite_fallback({}, { locale })}{' '}
        <Link href={inviteUrl}>{inviteUrl}</Link>
      </Text>
    </EmailLayout>
  );
}

WorkspaceInviteEmail.PreviewProps = {
  inviteUrl: 'https://example.com/invite/abc',
  locale: 'en',
  unsubscribeUrl: 'https://example.com/settings',
  workspaceName: 'Acme',
} satisfies WorkspaceInviteEmailProps;

export default WorkspaceInviteEmail;
