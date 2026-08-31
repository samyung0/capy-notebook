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
      variable('InviteURL', 'https://example.test/invite'),
      variable('UnsubscribeURL', 'https://example.test/settings'),
      variable('WorkspaceName', 'Biology'),
    ],
  },
  {
    id: 'workspace-role-changed',
    label: 'Workspace role changed',
    variables: [
      variable('OpenURL', 'https://example.test/workspaces/biology'),
      variable('RoleName', 'Editor'),
      variable('UnsubscribeURL', 'https://example.test/settings'),
      variable('WorkspaceName', 'Biology'),
    ],
  },
  {
    id: 'workspace-member-removed',
    label: 'Workspace member removed',
    variables: [
      variable('OpenURL', 'https://example.test'),
      variable('UnsubscribeURL', 'https://example.test/settings'),
      variable('WorkspaceName', 'Biology'),
    ],
  },
  {
    id: 'account-deletion-requested',
    label: 'Account deletion requested',
    variables: [
      variable('GraceDays', '30'),
      variable('OpenURL', 'https://example.test/support'),
      variable('UnsubscribeURL', 'https://example.test/settings'),
    ],
  },
  {
    id: 'account-deletion-cancelled',
    label: 'Account deletion cancelled',
    variables: [
      variable('OpenURL', 'https://example.test/settings'),
      variable('UnsubscribeURL', 'https://example.test/settings'),
    ],
  },
  {
    id: 'subscription-over-quota',
    label: 'Subscription over quota',
    variables: [
      variable('OpenURL', 'https://example.test/settings?tab=billing'),
      variable('UnsubscribeURL', 'https://example.test/settings'),
    ],
  },
  {
    id: 'subscription-frozen',
    label: 'Subscription frozen',
    variables: [
      variable('OpenURL', 'https://example.test/settings?tab=billing'),
      variable('UnsubscribeURL', 'https://example.test/settings'),
    ],
  },
  {
    id: 'model-deprecated',
    label: 'Model deprecated',
    variables: [
      variable('FromName', 'DeepSeek Pro'),
      variable('OpenURL', 'https://example.test/settings?tab=llm'),
      variable('ToName', 'DeepSeek Flash'),
      variable('UnsubscribeURL', 'https://example.test/settings'),
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
    backgroundColor: '#f5f5f2',
    paddingBottom: '32px',
    paddingLeft: '12px',
    paddingRight: '12px',
    paddingTop: '32px',
  },
  button: {
    backgroundColor: '#5e5cdb',
    color: '#ffffff',
    paddingBottom: '10px',
    paddingLeft: '18px',
    paddingRight: '18px',
    paddingTop: '10px',
  },
  colors: {
    footer: '#71716b',
    heading: '#252525',
    horizontal: '#e2e2dc',
    paragraph: '#252525',
  },
  container: {
    backgroundColor: '#ffffff',
    borderColor: '#e2e2dc',
    borderRadius: '12px',
    borderWidth: '1px',
    maxWidth: '560px',
    minWidth: '300px',
    paddingBottom: '32px',
    paddingLeft: '32px',
    paddingRight: '32px',
    paddingTop: '32px',
  },
  font: {
    fallbackFontFamily: 'sans-serif' as const,
    fontFamily: 'Arial',
    webFont: undefined,
  },
  fontSize: {
    footer: { lineHeight: '18px', size: '12px' },
    paragraph: { lineHeight: '22px', size: '14px' },
  },
  link: { color: '#5e5cdb' },
};
