// biome-ignore lint/correctness/noUnusedImports: the email renderer uses the classic JSX runtime
import * as React from 'react';
import { m } from '../i18n';
import WorkspaceRoleChangedEmail, {
  type WorkspaceRoleChangedEmailProps,
} from '../workspace-role-changed';

/**
 * Preview-only wrapper. `PreviewProps` lives on the component function, so a
 * second locale needs a second component for the preview server to list.
 */
function WorkspaceRoleChangedEmailZh(props: WorkspaceRoleChangedEmailProps) {
  return <WorkspaceRoleChangedEmail {...props} />;
}

WorkspaceRoleChangedEmailZh.PreviewProps = {
  ...WorkspaceRoleChangedEmail.PreviewProps,
  locale: 'zh',
  roleName: m.notification_role_editor({}, { locale: 'zh' }),
} satisfies WorkspaceRoleChangedEmailProps;

export default WorkspaceRoleChangedEmailZh;
