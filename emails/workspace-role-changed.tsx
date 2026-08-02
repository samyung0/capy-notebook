import { Button, Heading, Text } from '@react-email/components';
// biome-ignore lint/correctness/noUnusedImports: the email renderer uses the classic JSX runtime
import * as React from 'react';
import { EmailLayout } from './layout';

export interface WorkspaceRoleChangedEmailProps {
  Body: string;
  Button: string;
  Footer: string;
  Heading: string;
  OpenURL: string;
  Preview: string;
  RoleLabel: string;
  RoleName: string;
  UnsubscribeText: string;
  WorkspaceLabel: string;
  WorkspaceName: string;
}

export function WorkspaceRoleChangedEmail({
  Body,
  Button: buttonLabel,
  Footer,
  Heading: heading,
  OpenURL,
  Preview,
  RoleLabel,
  RoleName,
  UnsubscribeText: _unsubscribeText,
  WorkspaceLabel,
  WorkspaceName,
}: WorkspaceRoleChangedEmailProps) {
  return (
    <EmailLayout footer={Footer} preview={Preview}>
      <Heading>{heading}</Heading>
      <Text>{Body}</Text>
      <Text>
        {WorkspaceLabel}: <strong>{WorkspaceName}</strong>
      </Text>
      <Text>
        {RoleLabel}: <strong>{RoleName}</strong>
      </Text>
      <Button href={OpenURL}>{buttonLabel}</Button>
    </EmailLayout>
  );
}
