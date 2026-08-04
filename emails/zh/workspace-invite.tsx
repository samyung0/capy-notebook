// biome-ignore lint/correctness/noUnusedImports: the email renderer uses the classic JSX runtime
import * as React from 'react';
import WorkspaceInviteEmail, {
  type WorkspaceInviteEmailProps,
} from '../workspace-invite';

/**
 * Preview-only wrapper. `PreviewProps` lives on the component function, so a
 * second locale needs a second component for the preview server to list.
 */
function WorkspaceInviteEmailZh(props: WorkspaceInviteEmailProps) {
  return <WorkspaceInviteEmail {...props} />;
}

WorkspaceInviteEmailZh.PreviewProps = {
  ...WorkspaceInviteEmail.PreviewProps,
  locale: 'zh',
} satisfies WorkspaceInviteEmailProps;

export default WorkspaceInviteEmailZh;
