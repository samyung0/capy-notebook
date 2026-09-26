import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import {
  EditError,
  officeError,
  officeGuards,
  verifyOfficeGuards,
} from './editCommands.js';
import {
  closeOfficeRuntime,
  type OfficeFormat,
  runOffice,
} from './officeRuntime.js';
import { effectTokens, trimEffect } from './sourceDocuments.js';

const BASE_MISMATCH = /base/;
const BODY_POSITION = /^body:(\d+)$/;

afterAll(closeOfficeRuntime);

test.each([
  ['docx', 'poc/fixtures/feature-rich.docx'],
  ['xlsx', 'apps/demo/public/sample.xlsx'],
  ['pptx', 'apps/demo/public/betteroffice-demo.pptx'],
] as const)(
  '%s loads the packaged Node runtime, exports deterministically and restores its new base',
  async (format: OfficeFormat, path: string) => {
    const bytes = await readFile(
      new URL(`../../vendor/betteroffice/${path}`, import.meta.url)
    );
    const initial = await runOffice('seedOffice', format, bytes);
    expect(initial.baseSha256).toBe(
      createHash('sha256').update(bytes).digest('hex')
    );
    expect(await runOffice('compare', bytes, initial, initial)).toEqual([]);
    const determinism = {
      now: '2000-01-01T00:00:00.000Z',
      seed: createHash('sha256').update('integration-job').digest('hex'),
    };
    const first = await runOffice('exportOffice', bytes, initial, determinism);
    const second = await runOffice('exportOffice', bytes, initial, determinism);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    const reopened = await runOffice('seedOffice', format, first);
    expect(reopened.state.length).toBeGreaterThan(0);
    expect(await runOffice('compare', first, reopened, reopened)).toEqual([]);
    await expect(
      runOffice(
        'compare',
        first,
        { ...reopened, baseSha256: '0'.repeat(64) },
        reopened
      )
    ).rejects.toThrow(BASE_MISMATCH);
  },
  60_000
);

// Inserting a paragraph moves every later one. Moves weigh nothing, so one
// inserted paragraph stays far below the 3,000-token automatic trigger (it
// counted 3,055 when moves carried 40 characters each).
test('one paragraph inserted near the top of a long DOCX weighs only itself', async () => {
  const bytes = await readFile(
    new URL(
      '../../e2e/fixtures/files/rich-content/exchange-plan.docx',
      import.meta.url
    )
  );
  const initial = await runOffice('seedOffice', 'docx', bytes);
  const from = await runOffice('officeBaseline', bytes, {
    ...initial,
    format: 'docx',
    schemaVersion: 1,
  });
  const inserted = 'A new paragraph typed after the title.';
  const to = from.flatMap((entry) => {
    const index = BODY_POSITION.exec(entry.position)?.[1];
    const shifted =
      index && Number(index) >= 1
        ? { ...entry, position: `body:${Number(index) + 1}` }
        : entry;
    return entry.position === 'body:0'
      ? [
          shifted,
          {
            ...entry,
            id: 'body:paragraph:NEW',
            position: 'body:1',
            value: inserted,
          },
        ]
      : [shifted];
  });
  const effects = (await runOffice('compareBaselines', from, to)).map(
    trimEffect
  );
  expect(effects.filter((e) => e.operation === 'move').length).toBeGreaterThan(
    100
  );
  expect(effectTokens(effects)).toBe(Math.ceil(inserted.length / 4));
}, 60_000);

test('DOCX agent edits round-trip through the packaged runtime with Capy guards', async () => {
  const bytes = await readFile(
    new URL(
      '../../vendor/betteroffice/apps/demo/public/betteroffice-demo.docx',
      import.meta.url
    )
  );
  const initial = await runOffice('seedOffice', 'docx', bytes);
  const entries = await runOffice('inspectOffice', bytes, initial);
  const target = entries.find((entry) => entry.value.length > 0);
  if (!target) throw new Error('fixture has no paragraph text');
  const edit = await runOffice('applyOfficeCommands', bytes, initial, [
    {
      expectedText: target.value,
      targetId: target.id,
      text: 'Capy edited this paragraph',
      type: 'replace_text',
    },
  ]);
  const guards = officeGuards(edit.state, edit.targets);
  expect(guards).toHaveLength(1);
  const edited = { ...initial, state: edit.state };
  const located = await runOffice('locateOfficeTargets', bytes, edited, [
    target.id,
  ]);
  verifyOfficeGuards(edit.state, guards, located);
  const undone = await runOffice(
    'applyOfficeCommands',
    bytes,
    edited,
    edit.inverse
  );
  const relocated = await runOffice(
    'locateOfficeTargets',
    bytes,
    { ...initial, state: undone.state },
    [target.id]
  );
  expect(() => verifyOfficeGuards(undone.state, guards, relocated)).toThrow(
    EditError
  );
  await expect(
    runOffice('applyOfficeCommands', bytes, initial, [
      {
        expectedText: 'wrong',
        targetId: target.id,
        text: 'x',
        type: 'replace_text',
      },
    ]).catch((error: unknown) => {
      throw officeError(error);
    })
  ).rejects.toMatchObject({ code: 'stale_target' });
}, 60_000);

