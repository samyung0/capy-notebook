import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import {
  attachDocumentContributorTracker,
  clearDocumentContributors,
  documentContributors,
  removeDocumentContributors,
  roomSnapshot,
} from './contributors.js';
import {
  EditError,
  officeError,
  officeGuards,
  verifyOfficeGuards,
} from './editCommands.js';
import { officeUpdateViolation } from './officeRoots.js';
import {
  closeOfficeRuntime,
  type OfficeEntry,
  type OfficeFormat,
  officeDocumentRoots,
  runOffice,
} from './officeRuntime.js';
import {
  effectTokens,
  rebuildState,
  SourceDocumentStore,
  SourceRequestError,
  SourceSeedChangedError,
  type SourceSession,
  seedChange,
  trimEffect,
} from './sourceDocuments.js';

const BASE_MISMATCH = /base/;
const BODY_POSITION = /^body:(\d+)$/;
const REBASE_REFUSAL = /^Office rebase: /;

afterAll(closeOfficeRuntime);
afterEach(() => vi.unstubAllGlobals());

/** The engine command that sets an entry's text: a cell in XLSX, else a paragraph. */
function setText(format: OfficeFormat, target: OfficeEntry, text: string) {
  return format === 'xlsx'
    ? {
        cell: target.label.slice(target.label.lastIndexOf('!') + 1),
        expectedValue: target.value,
        sheet: target.label.slice(0, target.label.lastIndexOf('!')),
        type: 'set_cell' as const,
        value: text,
      }
    : {
        expectedText: target.value,
        targetId: target.id,
        text,
        type: 'replace_text' as const,
      };
}

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
  '%s publishes checkpoint 10 while keeping saved 11 with matching pending effects',
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
    // The effects derive from the export: XLSX reads them off the overrides,
    // DOCX and PPTX compare against the baseline of seed(export).
    const effects =
      format === 'xlsx'
        ? await runOffice('xlsxPendingEffects', parsed, rebased)
        : await runOffice(
            'compareBaselines',
            await runOffice(
              'officeBaseline',
              parsed,
              await runOffice('seedOffice', format, parsed)
            ),
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

test.each([
  ['docx', 'apps/demo/public/betteroffice-demo.docx'],
  ['xlsx', 'apps/demo/public/sample.xlsx'],
  ['pptx', 'apps/demo/public/betteroffice-demo.pptx'],
] as const)(
  '%s seeds one lineage on every instance and its room takes only its document roots',
  async (format, path) => {
    const bytes = await readFile(
      new URL(`../../vendor/betteroffice/${path}`, import.meta.url)
    );
    // A NULL state is seed(base) wherever it loads, so seeds must be identical.
    const seed = await runOffice('seedOffice', format, bytes);
    const again = await runOffice('seedOffice', format, bytes);
    expect(Buffer.from(seed.state).equals(Buffer.from(again.state))).toBe(true);
    const roots = (await officeDocumentRoots())[format];
    const room = new Y.Doc();
    Y.applyUpdate(room, seed.state);
    expect(
      [...room.share.keys()].filter((root) => !roots.includes(root))
    ).toEqual([]);
    const [target] = (await runOffice('inspectOffice', bytes, seed)).filter(
      (entry) => entry.value.length > 0
    );
    const edited = await runOffice('applyOfficeCommands', bytes, seed, [
      setText(format, target, 'Edited by Capy'),
    ]);
    expect(
      officeUpdateViolation(
        room,
        Y.diffUpdate(edited.state, Y.encodeStateVector(room)),
        format,
        roots
      )
    ).toBeNull();
    const client = (write: (document: Y.Doc) => void) => {
      const document = new Y.Doc();
      Y.applyUpdate(document, seed.state);
      const before = Y.encodeStateVector(document);
      write(document);
      return Y.encodeStateAsUpdate(document, before);
    };
    expect(
      officeUpdateViolation(
        room,
        client((document) => document.getMap('foreign').set('x', 1)),
        format,
        roots
      )
    ).toMatch('outside');
    if (format !== 'pptx') return;
    // A client may change only the comment flavour in pptx:meta.
    const meta = (write: (map: Y.Map<unknown>) => void) =>
      officeUpdateViolation(
        room,
        client((document) => write(document.getMap('pptx:meta'))),
        format,
        roots
      );
    const key = [...room.getMap('pptx:meta').keys()].find(
      (name) => name !== 'commentFlavor'
    );
    if (!key) throw new Error('fixture has no deck metadata');
    expect(meta((map) => map.set('commentFlavor', 'modern'))).toBeNull();
    expect(meta((map) => map.set(key, 'changed'))).toMatch('pptx:meta');
    expect(meta((map) => map.delete(key))).toMatch('pptx:meta');
  },
  60_000
);

test.each([
  ['docx', 'apps/demo/public/betteroffice-demo.docx'],
  ['xlsx', 'apps/demo/public/sample.xlsx'],
  ['pptx', 'apps/demo/public/betteroffice-demo.pptx'],
] as const)(
  'a NULL %s room saved without edits stays NULL; one edit is stored',
  async (format, path) => {
    const bytes = await readFile(
      new URL(`../../vendor/betteroffice/${path}`, import.meta.url)
    );
    const seed = await runOffice('seedOffice', format, bytes);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(bytes))
    );
    // The row still names checkpoint 0 until the edit is stored.
    const pool = {
      query: vi.fn(async () => ({
        rows: [{ base_revision: '1', checkpoint: '0', pending_effects: [] }],
      })),
    } as unknown as Pool;
    const store = new SourceDocumentStore(pool, 'http://api', 'secret');
    const session = {
      access: 'write',
      baseRevision: 1,
      baseSourceSHA256: seed.baseSha256,
      checkpoint: 0,
      epoch: 1,
      format,
      pendingEffects: [],
      room: 'source:f_1:epoch:1',
      sourceURL: 'http://base',
      state: null,
    } as unknown as SourceSession;
    vi.spyOn(store, 'session').mockResolvedValue(session);
    const request = vi
      .spyOn(store, 'request')
      .mockResolvedValue({ checkpoint: 1 });
    const room = new Y.Doc();
    attachDocumentContributorTracker(room, 'instance');
    await store.load(session.room, room, 'u1');
    // An editor's replica holds the same seed: its sync adds only a marker.
    const writer = {
      connection: { context: { access: 'write', userId: 'u1' } },
      source: 'connection',
    };
    Y.applyUpdate(room, seed.state, writer);
    expect(await store.store(session.room, roomSnapshot(room))).toMatchObject({
      checkpoint: 0,
    });
    expect(request).not.toHaveBeenCalled();
    const [target] = (await runOffice('inspectOffice', bytes, seed)).filter(
      (entry) => entry.value.length > 0
    );
    const edited = await runOffice('applyOfficeCommands', bytes, seed, [
      setText(format, target, 'Edited by Capy'),
    ]);
    Y.applyUpdate(room, edited.state, writer);
    await store.store(session.room, roomSnapshot(room));
    // The first edit binds the base and stores only its change over the seed,
    // which a store holding nothing else rebuilds into the saved document.
    const body = request.mock.calls[0][2] as {
      baseSourceSHA256: string;
      seedBytes?: number;
      state: string;
      stateSeedSHA256: string;
    };
    const seedSHA256 = createHash('sha256').update(seed.state).digest('hex');
    expect(body).toMatchObject({
      baseSourceSHA256: seed.baseSha256,
      stateSeedSHA256: seedSHA256,
    });
    expect(body).not.toHaveProperty('seedBytes');
    const change = Buffer.from(body.state, 'base64');
    expect(change.byteLength).toBeLessThan(seed.state.byteLength / 10);
    const saved = new Y.Doc();
    Y.applyUpdate(saved, Y.encodeStateAsUpdate(room));
    removeDocumentContributors(saved, documentContributors(saved));
    const fresh = new SourceDocumentStore(pool, 'http://api', 'secret');
    expect(
      Buffer.from(
        await fresh.stateOf({
          ...session,
          state: body.state,
          stateSeedSHA256: seedSHA256,
        })
      ).equals(Buffer.from(Y.encodeStateAsUpdate(saved)))
    ).toBe(true);
    // A change taken over another seed is refused, never applied.
    await expect(
      fresh.stateOf({
        ...session,
        state: body.state,
        stateSeedSHA256: '0'.repeat(64),
      })
    ).rejects.toBeInstanceOf(SourceSeedChangedError);
    saved.destroy();
    room.destroy();
  },
  60_000
);

