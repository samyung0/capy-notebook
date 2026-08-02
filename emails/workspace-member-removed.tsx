import { Button, Heading, Text } from '@react-email/components';
// biome-ignore lint/correctness/noUnusedImports: the email renderer uses the classic JSX runtime
import * as React from 'react';
import { EmailLayout } from './layout';

export interface WorkspaceMemberRemovedEmailProps {
  Body: string;
  Button: string;
  Footer: string;
  Heading: string;
  OpenURL: string;
  Preview: string;
  UnsubscribeText: string;
  WorkspaceName: string;
}

export function WorkspaceMemberRemovedEmail({
  Body,
  Button: buttonLabel,
  Footer,
  Heading: heading,
  OpenURL,
  Preview,
  UnsubscribeText: _unsubscribeText,
  WorkspaceName,
}: WorkspaceMemberRemovedEmailProps) {
  return (
    <EmailLayout footer={Footer} preview={Preview}>
      <Heading>{heading}</Heading>
      <Text>{Body}</Text>
      <Text>
        <strong>{WorkspaceName}</strong>
      </Text>
      <Button href={OpenURL}>{buttonLabel}</Button>
    </EmailLayout>
  );
}
