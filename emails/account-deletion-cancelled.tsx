import { Button, Heading, Text } from '@react-email/components';
// biome-ignore lint/correctness/noUnusedImports: the email renderer uses the classic JSX runtime
import * as React from 'react';
import { type EmailLocale, m } from './i18n';
import { EmailLayout } from './layout';

export interface AccountDeletionCancelledEmailProps {
  locale: EmailLocale;
  openUrl: string;
  unsubscribeUrl: string;
}

function AccountDeletionCancelledEmail({
  locale,
  openUrl,
  unsubscribeUrl,
}: AccountDeletionCancelledEmailProps) {
  return (
    <EmailLayout
      footer={m.email_deletion_cancelled_footer({}, { locale })}
      locale={locale}
      preview={m.email_deletion_cancelled_preview({}, { locale })}
      unsubscribeUrl={unsubscribeUrl}
    >
      <Heading>{m.email_deletion_cancelled_heading({}, { locale })}</Heading>
      <Text>{m.email_deletion_cancelled_greeting({}, { locale })}</Text>
      <Text>{m.email_deletion_cancelled_body({}, { locale })}</Text>
      <Button href={openUrl}>
        {m.email_deletion_cancelled_button({}, { locale })}
      </Button>
    </EmailLayout>
  );
}

AccountDeletionCancelledEmail.PreviewProps = {
  locale: 'en',
  openUrl: 'https://example.com/settings',
  unsubscribeUrl: 'https://example.com/settings',
} satisfies AccountDeletionCancelledEmailProps;

export default AccountDeletionCancelledEmail;
