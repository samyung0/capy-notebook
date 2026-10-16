import { z } from 'zod';

export const emailLocales = ['en', 'zh'] as const;
export const emailLocaleSchema = z.enum(emailLocales);
export type EmailLocale = z.infer<typeof emailLocaleSchema>;

export const mailyDocumentSchema = z.object({
  content: z.array(z.unknown()),
  type: z.literal('doc'),
});

export const emailTemplateSourceSchema = z.object({
  content: mailyDocumentSchema,
  preview: z.string().min(1),
  schemaVersion: z.literal(1),
  subject: z.string().min(1),
});

export type EmailTemplateSource = z.infer<typeof emailTemplateSourceSchema>;

const variable = (name: string, sample: string) => ({ name, sample });

export const emailTemplateDefinitions = [
  {
    id: 'workspace-invite',
    label: 'Workspace invitation',
    variables: [
      variable('Access', 'Can edit'),
      variable('InviteURL', 'https://example.test/invite'),
      variable('InviterName', 'Alex Chen'),
      variable('UnsubscribeURL', 'https://example.test/settings'),
      variable('WorkspaceName', 'Biology'),
    ],
  },
  {
    id: 'workspace-invite-accepted',
    label: 'Workspace invitation accepted',
    variables: [
      variable('Access', 'Can edit'),
      variable('MemberName', 'Mia Wong'),
      variable('OpenURL', 'https://example.test/workspaces/ws_1'),
      variable('UnsubscribeURL', 'https://example.test/settings'),
      variable('WorkspaceName', 'Biology'),
    ],
  },
  {
    id: 'welcome',
    label: 'Welcome',
    variables: [variable('OpenURL', 'https://example.test/workspaces')],
  },
  {
    id: 'account-deletion-requested',
    label: 'Account deletion requested',
    variables: [
      variable('DeletionDate', '13 Nov 2026'),
      variable('GraceDays', '30'),
      variable('OpenURL', 'https://example.test/support'),
    ],
  },
  {
    id: 'account-deletion-cancelled',
    label: 'Account deletion cancelled',
    variables: [variable('OpenURL', 'https://example.test/workspaces')],
  },
  {
    id: 'subscription-started',
    label: 'Subscription started',
    variables: [
      variable('OpenURL', 'https://example.test/billing?tab=subscription'),
      variable('RenewsOn', '14 Nov 2026'),
      variable('UnsubscribeURL', 'https://example.test/settings'),
    ],
  },
  {
    id: 'subscription-cancelled',
    label: 'Subscription cancelled',
    variables: [
      variable('EndsOn', '14 Nov 2026'),
      variable('OpenURL', 'https://example.test/billing?tab=subscription'),
      variable('StorageUsed', '640 MB'),
      variable('UnsubscribeURL', 'https://example.test/settings'),
    ],
  },
  {
    id: 'subscription-ended',
    label: 'Subscription ended',
    variables: [
      variable('EndsOn', '14 Nov 2026'),
      variable('OpenURL', 'https://example.test/billing?tab=subscription'),
      variable('StorageUsed', '640 MB'),
      variable('UnsubscribeURL', 'https://example.test/settings'),
    ],
  },
  {
    id: 'subscription-over-quota',
    label: 'Subscription over quota',
    variables: [
      variable('GraceEndsAt', '28 Oct 2026'),
      variable('OpenURL', 'https://example.test/billing?tab=subscription'),
      variable('StorageLimit', '100 MB'),
      variable('StorageUsed', '640 MB'),
      variable('UnsubscribeURL', 'https://example.test/settings'),
    ],
  },
  {
    id: 'credit-reload-skipped',
    label: 'Auto-reload skipped',
    variables: [
      variable('Amount', '$10'),
      variable('Limit', '$50'),
      variable('OpenURL', 'https://example.test/billing?tab=subscription'),
      variable('UnsubscribeURL', 'https://example.test/settings'),
    ],
  },
  {
    id: 'subscription-frozen',
    label: 'Subscription frozen',
    variables: [
      variable('GraceEndsAt', '28 Oct 2026'),
      variable('OpenURL', 'https://example.test/billing?tab=subscription'),
      variable('StorageLimit', '100 MB'),
      variable('StorageUsed', '640 MB'),
      variable('UnsubscribeURL', 'https://example.test/settings'),
    ],
  },
  {
    id: 'office-maintenance',
    label: 'Office maintenance',
    variables: [
      variable('Hours', '4'),
      variable('OpenURL', 'https://example.test/workspaces'),
      variable('StartsAt', '13 Oct 2026, 02:00 UTC'),
    ],
  },
] as const;