// Saves pass the merged document along, so the stored change is taken from
// it instead of a fresh copy whenever its encoding already matches the
// rebuild. Over saves from the durable copy, with several writers replacing
// and deleting text, every stored change is byte for byte what the fresh copy
// gives (seedChange without the document) and rebuilds the saved state.
test.each([
  ['docx', 'e2e/fixtures/files/rich-content/exchange-plan.docx'],
  ['xlsx', 'vendor/betteroffice/apps/demo/public/sample.xlsx'],
  ['pptx', 'e2e/fixtures/files/rich-content/lecture.pptx'],
] as const)(
  '%s saves store the same change as from a fresh copy',
  async (format, path) => {
    const bytes = await readFile(new URL(`../../${path}`, import.meta.url));
    const seed = await runOffice('seedOffice', format, bytes);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(bytes))
    );
    let checkpoint = 0;
    const pool = {
      query: vi.fn(async () => ({
        rows: [
          {
            base_revision: '1',
            checkpoint: String(checkpoint),
            pending_effects: [],
          },
        ],
      })),
    } as unknown as Pool;
    const store = new SourceDocumentStore(pool, 'http://api', 'secret');
    const session = {
      access: 'write',
      baseRevision: 1,
      baseSourceSHA256: seed.baseSha256,
      checkpoint: 0,
      epoch: 1,
      format,
      pendingEffects: [],
      room: 'source:f_1:epoch:1',
      sourceURL: 'http://base',
      state: null,
    } as unknown as SourceSession;
    vi.spyOn(store, 'session').mockResolvedValue(session);
    const stored: string[] = [];
    vi.spyOn(store, 'request').mockImplementation(
      async (_file, _endpoint, body) => {
        stored.push((body as { state: string }).state);
        checkpoint += 1;
        return { checkpoint };
      }
    );
    const room = new Y.Doc();
    attachDocumentContributorTracker(room, 'instance');
    await store.load(session.room, room, 'u1');
    const targets = (await runOffice('inspectOffice', bytes, seed))
      .filter((entry) => entry.value.length > 3)
      .slice(0, 3);
    for (let save = 0; save < 4; save += 1) {
      for (const writer of ['u1', 'u2']) {
        const target = targets[(save + writer.length) % targets.length];
        // Two characters deleted, a few typed.
        const text = `${target.value.slice(2)} ${writer}${save}`;
        const edited = await runOffice(
          'applyOfficeCommands',
          bytes,
          { ...seed, state: Y.encodeStateAsUpdate(room) },
          [setText(format, target, text)]
        );
        target.value = text;
        Y.applyUpdate(room, edited.state, {
          connection: { context: { access: 'write', userId: writer } },
          source: 'connection',
        });
      }
      const saved = await store.store(session.room, roomSnapshot(room));
      clearDocumentContributors(room, saved.contributors);
    }
    expect(stored).toHaveLength(4);
    for (const change of stored) {
      const state = await store.stateOf({
        ...session,
        state: change,
        stateSeedSHA256: createHash('sha256').update(seed.state).digest('hex'),
      });
      expect(
        Buffer.from(seedChange(seed.state, state)).toString('base64')
      ).toBe(change);
    }
    room.destroy();
  },
  60_000
);

