import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { APIRequestContext, FrameLocator, Page } from '@playwright/test';
import { expect, test } from '../fixtures/actors';
import { seed, users } from '../fixtures/seed';
import { uploadSourceFile } from '../helpers/api';
import { collaborationLink } from '../helpers/collaboration';
import { expectEditorLive } from '../helpers/editor';
import { type OfficeFormat, officeEditMenu } from '../helpers/office';
import { openWorkspaceMaterial } from '../helpers/workspace';

/*
 * The chat agent's writes, end to end on the stack: each test replays a tool
 * call against Go's internal agent routes (as the retrieval service sends it
 * after expanding the model's arguments) instead of running a model, then
 * checks that the write lands where it was meant, that untouched blocks keep
 * their content and ids, that one Undo restores the whole change, and that
 * editors already open (the owner's tab and a collaborator's) show it live.
 * An edit's Undo sends back the payload its receipt carried, as the chat does.
 */

const workspaceId = seed.agentWorkspace.id;
const assistantMessageId = seed.agentWorkspace.assistantMessageId;
const configuredSecret = process.env.E2E_PIPELINE_SECRET;
if (!configuredSecret)
  throw new Error('E2E_PIPELINE_SECRET must be set by playwright.config.ts');
const pipelineSecret: string = configuredSecret;

type Node = { [key: string]: unknown; children?: Node[]; id?: string };
type Receipt = {
  effect?: {
    resource: { id: string; kind: string };
    undo?: { operationId: string; status: string };
  };
  error?: { code: string; message: string };
  operationId: string;
  outcome: string;
  undoPayload?: object;
};
type Target = { id: string; kind: 'material' | 'source_file' };

/** The notes, diagrams and files a test made, trashed after it so other
 * specs on the same stack see the owner's account as seeded. */
const made: string[] = [];
test.afterEach(async ({ ownerApi }) => {
  for (const path of made.splice(0)) {
    const response = await ownerApi.delete(path);
    expect([204, 404], `${path}: ${response.status()}`).toContain(
      response.status()
    );
  }
});

/** One tool call to an internal agent route, as the owner's chat turn. */
function call(api: APIRequestContext, path: string, body: object) {
  return api.post(path, {
    data: {
      assistantMessageId,
      toolCallId: `call_${randomUUID()}`,
      userId: users.owner,
      workspaceId,
      ...body,
    },
    headers: { 'X-Pipeline-Secret': pipelineSecret },
  });
}

async function agent<T>(api: APIRequestContext, path: string, body: object) {
  const response = await call(api, path, body);
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as T;
}

async function createNote(
  api: APIRequestContext,
  markdown: string,
  figures: { id: string; image: string }[] = []
) {
  const receipt = await agent<Receipt>(api, '/api/internal/materials', {
    content: markdown,
    figures,
    kind: 'note',
    title: `Agent note ${randomUUID()}`,
  });
  expect(receipt.outcome, JSON.stringify(receipt)).toBe('succeeded');
  const id = receipt.effect!.resource.id;
  made.push(`/api/materials/${id}`);
  return id;
}

async function edit(
  api: APIRequestContext,
  target: Target,
  commands: object[],
  figures: { id: string; image: string }[] = [],
  office = false
) {
  const receipt = await agent<Receipt>(api, '/api/internal/documents/edit', {
    commands,
    figures,
    office,
    target,
  });
  expect(receipt.outcome, JSON.stringify(receipt)).toBe('succeeded');
  expect(receipt.effect?.undo?.status).toBe('available');
  expect(receipt.undoPayload).toBeDefined();
  payloads.set(receipt.effect!.undo!.operationId, receipt.undoPayload);
  return receipt.effect!.undo!.operationId;
}

/** Each step's Undo payload, which the chat keeps in the browser. */
const payloads = new Map<string, object | undefined>();

/** inspect_document's read, or inspect_office_document's with `office`. */
async function inspect<T>(
  api: APIRequestContext,
  target: Target,
  office?: object
) {
  const response = await api.post('/api/internal/documents/inspect', {
    data: { count: 200, office, target, userId: users.owner, workspaceId },
    headers: { 'X-Pipeline-Secret': pipelineSecret },
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as T;
}

type Block = {
  id: string;
  properties?: Record<string, string>;
  text: string;
  type: string;
};
type Entry = { id: string; label: string; position: string; value: string };
const blocks = async (api: APIRequestContext, id: string) =>
  (await inspect<{ blocks: Block[] }>(api, { id, kind: 'material' })).blocks;
type Sheet = { id: string; name: string; usedRange: string };
type Cell = { address: string; input: string; value: string };
type Paragraph = { id: string; text: string };
/** An Office source as the agent reads it: DOCX paragraphs and each PPTX
 * slide's paragraphs (their text as value), or the cells of an XLSX's first
 * sheet (by address, their input as value). */
async function entries(
  api: APIRequestContext,
  id: string,
  format: OfficeFormat
): Promise<Entry[]> {
  const target = { id, kind: 'source_file' } as const;
  if (format === 'docx') {
    const read = await inspect<{ scoped: { paragraphs: Paragraph[] } }>(
      api,
      target,
      { count: 200 }
    );
    return read.scoped.paragraphs.map((paragraph) => ({
      id: paragraph.id,
      label: '',
      position: '',
      value: paragraph.text,
    }));
  }
  if (format === 'pptx') {
    // Each slide's paragraphs, positioned by slide and shape.
    const deck = await inspect<{ scoped: { slides: { number: number }[] } }>(
      api,
      target,
      { count: 200 }
    );
    const slides = await Promise.all(
      deck.scoped.slides.map(({ number }) =>
        inspect<{
          scoped: { paragraphs: (Paragraph & { shape: string })[] };
        }>(api, target, { count: 200, slide: number })
      )
    );
    return slides.flatMap((read, i) =>
      read.scoped.paragraphs.map((paragraph) => ({
        id: paragraph.id,
        label: '',
        position: `${i + 1}/${paragraph.shape}`,
        value: paragraph.text,
      }))
    );
  }
  const listed = await inspect<{ scoped: { sheets: Sheet[] } }>(
    api,
    target,
    {}
  );
  const [sheet] = listed.scoped.sheets;
  const read = await inspect<{ scoped: { cells: Cell[] } }>(api, target, {
    range: sheet.usedRange,
    sheet: sheet.name,
  });
  return read.scoped.cells.map((cell) => ({
    id: cell.address,
    label: sheet.name,
    position: '',
    value: cell.input,
  }));
}

/** The chat card's Undo, by the owner. */
async function undo(ownerApi: APIRequestContext, operationId: string) {
  const response = await ownerApi.post(
    `/api/chat/edit-operations/${operationId}/undo`,
    { data: { payload: payloads.get(operationId), requestId: randomUUID() } }
  );
  expect(response.status(), await response.text()).toBe(200);
}

/** A note's saved projection (the read model Go serves). */
async function projection(api: APIRequestContext, id: string) {
  const response = await api.get(`/api/materials/${id}`);
  expect(response.status(), await response.text()).toBe(200);
  const material = (await response.json()) as {
    content: { value: Node[] };
  };
  return material.content.value;
}

/** Waits until the projection holds `expected` (it trails the commit). */
async function projectionIs(
  api: APIRequestContext,
  id: string,
  expected: Node[]
) {
  await expect
    .poll(() => projection(api, id), { timeout: 20_000 })
    .toEqual(expected);
}

const byId = (value: Node[]) =>
  new Map(value.map((node) => [node.id as string, node]));

/** Blocks of `after` named in `before` minus `touched`, which must be equal. */
function expectUntouched(before: Node[], after: Node[], touched: string[]) {
  const kept = before.filter((node) => !touched.includes(node.id as string));
  const now = byId(after);
  expect(kept.map((node) => now.get(node.id as string))).toEqual(kept);
}

/** The top-level block ids an open note editor shows, in order. */
function liveBlockIds(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-slate-editor="true"]');
    if (!root) return [];
    return [...root.querySelectorAll('[data-block-id]')]
      .filter((el) => !el.parentElement?.closest('[data-block-id]'))
      .map((el) => el.getAttribute('data-block-id'));
  });
}

