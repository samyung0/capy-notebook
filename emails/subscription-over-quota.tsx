import { Button, Heading, Text } from '@react-email/components';
// biome-ignore lint/correctness/noUnusedImports: the email renderer uses the classic JSX runtime
import * as React from 'react';
import { type EmailLocale, m } from './i18n';
import { EmailLayout } from './layout';

export interface SubscriptionOverQuotaEmailProps {
  locale: EmailLocale;
  openUrl: string;
  unsubscribeUrl: string;
}

function SubscriptionOverQuotaEmail({
  locale,
  openUrl,
  unsubscribeUrl,
}: SubscriptionOverQuotaEmailProps) {
  return (
    <EmailLayout
      footer={m.email_over_quota_footer({}, { locale })}
      locale={locale}
      preview={m.email_over_quota_preview({}, { locale })}
      unsubscribeUrl={unsubscribeUrl}
    >
      <Heading>{m.email_over_quota_heading({}, { locale })}</Heading>
      <Text>{m.email_over_quota_greeting({}, { locale })}</Text>
      <Text>{m.email_over_quota_body({}, { locale })}</Text>
      <Button href={openUrl}>
        {m.email_over_quota_button({}, { locale })}
      </Button>
    </EmailLayout>
  );
}

SubscriptionOverQuotaEmail.PreviewProps = {
  locale: 'en',
  openUrl: 'https://example.com/settings',
  unsubscribeUrl: 'https://example.com/settings',
} satisfies SubscriptionOverQuotaEmailProps;

export default SubscriptionOverQuotaEmail;