test('XLSX pending effects come from its overrides with no stored baseline', async () => {
  const bytes = await readFile(
    new URL(
      '../../vendor/betteroffice/apps/demo/public/sample.xlsx',
      import.meta.url
    )
  );
  const seed = await runOffice('seedOffice', 'xlsx', bytes);
  const [target] = (await runOffice('inspectOffice', bytes, seed)).filter(
    (entry) => entry.value.length > 0
  );
  const edited = await runOffice('applyOfficeCommands', bytes, seed, [
    setText('xlsx', target, 'Changed'),
  ]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(bytes))
  );
  const store = new SourceDocumentStore({} as Pool, 'http://api', 'secret');
  const session = {
    baseSourceSHA256: seed.baseSha256,
    format: 'xlsx',
    pendingEffects: [],
    sourceURL: 'http://base',
  } as unknown as SourceSession;
  expect(await store.effects(session, edited.state)).toMatchObject([
    { kind: 'text', label: target.label, operation: 'replace' },
  ]);
}, 60_000);

test.each([
  ['docx', 'apps/demo/public/betteroffice-demo.docx'],
  ['xlsx', 'apps/demo/public/sample.xlsx'],
  ['pptx', 'apps/demo/public/betteroffice-demo.pptx'],
] as const)(
  'a %s publication rebase is stored as its change over seed(export), rebuilds exactly and refuses a changed seed',
  async (format, path) => {
    const bytes = await readFile(
      new URL(`../../vendor/betteroffice/${path}`, import.meta.url)
    );
    const sha256 = (value: Uint8Array) =>
      createHash('sha256').update(value).digest('hex');
    const seed = await runOffice('seedOffice', format, bytes);
    const [first, second] = (
      await runOffice('inspectOffice', bytes, seed)
    ).filter((entry) => entry.value.length > 0);
    const captured = await runOffice('applyOfficeCommands', bytes, seed, [
      setText(format, first, 'Captured'),
    ]);
    const latest = await runOffice(
      'applyOfficeCommands',
      bytes,
      { ...seed, state: captured.state },
      [setText(format, second, 'Later')]
    );
    const exported = await runOffice(
      'exportOffice',
      bytes,
      { ...seed, state: captured.state },
      { now: '2000-01-01T00:00:00.000Z', seed: sha256(bytes) }
    );
    // Both saved states are stored as their change over seed(base).
    const change = (state: Uint8Array) => {
      const document = new Y.Doc();
      Y.applyUpdate(document, state);
      const out = Buffer.from(
        Y.encodeStateAsUpdate(
          document,
          Y.encodeStateVectorFromUpdate(seed.state)
        )
      );
      document.destroy();
      return out;
    };
    const pool = {
      query: vi.fn(async () => ({
        rows: [
          {
            source_sha256: sha256(exported),
            state: change(captured.state),
            state_seed_sha256: sha256(seed.state),
          },
        ],
      })),
    } as unknown as Pool;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(url === 'http://base' ? bytes : Buffer.from(exported))
      )
    );
    const sources = new SourceDocumentStore(pool, 'http://api', 'secret');
    vi.spyOn(sources, 'request').mockResolvedValue({
      sourceURL: 'http://export',
    });
    const session = {
      baseSourceSHA256: seed.baseSha256,
      checkpoint: 11,
      epoch: 1,
      fileId: 'f',
      format,
      pendingEffects: [],
      sourceURL: 'http://base',
      state: change(latest.state).toString('base64'),
      stateSeedSHA256: sha256(seed.state),
    } as unknown as SourceSession;
    const result = await sources.rebasePublication(session, {
      checkpoint: 10,
      epoch: 1,
      jobId: 'job',
      leaseToken: 'lease',
    });
    const exportSeed = await runOffice('seedOffice', format, exported);
    expect(result).toMatchObject({
      rebasedStateSeedSHA256: sha256(exportSeed.state),
    });
    expect(result.pendingEffects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'text', operation: 'replace' }),
      ])
    );
    // The later edit alone is stored, not the export's document model.
    const stored = Buffer.from(result.rebasedState as string, 'base64');
    if (format !== 'xlsx')
      expect(stored.byteLength).toBeLessThan(exportSeed.state.byteLength / 4);
    // A store holding nothing else rebuilds it over seed(export) with both
    // edits, and refuses it over any other seed.
    const next = {
      ...session,
      baseSourceSHA256: sha256(exported),
      sourceURL: 'http://export',
      state: result.rebasedState as string,
      stateSeedSHA256: result.rebasedStateSeedSHA256 as string,
    };
    const fresh = new SourceDocumentStore(pool, 'http://api', 'secret');
    const rebuilt = await fresh.stateOf(next);
    expect(
      Buffer.from(rebuilt).equals(
        Buffer.from(rebuildState(exportSeed.state, stored))
      )
    ).toBe(true);
    const values = (
      await runOffice('inspectOffice', exported, {
        ...exportSeed,
        state: rebuilt,
      })
    ).map((entry) => entry.value);
    expect(values).toEqual(expect.arrayContaining(['Captured', 'Later']));
    await expect(
      fresh.stateOf({ ...next, stateSeedSHA256: '0'.repeat(64) })
    ).rejects.toBeInstanceOf(SourceSeedChangedError);
  },
  60_000
);