async function expectLive(pages: Page[], value: Node[]) {
  for (const page of pages)
    await expect
      .poll(() => liveBlockIds(page), { timeout: 20_000 })
      .toEqual(value.map((node) => node.id));
}

const textOf = (node: Node): string =>
  typeof node.text === 'string'
    ? node.text
    : (node.children ?? []).map(textOf).join('');

/** Clicks the end of a paragraph and types, as live-collaboration.spec.ts
 * explains (bare End leaves Slate a stale caret). */
async function typeAtEnd(page: Page, text: string, typed: string) {
  const target = page
    .locator('[contenteditable="true"]')
    .first()
    .getByText(text, { exact: true });
  const box = await target.boundingBox();
  if (!box) throw new Error('paragraph has no layout box');
  await target.click({
    force: true,
    position: { x: Math.max(box.width - 1, 0), y: box.height / 2 },
  });
  await page.keyboard.type(typed);
  await expect(
    page.getByText(`${text}${typed}`, { exact: true })
  ).toBeVisible();
}

async function openNote(pages: Page[], id: string) {
  await Promise.all(
    pages.map((page) => openWorkspaceMaterial(page, workspaceId, id))
  );
  for (const page of pages) await expectEditorLive(page);
}

/** A library figure as the retrieval service renders it: JPEG bytes. */
async function jpeg(page: Page, colour: string) {
  const url = await page.evaluate((fill) => {
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 64;
    const context = canvas.getContext('2d')!;
    context.fillStyle = fill;
    context.fillRect(0, 0, 96, 64);
    return canvas.toDataURL('image/jpeg', 0.9);
  }, colour);
  return url.slice(url.indexOf(',') + 1);
}

/** A quiz fence as the pipeline hands it to Go: the expanded question format. */
function quizFence(
  questions: { id: string; text: string; options: string[] }[]
) {
  const expanded = questions.map((q) => ({
    id: q.id,
    labels: 'letters',
    layout: 'paper',
    parts: [
      {
        answer: { correct: [0], options: q.options, type: 'mcq' },
        blocks: [{ text: q.text, type: 'text' }],
        id: `${q.id}-a`,
        marks: 1,
        solution: [],
      },
    ],
    stem: [],
  }));
  return `\`\`\`quiz\n${JSON.stringify({ questions: expanded })}\n\`\`\``;
}

/** An interactive snippet with what Plate's MDX pass used to rewrite or drop
 * (`for=`, `class=`, a script loop), as main 7719d357 describes. */
const embedHtml = (caption: string, marker: string) =>
  [
    `<label for="${marker}-n" class="k">${caption}</label>`,
    `<div id="${marker}"></div>`,
    `<script>for(var i=0;i<3;i++){var b=i}document.getElementById('${marker}').dataset.ran='yes'+b;</script>`,
  ].join('\n');

const htmlEmbed = (caption: string, marker: string) =>
  [
    '```html-embed',
    `caption: "${caption}"`,
    'html: |',
    ...embedHtml(caption, marker)
      .split('\n')
      .map((line) => `  ${line}`),
    '```',
  ].join('\n');

/** Every block an agent note can hold, in the fence format Go receives. */
function richMarkdown(tag: string) {
  return [
    `# ${tag} field notes`,
    `${tag}: sets like {2, 3} and a stray < sign stay text.`,
    `Tides flood the [salt marsh](https://example.com/${tag}) twice a day, over $A = \\pi r^2$ of it.`,
    '$$\nQ = v \\cdot A\n$$',
    `| Zone | Flooded |\n| --- | --- |\n| ${tag} low marsh | Daily |`,
    `\`\`\`mermaid\nflowchart LR\n  ${tag}Tide --> Marsh\n\`\`\``,
    htmlEmbed(`${tag} tide slider`, `${tag}-embed`),
    quizFence([
      {
        id: `q_${tag}_1`,
        options: ['Low marsh', 'High marsh'],
        text: `${tag}: which zone floods daily?`,
      },
      {
        id: `q_${tag}_2`,
        options: ['Twice', 'Once'],
        text: `${tag}: how often do tides flood?`,
      },
    ]),
    `\`\`\`flashcards\ncards:\n  - front: ${tag} salt marsh\n    back: Coastal grassland flooded by tides\n  - front: ${tag} mudflat\n    back: Bare sediment between tides\n\`\`\``,
    `![${tag} marsh transect](figure:fig_${tag})`,
    `![${tag} web picture](https://example.com/${tag}.png)`,
  ].join('\n\n');
}

