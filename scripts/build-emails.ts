/**
 * Renders emails/*.tsx into Go templates that the API embeds, so production
 * never needs Node. All copy comes from the Paraglide catalog in messages/*.json:
 * Go placeholders such as `{{.WorkspaceName}}` are passed in as Paraglide message
 * parameters, so they survive interpolation and land in the rendered output.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compile } from '@inlang/paraglide-js';
import { render, toPlainText } from '@react-email/render';
import { createElement, type ReactElement } from 'react';

const projectRoot = process.cwd();
const paraglideOutDir = join(projectRoot, 'src', 'i18n', 'paraglide');
const mailDir = join(projectRoot, 'server', 'internal', 'mail');
const templateDir = join(mailDir, 'templates');

// The Paraglide output is generated, not committed, and the email components
// import it directly — so compile before anything pulls them in.
await compile({
  outdir: paraglideOutDir,
  project: join(projectRoot, 'project.inlang'),
});

const { m } = await import('../emails/i18n');
const { locales } = await import('../src/i18n/paraglide/runtime.js');
const { default: AccountDeletionCancelledEmail } = await import(
  '../emails/account-deletion-cancelled'
);
const { default: AccountDeletionRequestedEmail } = await import(
  '../emails/account-deletion-requested'
);
const { default: SubscriptionFrozenEmail } = await import(
  '../emails/subscription-frozen'
);
const { default: SubscriptionOverQuotaEmail } = await import(
  '../emails/subscription-over-quota'
);
const { default: WorkspaceInviteEmail } = await import(
  '../emails/workspace-invite'
);
const { default: WorkspaceMemberRemovedEmail } = await import(
  '../emails/workspace-member-removed'
);
const { default: WorkspaceRoleChangedEmail } = await import(
  '../emails/workspace-role-changed'
);

type Locale = 'en' | 'zh';

const placeholder = (name: string) => `{{.${name}}}`;
const graceDays = placeholder('GraceDays');
const openUrl = placeholder('OpenURL');
const workspaceName = placeholder('WorkspaceName');
const unsubscribeUrl = placeholder('UnsubscribeURL');

const templates: Array<{
  name: string;
  render: (locale: Locale) => ReactElement;
  subject: (locale: Locale) => string;
}> = [
  {
    name: 'workspace-invite',
    render: (locale) =>
      createElement(WorkspaceInviteEmail, {
        inviteUrl: placeholder('InviteURL'),
        locale,
        unsubscribeUrl,
        workspaceName,
      }),
    subject: (locale) => m.email_invite_subject({ workspaceName }, { locale }),
  },
  {
    name: 'workspace-role-changed',
    render: (locale) =>
      createElement(WorkspaceRoleChangedEmail, {
        locale,
        openUrl,
        roleName: placeholder('RoleName'),
        unsubscribeUrl,
        workspaceName,
      }),
    subject: (locale) =>
      m.email_role_changed_subject({ workspaceName }, { locale }),
  },
  {
    name: 'workspace-member-removed',
    render: (locale) =>
      createElement(WorkspaceMemberRemovedEmail, {
        locale,
        openUrl,
        unsubscribeUrl,
        workspaceName,
      }),
    subject: (locale) =>
      m.email_member_removed_subject({ workspaceName }, { locale }),
  },
  {
    name: 'account-deletion-requested',
    render: (locale) =>
      createElement(AccountDeletionRequestedEmail, {
        graceDays,
        locale,
        openUrl,
        unsubscribeUrl,
      }),
    subject: (locale) => m.email_deletion_requested_subject({}, { locale }),
  },
  {
    name: 'account-deletion-cancelled',
    render: (locale) =>
      createElement(AccountDeletionCancelledEmail, {
        locale,
        openUrl,
        unsubscribeUrl,
      }),
    subject: (locale) => m.email_deletion_cancelled_subject({}, { locale }),
  },
  {
    name: 'subscription-over-quota',
    render: (locale) =>
      createElement(SubscriptionOverQuotaEmail, {
        locale,
        openUrl,
        unsubscribeUrl,
      }),
    subject: (locale) => m.email_over_quota_subject({}, { locale }),
  },
  {
    name: 'subscription-frozen',
    render: (locale) =>
      createElement(SubscriptionFrozenEmail, {
        locale,
        openUrl,
        unsubscribeUrl,
      }),
    subject: (locale) => m.email_frozen_subject({}, { locale }),
  },
];

const roleLabels: Record<string, (locale: Locale) => string> = {
  commenter: (locale) => m.notification_role_commenter({}, { locale }),
  editor: (locale) => m.notification_role_editor({}, { locale }),
  viewer: (locale) => m.notification_role_viewer({}, { locale }),
};

function goMap(name: string, doc: string, entries: Map<string, string>) {
  const rows = [...entries]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [`${JSON.stringify(key)}:`, value] as const);
  // gofmt aligns map values into a column; emit it pre-aligned so the output is
  // stable without shelling out to Go.
  const width = Math.max(...rows.map(([label]) => label.length));
  const lines = rows
    .map(([label, value]) => {
      const padding = ' '.repeat(width - label.length + 1);
      return `\t${label}${padding}${JSON.stringify(value)},`;
    })
    .join('\n');
  return `${doc}\nvar ${name} = map[string]string{\n${lines}\n}\n`;
}

const subjects = new Map<string, string>();
const roles = new Map<string, string>();

await mkdir(templateDir, { recursive: true });
for (const locale of locales as readonly Locale[]) {
  for (const template of templates) {
    const key = `${template.name}.${locale}`;
    subjects.set(key, template.subject(locale));

    const html = await render(template.render(locale));
    await writeFile(join(templateDir, `${key}.gohtml`), `${html.trim()}\n`);
    await writeFile(
      join(templateDir, `${key}.txt`),
      `${toPlainText(html).trim()}\n`
    );
  }
  for (const [role, label] of Object.entries(roleLabels)) {
    roles.set(`${role}.${locale}`, label(locale));
  }
}

const generatedGo = [
  '// Code generated by scripts/build-emails.ts. DO NOT EDIT.',
  '// Source of truth: messages/*.json. Run `pnpm email:build` to regenerate.',
  '',
  'package mail',
  '',
  goMap(
    'subjectTemplates',
    '// subjectTemplates holds subject lines keyed by "<template>.<locale>". They\n// are Go text/template sources and share the body templates\' data.',
    subjects
  ),
  goMap(
    'roleLabels',
    '// roleLabels holds workspace role names keyed by "<role>.<locale>".',
    roles
  ),
].join('\n');

await writeFile(join(mailDir, 'copy_gen.go'), generatedGo);