test('a publication rebase the engine refuses ends the refresh with a 422', async () => {
  const read = (path: string) =>
    readFile(new URL(`../../vendor/betteroffice/${path}`, import.meta.url));
  const [bytes, other] = await Promise.all([
    read('apps/demo/public/sample.xlsx'),
    read('apps/demo/public/showcase.xlsx'),
  ]);
  const sha256 = (value: Uint8Array) =>
    createHash('sha256').update(value).digest('hex');
  const seed = await runOffice('seedOffice', 'xlsx', bytes);
  const [first, second] = (
    await runOffice('inspectOffice', bytes, seed)
  ).filter((entry) => entry.value.length > 0);
  const captured = await runOffice('applyOfficeCommands', bytes, seed, [
    setText('xlsx', first, 'Captured'),
  ]);
  const latest = await runOffice(
    'applyOfficeCommands',
    bytes,
    { ...seed, state: captured.state },
    [setText('xlsx', second, 'Later')]
  );
  const change = (state: Uint8Array) =>
    Buffer.from(Y.diffUpdate(state, Y.encodeStateVectorFromUpdate(seed.state)));
  // The published workbook's sheets are not the captured ones.
  const pool = {
    query: vi.fn(async () => ({
      rows: [
        {
          source_sha256: sha256(other),
          state: change(captured.state),
          state_seed_sha256: sha256(seed.state),
        },
      ],
    })),
  } as unknown as Pool;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) => new Response(url === 'http://base' ? bytes : other)
    )
  );
  const sources = new SourceDocumentStore(pool, 'http://api', 'secret');
  vi.spyOn(sources, 'request').mockResolvedValue({
    sourceURL: 'http://export',
  });
  const refused = sources.rebasePublication(
    {
      baseSourceSHA256: seed.baseSha256,
      checkpoint: 11,
      epoch: 1,
      fileId: 'f',
      format: 'xlsx',
      pendingEffects: [],
      sourceURL: 'http://base',
      state: change(latest.state).toString('base64'),
      stateSeedSHA256: sha256(seed.state),
    } as unknown as SourceSession,
    { checkpoint: 10, epoch: 1, jobId: 'job', leaseToken: 'lease' }
  );
  await expect(refused).rejects.toBeInstanceOf(SourceRequestError);
  await expect(refused).rejects.toMatchObject({
    message: expect.stringMatching(REBASE_REFUSAL),
    status: 422,
  });
}, 60_000);