const RICH_TYPES = [
  'h1',
  'p',
  'p',
  'equation',
  'table',
  'mermaid',
  'html_embed',
  'material_ref',
  'material_ref',
  'img',
  'p',
];

/** What the editor shows of the rich blocks in `value` once they are live.
 * Embeds join their rooms only near the screen, so each is scrolled to. */
async function expectRichBlocksShown(page: Page, tag: string, value: Node[]) {
  const block = (type: string, n = 0) =>
    page.locator(
      `[data-block-id="${value.filter((node) => node.type === type)[n].id}"]`
    );
  await expect(page.getByText(`${tag} field notes`)).toBeVisible();
  await expect(page.getByText(`${tag} low marsh`)).toBeVisible();
  await block('material_ref', 0).scrollIntoViewIfNeeded();
  await expect(
    page.getByText(`${tag}: which zone floods daily?`).first()
  ).toBeVisible({ timeout: 20_000 });
  await block('material_ref', 1).scrollIntoViewIfNeeded();
  await expect(page.getByText(`${tag} salt marsh`).first()).toBeVisible({
    timeout: 20_000,
  });
  // The html-embed fence became an interactive block whose snippet runs.
  await expect(
    page
      .frameLocator('iframe[sandbox="allow-scripts"]')
      .locator(`#${tag}-embed`)
  ).toHaveAttribute('data-ran', 'yes2', { timeout: 20_000 });
  await block('img').scrollIntoViewIfNeeded();
  const figure = page
    .getByRole('figure', { name: `${tag} marsh transect` })
    .getByRole('img');
  await expect
    .poll(() => figure.evaluate((img: HTMLImageElement) => img.naturalWidth), {
      timeout: 20_000,
    })
    .toBe(96);
}

