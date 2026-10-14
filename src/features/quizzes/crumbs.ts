import { linkOptions } from '@tanstack/react-router';
import { m } from '@/i18n';
import type { Crumb } from './QuizPageHeader';

/** A block's first crumb: its workspace, or the Blocks tab when standalone. */
export const blockHomeCrumb = (block: {
  workspaceId: string;
  workspaceName: string;
}): Crumb =>
  block.workspaceId && block.workspaceName
    ? {
        label: block.workspaceName,
        link: linkOptions({
          params: { workspaceId: block.workspaceId },
          to: '/workspaces/$workspaceId',
        }),
      }
    : {
        label: m.files_tab_blocks(),
        link: linkOptions({ search: { tab: 'blocks' }, to: '/files' }),
      };