test.each([
  ['docx', 'apps/demo/public/betteroffice-demo.docx'],
  ['xlsx', 'apps/demo/public/sample.xlsx'],
  ['pptx', 'apps/demo/public/betteroffice-demo.pptx'],
] as const)(
  'a deferred %s publication measures later edits against the capture and rebuilds onto the published file',
  async (format, path) => {
    const bytes = await readFile(
      new URL(`../../vendor/betteroffice/${path}`, import.meta.url)
    );
    const sha256 = (value: Uint8Array) =>
      createHash('sha256').update(value).digest('hex');
    const seed = await runOffice('seedOffice', format, bytes);
    const [first, second] = (
      await runOffice('inspectOffice', bytes, seed)
    ).filter((entry) => entry.value.length > 0);
    const captured = await runOffice('applyOfficeCommands', bytes, seed, [
      setText(format, first, 'Captured'),
    ]);
    const latest = await runOffice(
      'applyOfficeCommands',
      bytes,
      { ...seed, state: captured.state },
      [setText(format, second, 'Later')]
    );
    const exported = await runOffice(
      'exportOffice',
      bytes,
      { ...seed, state: captured.state },
      { now: '2000-01-01T00:00:00.000Z', seed: sha256(bytes) }
    );
    const change = (state: Uint8Array) => {
      const document = new Y.Doc();
      Y.applyUpdate(document, state);
      const out = Buffer.from(
        Y.encodeStateAsUpdate(
          document,
          Y.encodeStateVectorFromUpdate(seed.state)
        )
      ).toString('base64');
      document.destroy();
      return out;
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(url === 'http://base' ? bytes : Buffer.from(exported))
      )
    );
    const session = {
      baseSourceSHA256: seed.baseSha256,
      checkpoint: 11,
      epoch: 1,
      fileId: 'f',
      format,
      indexedCheckpoint: 10,
      pendingEffects: [],
      publishedSourceSHA256: sha256(exported),
      publishedSourceURL: 'http://export',
      publishedState: change(captured.state),
      publishedStateSeedSHA256: sha256(seed.state),
      rebuildPending: true,
      sourceURL: 'http://base',
      state: change(latest.state),
      stateSeedSHA256: sha256(seed.state),
    } as unknown as SourceSession;
    const store = new SourceDocumentStore({} as Pool, 'http://api', 'secret');
    const text = (
      effects: {
        kind: string;
        before?: string;
        after?: string;
        operation: string;
      }[]
    ) =>
      effects
        .filter((effect) => effect.kind === 'text')
        .map(({ after, before, operation }) => ({ after, before, operation }));
    // Only the edit saved after the capture is pending: the published one is
    // in the file already.
    const deferred = await store.effects(session, latest.state);
    expect(text(deferred)).toEqual([
      expect.objectContaining({ operation: 'replace' }),
    ]);
    expect(JSON.stringify(deferred)).toContain('Later');
    expect(JSON.stringify(deferred)).not.toContain('Captured');
    // Nothing saved since the capture: nothing pending.
    expect(await store.effects(session, captured.state)).toEqual([]);
    // The rebuild lands both edits on seed(published), with the same pending
    // text edit as before it.
    const rebuilt = await store.rebuildPublication(session);
    expect(text(rebuilt.pendingEffects)).toEqual(text(deferred));
    const exportSeed = await runOffice('seedOffice', format, exported);
    expect(rebuilt.rebasedStateSeedSHA256).toBe(sha256(exportSeed.state));
    const state = await new SourceDocumentStore(
      {} as Pool,
      'http://api',
      'secret'
    ).stateOf({
      ...session,
      baseSourceSHA256: sha256(exported),
      sourceURL: 'http://export',
      state: rebuilt.rebasedState as string,
      stateSeedSHA256: rebuilt.rebasedStateSeedSHA256 as string,
    });
    const values = (
      await runOffice('inspectOffice', exported, { ...exportSeed, state })
    ).map((entry) => entry.value);
    expect(values).toEqual(expect.arrayContaining(['Captured', 'Later']));
    // Pending effects after the rebuild, measured the usual way against the
    // published file, are the ones the rebuild reported.
    const after = {
      ...session,
      baseSourceSHA256: sha256(exported),
      publishedState: undefined,
      publishedStateSeedSHA256: undefined,
      rebuildPending: false,
      sourceURL: 'http://export',
      state: rebuilt.rebasedState as string,
      stateSeedSHA256: rebuilt.rebasedStateSeedSHA256 as string,
    } as unknown as SourceSession;
    expect(text(await store.effects(after, state))).toEqual(text(deferred));
    // With nothing saved after the capture the rebuild is seed(published).
    expect(
      await store.rebuildPublication({
        ...session,
        checkpoint: 10,
        state: change(captured.state),
      })
    ).toEqual({ netTokens: 0, pendingEffects: [] });
  },
  120_000
);