test.describe('agent writes to notes', () => {
  test.describe.configure({ timeout: 180_000 });

  test('create_material puts every block an agent note holds where its markdown says', async ({
    anonymousApi,
    ownerApi,
    ownerPage,
  }) => {
    const figure = await jpeg(ownerPage, '#2a7');
    const id = await createNote(anonymousApi, richMarkdown('create'), [
      { id: 'fig_create', image: figure },
    ]);
    const value = await projection(ownerApi, id);
    expect(value.map((node) => node.type)).toEqual(RICH_TYPES);
    const [, braces, prose, , , mermaid, embed, quiz, cards, image, web] =
      value;
    expect(braces.children).toEqual([
      { text: 'create: sets like {2, 3} and a stray < sign stay text.' },
    ]);
    expect(prose.children?.map((node) => node.type ?? 'text')).toEqual([
      'text',
      'a',
      'text',
      'inline_equation',
      'text',
    ]);
    expect(mermaid.source).toBe('flowchart LR\n  createTide --> Marsh');
    // The snippet keeps every character the agent wrote.
    expect(embed).toMatchObject({
      caption: 'create tide slider',
      html: `${embedHtml('create tide slider', 'create-embed')}\n`,
    });
    expect([quiz.refKind, cards.refKind]).toEqual(['quiz', 'flashcards']);
    const quizBlocks = await blocks(anonymousApi, quiz.materialId as string);
    expect(quizBlocks[0].type).toBe('quiz');
    expect(image.assetId).toMatch(/^\S+$/);
    expect(image.assetId).not.toContain('figure:');
    // An ordinary web image becomes a link to it, nothing stored.
    expect(web.children?.find((node) => node.type === 'a')?.url).toBe(
      'https://example.com/create.png'
    );

    await openNote([ownerPage], id);
    await expectRichBlocksShown(ownerPage, 'create', value);
  });

  test('insert_markdown lands every block after its anchor, live for two editors, and one Undo removes it all', async ({
    anonymousApi,
    editorPage,
    ownerApi,
    ownerPage,
  }) => {
    const response = await ownerApi.post(
      `/api/workspaces/${workspaceId}/materials`,
      {
        data: {
          content: {
            schemaVersion: 1,
            value: [
              {
                children: [{ text: 'Insert target' }],
                id: 'ins_title',
                type: 'h1',
              },
              {
                children: [{ text: 'Intro paragraph stays.' }],
                id: 'ins_intro',
                type: 'p',
              },
              {
                children: [
                  { text: 'Ask ' },
                  {
                    children: [{ text: '' }],
                    id: 'ins_mention_user',
                    key: users.editor,
                    type: 'mention',
                    value: 'E2E Editor',
                  },
                  { text: ' about the tides.' },
                ],
                id: 'ins_mention',
                type: 'p',
              },
              {
                children: [{ text: 'Closing paragraph stays.' }],
                id: 'ins_end',
                type: 'p',
              },
            ],
          },
          kind: 'note',
          title: `Agent insert ${randomUUID()}`,
        },
      }
    );
    expect(response.status(), await response.text()).toBe(201);
    const { id } = (await response.json()) as { id: string };
    made.push(`/api/materials/${id}`);
    const pages = [ownerPage, editorPage];
    await openNote(pages, id);
    const before = await projection(ownerApi, id);

    const figure = await jpeg(ownerPage, '#a52');
    const operation = await edit(
      anonymousApi,
      { id, kind: 'material' },
      [
        {
          after_block_id: 'ins_intro',
          markdown: richMarkdown('insert'),
          type: 'insert_markdown',
        },
      ],
      [{ id: 'fig_insert', image: figure }]
    );
    await expect
      .poll(async () => (await projection(ownerApi, id)).length, {
        timeout: 20_000,
      })
      .toBe(before.length + RICH_TYPES.length);
    const after = await projection(ownerApi, id);
    expect(after.map((node) => node.type)).toEqual([
      'h1',
      'p',
      ...RICH_TYPES,
      'p',
      'p',
    ]);
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    expect(after.slice(-2)).toEqual(before.slice(-2));
    await expectLive(pages, after);
    for (const page of pages)
      await expectRichBlocksShown(page, 'insert', after);

    await undo(ownerApi, operation);
    await projectionIs(ownerApi, id, before);
    await expectLive(pages, before);
    for (const page of pages)
      await expect(page.getByText('insert field notes')).toHaveCount(0);
  });

  test('replace_text beside a mention, link and inline equation and replace_block on a table, an equation and a diagram keep the rest, live, and Undo restores them', async ({
    anonymousApi,
    editorPage,
    ownerApi,
    ownerPage,
  }) => {
    const response = await ownerApi.post(
      `/api/workspaces/${workspaceId}/materials`,
      {
        data: {
          content: {
            schemaVersion: 1,
            value: [
              {
                children: [
                  { text: 'Ask ' },
                  {
                    children: [{ text: '' }],
                    id: 'rep_mention',
                    key: users.editor,
                    type: 'mention',
                    value: 'E2E Editor',
                  },
                  { text: ' to check ' },
                  {
                    children: [{ text: 'the tide table' }],
                    id: 'rep_link',
                    type: 'a',
                    url: 'https://example.com/tides',
                  },
                  { text: ' where ' },
                  {
                    children: [{ text: '' }],
                    id: 'rep_math',
                    texExpression: 'h = 2t',
                    type: 'inline_equation',
                  },
                  { text: ' holds today.' },
                ],
                id: 'rep_inline',
                type: 'p',
              },
              {
                children: [
                  {
                    children: [
                      {
                        children: [
                          {
                            children: [{ text: 'Zone' }],
                            id: 'rep_c1p',
                            type: 'p',
                          },
                        ],
                        id: 'rep_c1',
                        type: 'th',
                      },
                      {
                        children: [
                          {
                            children: [{ text: 'Old depth' }],
                            id: 'rep_c2p',
                            type: 'p',
                          },
                        ],
                        id: 'rep_c2',
                        type: 'th',
                      },
                    ],
                    id: 'rep_row',
                    type: 'tr',
                  },
                ],
                id: 'rep_table',
                type: 'table',
              },
              {
                children: [{ text: '' }],
                id: 'rep_eq',
                texExpression: 'E = mc^2',
                type: 'equation',
              },
              {
                children: [
                  { children: [{ text: '' }], type: 'mermaid_caption' },
                ],
                id: 'rep_mermaid',
                source: 'flowchart LR\n  OldTide --> Marsh',
                type: 'mermaid',
              },
              {
                children: [{ text: 'Closing paragraph stays.' }],
                id: 'rep_end',
                type: 'p',
              },
            ],
          },
          kind: 'note',
          title: `Agent replace ${randomUUID()}`,
        },
      }
    );
    expect(response.status(), await response.text()).toBe(201);
    const { id } = (await response.json()) as { id: string };
    made.push(`/api/materials/${id}`);
    const pages = [ownerPage, editorPage];
    await openNote(pages, id);
    const before = await projection(ownerApi, id);
    const shown = await blocks(anonymousApi, id);

    const operation = await edit(anonymousApi, { id, kind: 'material' }, [
      {
        expected_text: ' to check ',
        target_id: 'rep_inline',
        text: ' to verify ',
        type: 'replace_text',
      },
      {
        block_id: 'rep_table',
        expected_text: shown[1].text,
        markdown: '| Zone | New depth |\n| --- | --- |\n| Low marsh | 2 m |',
        type: 'replace_block',
      },
      {
        block_id: 'rep_eq',
        expected_text: shown[2].text,
        markdown: '$$\nF = ma\n$$',
        type: 'replace_block',
      },
      {
        block_id: 'rep_mermaid',
        expected_text: shown[3].text,
        markdown: '```mermaid\nflowchart LR\n  NewTide --> Estuary\n```',
        type: 'replace_block',
      },
    ]);
    await expect
      .poll(async () => (await projection(ownerApi, id))[2]?.texExpression, {
        timeout: 20_000,
      })
      .toBe('F = ma');
    const after = await projection(ownerApi, id);
    expect(after.map((node) => node.type)).toEqual([
      'p',
      'table',
      'equation',
      'mermaid',
      'p',
    ]);
    expect(after[3].source).toBe('flowchart LR\n  NewTide --> Estuary');
    // The span changed; the mention, link and inline equation are the same nodes.
    const inlines = (value: Node[]) =>
      value[0].children?.filter((node) => node.type);
    expect(inlines(after)).toEqual(inlines(before));
    expect(after[0].children?.[2]).toEqual({ text: ' to verify ' });
    expectUntouched(before, after, [
      'rep_inline',
      'rep_table',
      'rep_eq',
      'rep_mermaid',
    ]);
    await expectLive(pages, after);
    for (const page of pages) {
      await expect(page.getByText('to verify')).toBeVisible();
      await expect(page.getByText('New depth')).toBeVisible();
      await expect(page.getByText('@E2E Editor')).toBeVisible();
      await expect(page.getByText('the tide table')).toBeVisible();
      await expect(page.getByText('NewTide')).toBeVisible();
    }

    await undo(ownerApi, operation);
    await projectionIs(ownerApi, id, before);
    await expectLive(pages, before);
    for (const page of pages) {
      await expect(page.getByText('to check')).toBeVisible();
      await expect(page.getByText('Old depth')).toBeVisible();
      await expect(page.getByText('OldTide')).toBeVisible();
    }
  });

  test('remove_block on embeds, a diagram, an interactive and a figure comes back whole on Undo', async ({
    anonymousApi,
    editorPage,
    ownerApi,
    ownerPage,
  }) => {
    const figure = await jpeg(ownerPage, '#36c');
    const id = await createNote(anonymousApi, richMarkdown('remove'), [
      { id: 'fig_remove', image: figure },
    ]);
    const pages = [ownerPage, editorPage];
    await openNote(pages, id);
    const before = await projection(ownerApi, id);
    for (const page of pages)
      await expectRichBlocksShown(page, 'remove', before);
    const shown = await blocks(anonymousApi, id);
    // A block holding media goes like any other (Epo 2026-10-21).
    const removed = shown.filter((block) =>
      ['mermaid', 'html_embed', 'material_ref', 'img'].includes(block.type)
    );
    expect(removed).toHaveLength(5);

    const operation = await edit(
      anonymousApi,
      { id, kind: 'material' },
      removed.map((block) => ({
        block_id: block.id,
        expected_text: block.text,
        type: 'remove_block',
      }))
    );
    const kept = before.filter(
      (node) => !removed.some((block) => block.id === node.id)
    );
    await projectionIs(ownerApi, id, kept);
    await expectLive(pages, kept);
    for (const page of pages) {
      await expect(
        page.getByText('remove: which zone floods daily?')
      ).toHaveCount(0);
      await expect(page.locator('iframe[sandbox="allow-scripts"]')).toHaveCount(
        0
      );
      await expect(
        page.getByRole('figure', { name: 'remove marsh transect' })
      ).toHaveCount(0);
    }

    await undo(ownerApi, operation);
    await projectionIs(ownerApi, id, before);
    await expectLive(pages, before);
    // The children pass brings back the rows and the asset the removal let go.
    for (const page of pages)
      await expectRichBlocksShown(page, 'remove', before);
  });

  test("edits to a note's embedded quiz and flashcard set reach the open note and Undo restores them", async ({
    anonymousApi,
    editorPage,
    ownerApi,
    ownerPage,
  }) => {
    const id = await createNote(
      anonymousApi,
      [
        '# Embedded items',
        quizFence([
          {
            id: 'q_items_1',
            options: ['Low marsh', 'High marsh'],
            text: 'Items: which zone floods daily?',
          },
          {
            id: 'q_items_2',
            options: ['Twice', 'Once'],
            text: 'Items: how often do tides flood?',
          },
        ]),
        '```flashcards\ncards:\n  - front: Items salt marsh\n    back: Coastal grassland\n  - front: Items mudflat\n    back: Bare sediment\n```',
        // A closing paragraph: an open editor appends an empty one after a
        // trailing embed, which would change the note under the test.
        'Items end.',
      ].join('\n\n')
    );
    const pages = [ownerPage, editorPage];
    await openNote(pages, id);
    const note = await projection(ownerApi, id);
    const quizId = note[1].materialId as string;
    const cardsId = note[2].materialId as string;
    for (const page of pages) {
      await expect(
        page.getByText('Items: which zone floods daily?')
      ).toBeVisible();
      await expect(page.getByText('Items mudflat')).toBeVisible();
    }

    type Item = { children: { id: string; text: string; type: string }[] };
    const items = async (target: string) =>
      (
        await inspect<{ blocks: Item[] }>(anonymousApi, {
          id: target,
          kind: 'material',
        })
      ).blocks[0].children;

    const questions = await items(quizId);
    expect(questions).toHaveLength(2);
    const [first, second] = questions;
    const rewritten = JSON.parse(first.text);
    rewritten.parts[0].blocks = [
      { text: 'Items: which zone floods twice a day?', type: 'text' },
    ];
    const added = {
      id: 'q_items_3',
      labels: 'letters',
      layout: 'paper',
      parts: [
        {
          answer: { correct: [0], options: ['Spring', 'Neap'], type: 'mcq' },
          blocks: [{ text: 'Items: which tide is highest?', type: 'text' }],
          id: 'q_items_3-a',
          marks: 1,
          solution: [],
        },
      ],
      stem: [],
    };
    const quizOperation = await edit(
      anonymousApi,
      { id: quizId, kind: 'material' },
      [
        {
          question: rewritten,
          question_id: first.id,
          type: 'replace_question',
        },
        { question_id: second.id, type: 'remove_question' },
        { after_question_id: first.id, question: added, type: 'add_question' },
      ]
    );
    const quizAfter = await items(quizId);
    expect(quizAfter.map((q) => q.id)).toEqual([first.id, 'q_items_3']);
    for (const page of pages) {
      await expect(
        page.getByText('Items: which zone floods twice a day?')
      ).toBeVisible();
      await expect(
        page.getByText('Items: which tide is highest?')
      ).toBeVisible();
      await expect(
        page.getByText('Items: how often do tides flood?')
      ).toHaveCount(0);
    }
    await undo(ownerApi, quizOperation);
    expect(await items(quizId)).toEqual(questions);
    for (const page of pages) {
      await expect(
        page.getByText('Items: which zone floods daily?')
      ).toBeVisible();
      await expect(
        page.getByText('Items: how often do tides flood?')
      ).toBeVisible();
      await expect(page.getByText('Items: which tide is highest?')).toHaveCount(
        0
      );
    }

    const cards = await items(cardsId);
    expect(cards).toHaveLength(2);
    const cardOperation = await edit(
      anonymousApi,
      { id: cardsId, kind: 'material' },
      [
        {
          back: 'Coastal grassland flooded by tides',
          card_id: cards[0].id,
          expected_back: 'Coastal grassland',
          expected_front: 'Items salt marsh',
          front: 'Items salt marsh, rewritten',
          type: 'replace_card',
        },
        { card_id: cards[1].id, type: 'remove_card' },
        {
          after_card_id: cards[0].id,
          back: 'Where rivers meet the sea',
          front: 'Items estuary',
          type: 'add_card',
        },
      ]
    );
    const cardsAfter = await items(cardsId);
    expect(cardsAfter[0].id).toBe(cards[0].id);
    expect(cardsAfter).toHaveLength(2);
    for (const page of pages) {
      await expect(page.getByText('Items salt marsh, rewritten')).toBeVisible();
      await expect(page.getByText('Items estuary')).toBeVisible();
      await expect(page.getByText('Items mudflat')).toHaveCount(0);
    }
    await undo(ownerApi, cardOperation);
    expect(await items(cardsId)).toEqual(cards);
    for (const page of pages) {
      await expect(page.getByText('Items mudflat')).toBeVisible();
      await expect(page.getByText('Items estuary')).toHaveCount(0);
    }
    // The note itself never changed.
    expect(await projection(ownerApi, id)).toEqual(note);
  });

  test("the agent reads a collaborator's unsaved typing; an edit beside it keeps both; Undo keeps everyone's typing, in the edited block too", async ({
    anonymousApi,
    editorPage,
    ownerApi,
    ownerPage,
  }) => {
    const paragraph = (id: string, text: string) => ({
      children: [{ text }],
      id,
      type: 'p',
    });
    const response = await ownerApi.post(
      `/api/workspaces/${workspaceId}/materials`,
      {
        data: {
          content: {
            schemaVersion: 1,
            value: [
              paragraph('col_a', 'Owner types here.'),
              paragraph('col_b', 'The agent rewrites this sentence.'),
              paragraph('col_c', 'Collaborator types here.'),
            ],
          },
          kind: 'note',
          title: `Agent beside typing ${randomUUID()}`,
        },
      }
    );
    expect(response.status(), await response.text()).toBe(201);
    const { id } = (await response.json()) as { id: string };
    made.push(`/api/materials/${id}`);
    const pages = [ownerPage, editorPage];
    await openNote(pages, id);
    const target = { id, kind: 'material' as const };
    const shows = async (text: string) => {
      for (const page of pages)
        await expect(page.getByText(text, { exact: true })).toBeVisible();
    };

    // The owner's keystrokes are in the room, not yet stored (a note room
    // stores 2 s after the last one): the agent's read merges the room as
    // its edit does, so it reads what the editors see (Epo 2026-10-13).
    await typeAtEnd(ownerPage, 'Owner types here.', ' Typed live.');
    await shows('Owner types here. Typed live.');
    expect((await blocks(anonymousApi, id)).map((block) => block.text)).toEqual(
      [
        'Owner types here. Typed live.',
        'The agent rewrites this sentence.',
        'Collaborator types here.',
      ]
    );
    const operation = await edit(anonymousApi, target, [
      {
        expected_text: 'rewrites this',
        target_id: 'col_b',
        text: 'rewrote that',
        type: 'replace_text',
      },
    ]);
    await shows('Owner types here. Typed live.');
    await shows('The agent rewrote that sentence.');

    // Typing in another block leaves the Undo valid, and the Undo leaves it.
    await typeAtEnd(editorPage, 'Collaborator types here.', ' Kept.');
    await shows('Collaborator types here. Kept.');
    await undo(ownerApi, operation);
    await shows('The agent rewrites this sentence.');
    await shows('Owner types here. Typed live.');
    await shows('Collaborator types here. Kept.');

    // Typing in the edited block keeps the Undo, which reverts the agent's
    // text alone, as an editor's undo does (Epo 2026-10-20).
    const second = await edit(anonymousApi, target, [
      {
        expected_text: 'rewrites this',
        target_id: 'col_b',
        text: 'rewrote that',
        type: 'replace_text',
      },
    ]);
    await shows('The agent rewrote that sentence.');
    await typeAtEnd(editorPage, 'The agent rewrote that sentence.', ' Edited.');
    // Shown in the owner's page too, so the room holds the keystrokes.
    await shows('The agent rewrote that sentence. Edited.');
    await undo(ownerApi, second);
    await shows('The agent rewrites this sentence. Edited.');
    await expect
      .poll(async () => (await projection(ownerApi, id)).map(textOf), {
        timeout: 30_000,
      })
      .toEqual([
        'Owner types here. Typed live.',
        'The agent rewrites this sentence. Edited.',
        'Collaborator types here. Kept.',
      ]);
  });

  test('replace_block on a diagram reaches its open editors and Undo restores the source', async ({
    anonymousApi,
    editorPage,
    ownerApi,
    ownerPage,
  }) => {
    const source = 'flowchart LR\n  SeaWall --> Marsh';
    const receipt = await agent<Receipt>(
      anonymousApi,
      '/api/internal/materials',
      {
        content: `\`\`\`mermaid\n${source}\n\`\`\``,
        kind: 'diagram',
        title: `Agent diagram ${randomUUID()}`,
      }
    );
    expect(receipt.outcome, JSON.stringify(receipt)).toBe('succeeded');
    const id = receipt.effect!.resource.id;
    made.push(`/api/materials/${id}`);
    const pages = [ownerPage, editorPage];
    await openNote(pages, id);
    for (const page of pages)
      await expect(page.getByText('SeaWall').first()).toBeVisible();
    const before = await projection(ownerApi, id);

    // set_mermaid is gone: the diagram's one block is replaced from a
    // ```mermaid fence like any block (Epo 2026-10-21), with a new id.
    const [diagram] = await blocks(anonymousApi, id);
    // Its inspected text is its source, what the rewrite expects; a caption
    // stays apart, never compared (Epo 2026-10-22).
    expect(diagram.text).toBe(source);
    // The rewrite is one ```mermaid fence and nothing else (review r1 M1): a
    // paragraph or a second fence beside it, or a figure, is refused and the
    // diagram stays as it was.
    const fence = (body: string) => `\`\`\`mermaid\n${body}\n\`\`\``;
    const oneFence =
      'replace_block on a diagram takes one ```mermaid fence and nothing else';
    const figure = await jpeg(ownerPage, '#c63');
    for (const attempt of [
      {
        markdown: `${fence(source)}\n\nA paragraph the diagram would not show.`,
        message: oneFence,
      },
      {
        markdown: `${fence(source)}\n\n${fence('flowchart LR\n  Hidden --> Diagram')}`,
        message: oneFence,
      },
      {
        figures: [{ id: 'fig_diagram', image: figure }],
        markdown: '![A marsh transect](figure:fig_diagram)',
        message: 'only a note or a quiz shows figures',
      },
    ]) {
      const refused = await call(anonymousApi, '/api/internal/documents/edit', {
        commands: [
          {
            block_id: diagram.id,
            expected_text: diagram.text,
            markdown: attempt.markdown,
            type: 'replace_block',
          },
        ],
        figures: attempt.figures ?? [],
        target: { id, kind: 'material' },
      });
      expect(refused.status(), attempt.markdown).not.toBe(200);
      expect(await refused.json()).toMatchObject({
        code: 'invalid_input',
        message: attempt.message,
      });
    }
    expect(await projection(ownerApi, id)).toEqual(before);
    const rewritten = 'flowchart LR\n  SeaWall --> Saltmarsh --> Estuary';
    const operation = await edit(anonymousApi, { id, kind: 'material' }, [
      {
        block_id: diagram.id,
        expected_text: diagram.text,
        markdown: `\`\`\`mermaid\n${rewritten}\n\`\`\``,
        type: 'replace_block',
      },
    ]);
    // The open room admits it like a person's edit (Q402), and View's read
    // asks that room for a fresh projection (Q453): no wait for the 30 s
    // idle projection.
    await expect
      .poll(
        async () => (await projection(ownerApi, id)).map((node) => node.source),
        { timeout: 10_000 }
      )
      .toEqual([rewritten]);
    for (const page of pages)
      await expect(page.getByText('Estuary').first()).toBeVisible({
        timeout: 20_000,
      });

    await undo(ownerApi, operation);
    await expect
      .poll(() => projection(ownerApi, id), { timeout: 10_000 })
      .toEqual(before);
    for (const page of pages)
      await expect(page.getByText('Estuary')).toHaveCount(0, {
        timeout: 20_000,
      });
  });
});

