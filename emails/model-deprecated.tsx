import { Button, Heading, Text } from '@react-email/components';
// biome-ignore lint/correctness/noUnusedImports: the email renderer uses the classic JSX runtime
import * as React from 'react';
import { type EmailLocale, m } from './i18n';
import { EmailLayout } from './layout';

export interface ModelDeprecatedEmailProps {
  fromName: string;
  locale: EmailLocale;
  openUrl: string;
  toName: string;
  unsubscribeUrl: string;
}

function ModelDeprecatedEmail({
  fromName,
  locale,
  openUrl,
  toName,
  unsubscribeUrl,
}: ModelDeprecatedEmailProps) {
  return (
    <EmailLayout
      footer={m.email_model_deprecated_footer({}, { locale })}
      locale={locale}
      preview={m.email_model_deprecated_preview({ toName }, { locale })}
      unsubscribeUrl={unsubscribeUrl}
    >
      <Heading>{m.email_model_deprecated_heading({}, { locale })}</Heading>
      <Text>{m.email_model_deprecated_greeting({}, { locale })}</Text>
      <Text>
        {m.email_model_deprecated_body({ fromName, toName }, { locale })}
      </Text>
      <Button href={openUrl}>
        {m.email_model_deprecated_button({}, { locale })}
      </Button>
    </EmailLayout>
  );
}

ModelDeprecatedEmail.PreviewProps = {
  fromName: 'DeepSeek Pro',
  locale: 'en',
  openUrl: 'https://example.com/settings?tab=llm',
  toName: 'DeepSeek Flash',
  unsubscribeUrl: 'https://example.com/settings',
} satisfies ModelDeprecatedEmailProps;

export default ModelDeprecatedEmail;
