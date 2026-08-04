import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from '@react-email/components';
import type { ReactNode } from 'react';
// biome-ignore lint/correctness/noUnusedImports: the email renderer uses the classic JSX runtime
import * as React from 'react';
import { type EmailLocale, m } from './i18n';

export interface EmailLayoutProps {
  children: ReactNode;
  footer: string;
  locale: EmailLocale;
  preview: string;
  unsubscribeUrl: string;
}

export function EmailLayout({
  children,
  footer,
  locale,
  preview,
  unsubscribeUrl,
}: EmailLayoutProps) {
  return (
    <Html lang={locale}>
      <Head />
      <Preview>{preview}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Text style={brand}>Evo Notes</Text>
          <Section>{children}</Section>
          <Hr style={rule} />
          <Text style={footerStyle}>{footer}</Text>
          <Text style={footerStyle}>
            <Link href={unsubscribeUrl} style={link}>
              {m.email_common_unsubscribe({}, { locale })}
            </Link>
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

const body = {
  backgroundColor: '#f5f5f2',
  color: '#252525',
  fontFamily: 'Arial, sans-serif',
  margin: '0',
  padding: '32px 0',
};

const container = {
  backgroundColor: '#ffffff',
  border: '1px solid #e2e2dc',
  borderRadius: '12px',
  margin: '0 auto',
  maxWidth: '560px',
  padding: '32px',
};

const brand = {
  color: '#5e5cdb',
  fontSize: '18px',
  fontWeight: '700',
  margin: '0 0 28px',
};

const rule = {
  borderColor: '#e2e2dc',
  margin: '28px 0 16px',
};

const footerStyle = {
  color: '#71716b',
  fontSize: '12px',
  lineHeight: '18px',
  margin: '6px 0',
};

const link = {
  color: '#5e5cdb',
};