const OFFICE = {
  docx: {
    contentType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    name: 'lesson.docx',
  },
  pptx: {
    contentType:
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    name: 'lesson.pptx',
  },
  xlsx: {
    contentType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    name: 'grades.xlsx',
  },
} as const;

/** An Office source uploaded through the API (the e2e memory store serves it). */
async function uploadOffice(api: APIRequestContext, format: OfficeFormat) {
  const { contentType, name } = OFFICE[format];
  const bytes = readFileSync(`e2e/fixtures/files/basic/${name}`);
  const uploadName = `${randomUUID().slice(0, 8)}-${name}`;
  const uploaded = await uploadSourceFile(
    api,
    workspaceId,
    {
      batchId: `agent-writes-${randomUUID()}`,
      batchTotal: 1,
      contentType,
      name: uploadName,
      sizeBytes: bytes.length,
    },
    bytes
  );
  expect(uploaded.status(), await uploaded.text()).toBe(201);
  const { id } = (await uploaded.json()) as { id: string };
  made.push(`/api/files/${id}`);
  return id;
}

async function openOffice(page: Page, fileId: string, format: OfficeFormat) {
  await page.goto(
    `/workspaces/${workspaceId}?file=${encodeURIComponent(fileId)}&mode=edit`
  );
  await expect(officeEditMenu(page, format)).toBeVisible({ timeout: 120_000 });
  return page.frameLocator('iframe[src*="office-runtime"]');
}

