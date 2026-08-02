import { Button, Heading, Link, Text } from '@react-email/components';
// biome-ignore lint/correctness/noUnusedImports: the email renderer uses the classic JSX runtime
import * as React from 'react';
import { EmailLayout } from './layout';

export interface WorkspaceInviteEmailProps {
  Body: string;
  Button: string;
  Fallback: string;
  Footer: string;
  Greeting: string;
  Heading: string;
  InviteURL: string;
  Preview: string;
  UnsubscribeText: string;
  WorkspaceName: string;
}

export function WorkspaceInviteEmail({
  Body,
  Button: buttonLabel,
  Fallback,
  Footer,
  Greeting,
  Heading: heading,
  InviteURL,
  Preview,
  UnsubscribeText: _unsubscribeText,
}: WorkspaceInviteEmailProps) {
  return (
    <EmailLayout footer={Footer} preview={Preview}>
      <Heading>{heading}</Heading>
      <Text>{Greeting}</Text>
      <Text>{Body}</Text>
      <Button href={InviteURL}>{buttonLabel}</Button>
      <Text>
        {Fallback} <Link href={InviteURL}>{InviteURL}</Link>
      </Text>
    </EmailLayout>
  );
}
