import { Button, Heading, Text } from '@react-email/components';
// biome-ignore lint/correctness/noUnusedImports: the email renderer uses the classic JSX runtime
import * as React from 'react';
import { type EmailLocale, m } from './i18n';
import { EmailLayout } from './layout';

export interface SubscriptionFrozenEmailProps {
  locale: EmailLocale;
  openUrl: string;
  unsubscribeUrl: string;
}

function SubscriptionFrozenEmail({
  locale,
  openUrl,
  unsubscribeUrl,
}: SubscriptionFrozenEmailProps) {
  return (
    <EmailLayout
      footer={m.email_frozen_footer({}, { locale })}
      locale={locale}
      preview={m.email_frozen_preview({}, { locale })}
      unsubscribeUrl={unsubscribeUrl}
    >
      <Heading>{m.email_frozen_heading({}, { locale })}</Heading>
      <Text>{m.email_frozen_greeting({}, { locale })}</Text>
      <Text>{m.email_frozen_body({}, { locale })}</Text>
      <Button href={openUrl}>{m.email_frozen_button({}, { locale })}</Button>
    </EmailLayout>
  );
}

SubscriptionFrozenEmail.PreviewProps = {
  locale: 'en',
  openUrl: 'https://example.com/settings',
  unsubscribeUrl: 'https://example.com/settings',
} satisfies SubscriptionFrozenEmailProps;

export default SubscriptionFrozenEmail;