export type EmailTemplateDefinition = (typeof emailTemplateDefinitions)[number];
export type EmailTemplateId = EmailTemplateDefinition['id'];

export function getEmailTemplateDefinition(id: string) {
  return emailTemplateDefinitions.find((definition) => definition.id === id);
}

const GO_PLACEHOLDER_PATTERN = /\{\{\.([A-Za-z][A-Za-z0-9]*)\}\}/g;

function collectDocumentVariables(
  value: unknown,
  variables: Set<string>,
  unsupported: Set<string>
) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectDocumentVariables(item, variables, unsupported);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;

  const node = value as Record<string, unknown>;
  const attrs =
    node.attrs && typeof node.attrs === 'object'
      ? (node.attrs as Record<string, unknown>)
      : undefined;

  if (node.type === 'variable' && typeof attrs?.id === 'string') {
    variables.add(attrs.id);
  }
  if (attrs?.isTextVariable === true && typeof attrs.text === 'string') {
    variables.add(attrs.text);
  }
  if (attrs?.isUrlVariable === true && typeof attrs.url === 'string') {
    variables.add(attrs.url);
  }
  if (
    attrs?.isExternalLinkVariable === true &&
    typeof attrs.externalLink === 'string'
  ) {
    variables.add(attrs.externalLink);
  }
  if (attrs?.isSrcVariable === true && typeof attrs.src === 'string') {
    variables.add(attrs.src);
  }
  if (node.type === 'link' && attrs?.isUrlVariable === true) {
    const href = attrs.href;
    if (typeof href === 'string') variables.add(href);
  }
  if (node.type === 'repeat' || node.type === 'for') {
    unsupported.add(String(node.type));
  }
  if (typeof attrs?.showIfKey === 'string' && attrs.showIfKey) {
    unsupported.add('conditional visibility');
  }

  for (const child of Object.values(node)) {
    collectDocumentVariables(child, variables, unsupported);
  }
}

function collectGoPlaceholders(value: string, variables: Set<string>) {
  for (const match of value.matchAll(GO_PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (name) variables.add(name);
  }
}

export function fillTemplateVariables(
  definition: EmailTemplateDefinition,
  value: string
) {
  const samples = new Map(
    definition.variables.map(({ name, sample }) => [name, sample])
  );
  return value.replace(
    GO_PLACEHOLDER_PATTERN,
    (placeholder, name: string) => samples.get(name) ?? placeholder
  );
}

export function validateTemplateVariables(
  definition: EmailTemplateDefinition,
  source: EmailTemplateSource
) {
  const used = new Set<string>();
  const unsupported = new Set<string>();
  collectGoPlaceholders(source.subject, used);
  collectGoPlaceholders(source.preview, used);
  collectDocumentVariables(source.content, used, unsupported);

  if (unsupported.size) {
    throw new Error(
      `${definition.id} uses unsupported dynamic blocks: ${[...unsupported].join(', ')}`
    );
  }

  const expected = new Set(definition.variables.map(({ name }) => name));
  const missing = [...expected].filter((name) => !used.has(name));
  const unknown = [...used].filter((name) => !expected.has(name));

  if (missing.length || unknown.length) {
    const details = [
      missing.length ? `missing: ${missing.join(', ')}` : '',
      unknown.length ? `unknown: ${unknown.join(', ')}` : '',
    ].filter(Boolean);
    throw new Error(
      `${definition.id} has invalid variables (${details.join('; ')})`
    );
  }
}

export const emailRendererTheme = {
  body: {
    backgroundColor: '#f3f3f0',
    paddingBottom: '32px',
    paddingLeft: '12px',
    paddingRight: '12px',
    paddingTop: '32px',
  },
  button: {
    backgroundColor: '#222222',
    color: '#ffffff',
    paddingBottom: '10px',
    paddingLeft: '20px',
    paddingRight: '20px',
    paddingTop: '10px',
  },
  colors: {
    footer: '#6e6e68',
    heading: '#222222',
    horizontal: '#e3e3de',
    paragraph: '#3a3a37',
  },
  container: {
    backgroundColor: '#ffffff',
    borderColor: '#e3e3de',
    borderRadius: '14px',
    borderWidth: '1px',
    maxWidth: '560px',
    minWidth: '300px',
    paddingBottom: '28px',
    paddingLeft: '28px',
    paddingRight: '28px',
    paddingTop: '28px',
  },
  font: {
    fallbackFontFamily: 'sans-serif' as const,
    fontFamily: 'Arial',
    webFont: undefined,
  },
  fontSize: {
    footer: { lineHeight: '19px', size: '12.5px' },
    paragraph: { lineHeight: '24px', size: '15px' },
  },
  link: { color: '#5a4bc2' },
};
