import { Button, Heading, Text } from '@react-email/components';
// biome-ignore lint/correctness/noUnusedImports: the email renderer uses the classic JSX runtime
import * as React from 'react';
import { type EmailLocale, m } from './i18n';
import { EmailLayout } from './layout';

export interface AccountDeletionRequestedEmailProps {
  graceDays: string;
  locale: EmailLocale;
  openUrl: string;
  unsubscribeUrl: string;
}

function AccountDeletionRequestedEmail({
  graceDays,
  locale,
  openUrl,
  unsubscribeUrl,
}: AccountDeletionRequestedEmailProps) {
  return (
    <EmailLayout
      footer={m.email_deletion_requested_footer({}, { locale })}
      locale={locale}
      preview={m.email_deletion_requested_preview({}, { locale })}
      unsubscribeUrl={unsubscribeUrl}
    >
      <Heading>{m.email_deletion_requested_heading({}, { locale })}</Heading>
      <Text>{m.email_deletion_requested_greeting({}, { locale })}</Text>
      <Text>{m.email_deletion_requested_body({ graceDays }, { locale })}</Text>
      <Button href={openUrl}>
        {m.email_deletion_requested_button({}, { locale })}
      </Button>
    </EmailLayout>
  );
}

AccountDeletionRequestedEmail.PreviewProps = {
  graceDays: '30',
  locale: 'en',
  openUrl: 'https://example.com/settings',
  unsubscribeUrl: 'https://example.com/settings',
} satisfies AccountDeletionRequestedEmailProps;

export default AccountDeletionRequestedEmail;
