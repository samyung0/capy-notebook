import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { render, toPlainText } from '@react-email/render';
import { createElement, type ReactElement } from 'react';
import {
  WorkspaceInviteEmail,
  type WorkspaceInviteEmailProps,
} from '../emails/workspace-invite';
import {
  WorkspaceMemberRemovedEmail,
  type WorkspaceMemberRemovedEmailProps,
} from '../emails/workspace-member-removed';
import {
  WorkspaceRoleChangedEmail,
  type WorkspaceRoleChangedEmailProps,
} from '../emails/workspace-role-changed';

const outputDir = join(
  process.cwd(),
  'server',
  'internal',
  'mail',
  'templates'
);
const value = (name: string) => `{{.${name}}}`;

const copy = {
  en: {
    invite: {
      Body: `You have been invited to join ${value('WorkspaceName')} on Evo Notes.`,
      Button: 'View invitation',
      Fallback: 'Open this link if the button does not work:',
      Footer:
        'You received this message because an Evo Notes workspace invited you.',
      Greeting: 'Hello,',
      Heading: 'You have a workspace invitation',
      Preview: 'You have a new Evo Notes workspace invitation.',
      UnsubscribeText: 'Manage product email preferences',
    },
    removed: {
      Body: `Your membership in ${value('WorkspaceName')} was removed by a workspace owner.`,
      Button: 'Open Evo Notes',
      Footer:
        'You received this message because your Evo Notes workspace membership changed.',
      Heading: 'Removed from workspace',
      Preview: `Your membership in ${value('WorkspaceName')} changed.`,
      UnsubscribeText: 'Manage product email preferences',
    },
    role: {
      Body: `Your role in ${value('WorkspaceName')} was changed by a workspace owner.`,
      Button: 'Open Evo Notes',
      Footer:
        'You received this message because your Evo Notes workspace membership changed.',
      Heading: 'Workspace role changed',
      Preview: `Your role in ${value('WorkspaceName')} changed.`,
      RoleLabel: 'New role',
      UnsubscribeText: 'Manage product email preferences',
      WorkspaceLabel: 'Workspace',
    },
  },
  zh: {
    invite: {
      Body: `你已受邀加入 Evo Notes 工作区 ${value('WorkspaceName')}。`,
      Button: '查看邀请',
      Fallback: '如果按钮无法使用，请打开此链接：',
      Footer: '你收到这封邮件是因为有人邀请你加入 Evo Notes 工作区。',
      Greeting: '你好，',
      Heading: '你有一个工作区邀请',
      Preview: '你有一个新的 Evo Notes 工作区邀请。',
      UnsubscribeText: '管理产品邮件偏好',
    },
    removed: {
      Body: `你已被工作区所有者移出 ${value('WorkspaceName')}。`,
      Button: '打开 Evo Notes',
      Footer: '你收到这封邮件是因为 Evo Notes 工作区成员身份发生了变化。',
      Heading: '已移出工作区',
      Preview: `${value('WorkspaceName')} 的成员身份已更改。`,
      UnsubscribeText: '管理产品邮件偏好',
    },
    role: {
      Body: `${value('WorkspaceName')} 中的角色已由工作区所有者更改。`,
      Button: '打开 Evo Notes',
      Footer: '你收到这封邮件是因为 Evo Notes 工作区成员身份发生了变化。',
      Heading: '工作区角色已更改',
      Preview: `${value('WorkspaceName')} 中的角色已更改。`,
      RoleLabel: '新角色',
      UnsubscribeText: '管理产品邮件偏好',
      WorkspaceLabel: '工作区',
    },
  },
} as const;

function renderInvite(locale: keyof typeof copy): ReactElement {
  const strings = copy[locale].invite;
  const props: WorkspaceInviteEmailProps = {
    ...strings,
    InviteURL: value('InviteURL'),
    UnsubscribeText: value('UnsubscribeText'),
    WorkspaceName: value('WorkspaceName'),
  };
  return createElement(WorkspaceInviteEmail, props);
}

function renderRole(locale: keyof typeof copy): ReactElement {
  const strings = copy[locale].role;
  const props: WorkspaceRoleChangedEmailProps = {
    ...strings,
    OpenURL: value('OpenURL'),
    RoleName: value('RoleName'),
    UnsubscribeText: value('UnsubscribeText'),
    WorkspaceName: value('WorkspaceName'),
  };
  return createElement(WorkspaceRoleChangedEmail, props);
}

function renderRemoved(locale: keyof typeof copy): ReactElement {
  const strings = copy[locale].removed;
  const props: WorkspaceMemberRemovedEmailProps = {
    ...strings,
    Button: strings.Button,
    OpenURL: value('OpenURL'),
    UnsubscribeText: value('UnsubscribeText'),
    WorkspaceName: value('WorkspaceName'),
  };
  return createElement(WorkspaceMemberRemovedEmail, props);
}

const templates: Array<{
  name: string;
  render: (locale: keyof typeof copy) => ReactElement;
}> = [
  { name: 'workspace-invite', render: renderInvite },
  { name: 'workspace-role-changed', render: renderRole },
  { name: 'workspace-member-removed', render: renderRemoved },
];

await mkdir(outputDir, { recursive: true });
for (const locale of ['en', 'zh'] as const) {
  for (const template of templates) {
    const html = await render(template.render(locale));
    const text = toPlainText(html);
    await writeFile(
      join(outputDir, `${template.name}.${locale}.gohtml`),
      `${html.trim()}\n`
    );
    await writeFile(
      join(outputDir, `${template.name}.${locale}.txt`),
      `${text.trim()}\n`
    );
  }
}