test.each([
  ['docx', 'apps/demo/public/betteroffice-demo.docx'],
  ['xlsx', 'apps/demo/public/sample.xlsx'],
  ['pptx', 'apps/demo/public/betteroffice-demo.pptx'],
] as const)(
  '%s publishes checkpoint 10 while keeping saved 11 and a usable compact baseline',
  async (format, path) => {
    const bytes = await readFile(
      new URL(`../../vendor/betteroffice/${path}`, import.meta.url)
    );
    const seed = await runOffice('seedOffice', format, bytes);
    // Source saves retain causal history after the server clears contributor entries.
    const saved = new Y.Doc();
    Y.applyUpdate(saved, seed.state);
    saved
      .getMap('__capy_pending_contributors')
      .set('actor', { access: 'write', nonce: 'n', userId: 'u' });
    saved.getMap('__capy_pending_contributors').delete('actor');
    seed.state = Y.encodeStateAsUpdate(saved);
    saved.destroy();
    const entries = await runOffice('inspectOffice', bytes, seed);
    const target = entries.find((entry) => entry.value.length > 0);
    if (!target) throw new Error('fixture has no editable text');
    const command = (expected: string, value: string) =>
      format === 'xlsx'
        ? {
            cell: target.label.slice(target.label.lastIndexOf('!') + 1),
            expectedValue: expected,
            sheet: target.label.slice(0, target.label.lastIndexOf('!')),
            type: 'set_cell' as const,
            value,
          }
        : {
            expectedText: expected,
            targetId: target.id,
            text: value,
            type: 'replace_text' as const,
          };
    const ten = {
      ...seed,
      state: (
        await runOffice('applyOfficeCommands', bytes, seed, [
          command(target.value, 'Saved at checkpoint 10'),
        ])
      ).state,
    };
    const eleven = {
      ...seed,
      state: (
        await runOffice('applyOfficeCommands', bytes, ten, [
          command('Saved at checkpoint 10', 'Saved at checkpoint 11'),
        ])
      ).state,
    };
    const parsed = await runOffice('exportOffice', bytes, ten, {
      now: '2000-01-01T00:00:00.000Z',
      seed: 'a'.repeat(64),
    });
    const same = await runOffice('rebaseOffice', bytes, ten, ten, parsed);
    expect(same.effects).toEqual([]);
    const result = await runOffice('rebaseOffice', bytes, ten, eleven, parsed);
    const rebased = {
      ...seed,
      baseSha256: createHash('sha256').update(parsed).digest('hex'),
      state: result.state,
    };
    expect(
      (await runOffice('inspectOffice', parsed, rebased)).some(
        (entry) => entry.value === 'Saved at checkpoint 11'
      )
    ).toBe(true);
    const effects = await runOffice(
      'compareBaselines',
      result.baseline,
      await runOffice('officeBaseline', parsed, rebased)
    );
    expect(effects).toEqual(result.effects);
    const value = (text: string) =>
      format === 'xlsx' ? JSON.stringify({ kind: 'text', value: text }) : text;
    expect(effects.filter((effect) => effect.kind === 'text')).toMatchObject([
      {
        after: value('Saved at checkpoint 11'),
        before: value('Saved at checkpoint 10'),
        operation: 'replace',
      },
    ]);
    const exported = await runOffice('exportOffice', parsed, rebased, {
      now: '2000-01-01T00:00:00.000Z',
      seed: 'b'.repeat(64),
    });
    const final = await runOffice('seedOffice', format, exported);
    expect(
      (await runOffice('inspectOffice', exported, final)).some(
        (entry) => entry.value === 'Saved at checkpoint 11'
      )
    ).toBe(true);
  },
  60_000
);
