import { Button, Heading, Text } from '@react-email/components';
// biome-ignore lint/correctness/noUnusedImports: the email renderer uses the classic JSX runtime
import * as React from 'react';
import { type EmailLocale, m } from './i18n';
import { EmailLayout } from './layout';

export interface WorkspaceMemberRemovedEmailProps {
  locale: EmailLocale;
  openUrl: string;
  unsubscribeUrl: string;
  workspaceName: string;
}

function WorkspaceMemberRemovedEmail({
  locale,
  openUrl,
  unsubscribeUrl,
  workspaceName,
}: WorkspaceMemberRemovedEmailProps) {
  return (
    <EmailLayout
      footer={m.email_common_membership_footer({}, { locale })}
      locale={locale}
      preview={m.email_member_removed_preview({ workspaceName }, { locale })}
      unsubscribeUrl={unsubscribeUrl}
    >
      <Heading>{m.email_member_removed_heading({}, { locale })}</Heading>
      <Text>{m.email_member_removed_body({ workspaceName }, { locale })}</Text>
      <Text>
        <strong>{workspaceName}</strong>
      </Text>
      <Button href={openUrl}>
        {m.email_common_open_button({}, { locale })}
      </Button>
    </EmailLayout>
  );
}

WorkspaceMemberRemovedEmail.PreviewProps = {
  locale: 'en',
  openUrl: 'https://example.com',
  unsubscribeUrl: 'https://example.com/settings',
  workspaceName: 'Acme',
} satisfies WorkspaceMemberRemovedEmailProps;

export default WorkspaceMemberRemovedEmail;
