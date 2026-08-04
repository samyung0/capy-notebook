// biome-ignore lint/correctness/noUnusedImports: the email renderer uses the classic JSX runtime
import * as React from 'react';
import WorkspaceMemberRemovedEmail, {
  type WorkspaceMemberRemovedEmailProps,
} from '../workspace-member-removed';

/**
 * Preview-only wrapper. `PreviewProps` lives on the component function, so a
 * second locale needs a second component for the preview server to list.
 */
function WorkspaceMemberRemovedEmailZh(
  props: WorkspaceMemberRemovedEmailProps
) {
  return <WorkspaceMemberRemovedEmail {...props} />;
}

WorkspaceMemberRemovedEmailZh.PreviewProps = {
  ...WorkspaceMemberRemovedEmail.PreviewProps,
  locale: 'zh',
} satisfies WorkspaceMemberRemovedEmailProps;

export default WorkspaceMemberRemovedEmailZh;