/** What an open DOCX or XLSX editor shows of `text`: the DOCX text mirror
 * and the XLSX grid's cells, which the editors keep for screen readers. */
function shownText(frame: FrameLocator, format: OfficeFormat, text: string) {
  if (format === 'xlsx')
    return frame.getByRole('gridcell').filter({ hasText: text });
  return frame.getByRole('paragraph').filter({ hasText: text });
}

/** The PPTX editor draws its slide on a canvas and keeps no text for
 * readers: its pixels, once two reads agree (fonts and images settled). */
async function slidePixels(frame: FrameLocator) {
  const canvas = frame.getByTestId('pptx-slide-canvas');
  let last = await canvas.screenshot();
  for (let read = 0; read < 20; read++) {
    const next = await canvas.screenshot();
    if (next.equals(last)) return next;
    last = next;
  }
  throw new Error('the slide never settled');
}

/** Types `line` as an editor does: a new DOCX paragraph at the end, the
 * empty cell D1 of the XLSX fixture's Grades sheet, or over the PPTX
 * fixture's top text box on the first slide (1in,1in on its 10in x 7.5in
 * slide). */
async function typeLine(
  frame: FrameLocator,
  format: OfficeFormat,
  line: string
) {
  if (format === 'docx') {
    const input = frame.getByRole('textbox', { name: 'Document input' });
    await input.focus();
    await input.press('ControlOrMeta+End');
    await input.press('Enter');
    await input.pressSequentially(line);
  } else if (format === 'xlsx') {
    await frame.getByRole('tab', { exact: true, name: 'Grades' }).click();
    const grid = frame.getByTestId('xlsx-scroll');
    await grid.focus();
    await grid.press('ControlOrMeta+Home');
    for (let i = 0; i < 3; i++) await grid.press('ArrowRight');
    const input = frame.getByTestId('xlsx-formula-input');
    await input.fill(line);
    await input.press('Enter');
  } else {
    const canvas = frame.getByTestId('pptx-slide-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('the slide canvas takes no pointer');
    await canvas.click({
      clickCount: 3,
      position: { x: box.width * 0.17, y: box.height * 0.155 },
    });
    await frame.getByRole('application').pressSequentially(line);
  }
}

/** Waits until the agent's read of the file (which merges its room) holds
 * `line`. */
async function readShows(
  api: APIRequestContext,
  fileId: string,
  format: OfficeFormat,
  line: string,
  timeout = 30_000
) {
  await expect
    .poll(
      async () =>
        (await entries(api, fileId, format)).map((entry) => entry.value),
      { timeout }
    )
    .toContain(line);
}

test.describe('agent writes to Office sources', () => {
  test.describe.configure({ timeout: 300_000 });
  // The XLSX check finds the typed cell in the first editor's grid, which
  // renders only the columns in view: the viewer at 1280px with the left
  // panel closed, as before the workspace opened it by default.
  test.use({
    storageState: async ({ baseURL }, use) =>
      use({
        cookies: [],
        origins: [
          {
            localStorage: [
              { name: 'capy.workspace.rightPanel', value: 'true' },
              { name: 'capy.workspace.leftPanel', value: 'false' },
            ],
            origin: baseURL!,
          },
        ],
      }),
  });

  for (const format of ['docx', 'pptx', 'xlsx'] as const) {
    test(`${format === 'xlsx' ? 'set_range' : 'replace_text'} on a ${format.toUpperCase()} source lands on its targets, live for two editors, and one Undo restores both`, async ({
      anonymousApi,
      editorPage,
      ownerApi,
      ownerPage,
    }) => {
      const fileId = await uploadOffice(ownerApi, format);
      const frames = [
        await openOffice(ownerPage, fileId, format),
        await openOffice(editorPage, fileId, format),
      ];
      const before = await entries(anonymousApi, fileId, format);
      // Text, not formulas: the agent's value is the text with a suffix.
      const texts = before.filter(
        (entry) => entry.value.trim().length > 3 && !entry.value.startsWith('=')
      );
      const [one, two] =
        format === 'pptx'
          ? [
              texts[0],
              texts.find((entry) => entry.position !== texts[0].position)!,
            ]
          : texts;
      const changed = [`${one.value} (agent one)`, `${two.value} (agent two)`];
      const commands = [one, two].map((entry, i) =>
        format === 'xlsx'
          ? {
              expected: [[entry.value]],
              range: entry.id,
              sheet: entry.label,
              type: 'set_range',
              values: [[changed[i]]],
            }
          : {
              expected_text: entry.value,
              target_id: entry.id,
              text: changed[i],
              type: 'replace_text',
            }
      );
      // DOCX: a collaborator's line, in the room and not yet saved (a source
      // room stores 5 s after the last change), which the agent's read shows
      // (it merges the room, Epo 2026-10-13) and the edit and its Undo keep.
      const typed = 'Collaborator line typed live.';
      const read = async () => {
        const now = await entries(anonymousApi, fileId, format);
        if (format === 'docx')
          expect(now.map((entry) => entry.value)).toContain(typed);
        return now.filter((entry) => entry.value !== typed);
      };
      if (format === 'docx') {
        const input = frames[1].getByRole('textbox', {
          name: 'Document input',
        });
        await input.focus();
        await input.press('ControlOrMeta+End');
        await input.press('Enter');
        await input.pressSequentially(typed);
        await expect(shownText(frames[0], format, typed).first()).toBeAttached({
          timeout: 30_000,
        });
        expect(await read()).toEqual(before);
      }
      const slides =
        format === 'pptx' ? await Promise.all(frames.map(slidePixels)) : [];
      const showsSlide = (i: number) =>
        expect.poll(
          async () => (await slidePixels(frames[i])).equals(slides[i]),
          {
            timeout: 30_000,
          }
        );
      const operation = await edit(
        anonymousApi,
        { id: fileId, kind: 'source_file' },
        commands,
        [],
        true
      );
      const after = await read();
      expect(after.find((entry) => entry.id === one.id)?.value).toBe(
        changed[0]
      );
      expect(after.find((entry) => entry.id === two.id)?.value).toBe(
        changed[1]
      );
      expect(
        after.filter((entry) => entry.id !== one.id && entry.id !== two.id)
      ).toEqual(
        before.filter((entry) => entry.id !== one.id && entry.id !== two.id)
      );
      for (const [i, frame] of frames.entries()) {
        if (format === 'pptx') await showsSlide(i).toBe(false);
        else
          for (const text of changed)
            await expect(shownText(frame, format, text).first()).toBeAttached({
              timeout: 30_000,
            });
      }

      await undo(ownerApi, operation);
      expect(await read()).toEqual(before);
      for (const [i, frame] of frames.entries()) {
        if (format === 'pptx') await showsSlide(i).toBe(true);
        else
          await expect(shownText(frame, format, '(agent ')).toHaveCount(0, {
            timeout: 30_000,
          });
      }
      if (format === 'docx')
        for (const frame of frames)
          await expect(shownText(frame, format, typed).first()).toBeAttached();
      // XLSX and PPTX: the second editor's typing, under the client id its
      // join token assigned, reaches the first editor and the agent's read.
      if (format === 'docx') return;
      const line = 'Collaborator typed live.';
      await typeLine(frames[1], format, line);
      if (format === 'xlsx')
        await expect(shownText(frames[0], format, line).first()).toBeAttached({
          timeout: 30_000,
        });
      else await showsSlide(0).toBe(false);
      await readShows(anonymousApi, fileId, format, line);
    });
  }

  for (const format of ['docx', 'pptx', 'xlsx'] as const) {
    test(`a ${format.toUpperCase()} editor that typed offline while its room unloaded keeps its client ids: no reload, and its typing lands`, async ({
      anonymousApi,
      ownerApi,
      ownerPage,
    }) => {
      // Q236: the reconnect presents its previous token and Go offers the
      // same ids again, which the editor's replica (and DOCX layout worker)
      // took at its load.
      const link = await collaborationLink(ownerPage.context());
      const fileId = await uploadOffice(ownerApi, format);
      const frame = await openOffice(ownerPage, fileId, format);
      // The editor's own element: a reload would replace it.
      const editor = {
        docx: frame.getByRole('textbox', { name: 'Document input' }),
        pptx: frame.getByTestId('pptx-slide-canvas'),
        xlsx: frame.getByTestId('xlsx-scroll'),
      }[format];
      await editor.evaluate((element) =>
        element.setAttribute('data-e2e-kept', '')
      );
      // Alone in the room: its socket closing unloads the room.
      await link.down(ownerPage);
      const line = 'Typed while offline.';
      await typeLine(frame, format, line);
      await link.up(ownerPage);
      await readShows(anonymousApi, fileId, format, line, 60_000);
      await expect(editor).toHaveAttribute('data-e2e-kept', '');
    });
  }
});
