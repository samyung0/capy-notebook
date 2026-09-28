// Run after pnpm office:prepare with OFFICE_STORAGE_DATABASE_URL pointing to a
// disposable local PostgreSQL database. Only a session-local temp table is used.
// pnpm exec tsx bench/parsers/scripts/office_storage.ts OUTPUT_DIRECTORY [FILE...]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import * as Y from 'yjs';
import {
  attachDocumentContributorTracker,
  clearDocumentContributors,
  documentContributors,
  removeDocumentContributors,
} from '../../../collaboration/src/contributors';
import {
  seedChange,
  trimEffect,
} from '../../../collaboration/src/sourceDocuments';
import type {
  OfficeCheckpoint,
  OfficeCommand,
  OfficeFormat,
} from '../../../vendor/betteroffice/shared/office-checkpoint';

const require = createRequire(
  new URL('../../../collaboration/package.json', import.meta.url)
);
const { Client } = require('pg') as typeof import('pg');
const office: typeof import('../../../vendor/betteroffice/shared/office-checkpoint') =
  await import(
    pathToFileURL(
      path.resolve('vendor/betteroffice/shared/office-checkpoint.mjs')
    ).href
  );
const [output, ...requested] = process.argv.slice(2);
assert(output, 'An output directory is required');
const database = process.env.OFFICE_STORAGE_DATABASE_URL;
assert(
  database &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(database).hostname),
  'Use an explicit loopback disposable PostgreSQL database'
);
await mkdir(output, { recursive: true });
const db = new Client({ connectionString: database });
await db.connect();
await db.query(`CREATE TEMP TABLE measurements (
  id serial, state bytea, effects jsonb NOT NULL, seed_bytes bigint NOT NULL
)`);
const databaseInfo = (
  await db.query(
    `SELECT version(), current_setting('default_toast_compression') AS compression`
  )
).rows[0];
const files = requested.length
  ? requested
  : [
      'e2e/fixtures/files/basic/lesson.docx',
      'e2e/fixtures/files/basic/grades.xlsx',
      'e2e/fixtures/files/basic/lesson.pptx',
      'e2e/fixtures/files/rich-content/exchange-plan.docx',
      'e2e/fixtures/files/rich-content/course-guide.xlsx',
      'e2e/fixtures/files/rich-content/lecture.pptx',
      'vendor/betteroffice/poc/fixtures/feature-rich.docx',
      'vendor/betteroffice/poc/fixtures/feature-rich.xlsx',
      'vendor/betteroffice/poc/fixtures/feature-rich.pptx',
      'vendor/betteroffice/poc/fixtures/book-30p.docx',
      'vendor/betteroffice/poc/fixtures/images-10.docx',
      'vendor/betteroffice/poc/fixtures/opaque-objects.docx',
      'vendor/betteroffice/poc/fixtures/deck-50.pptx',
      'vendor/betteroffice/crates/betteroffice-xlsx/tests/fixtures/storage/cells-1k.xlsx',
      'vendor/betteroffice/crates/betteroffice-xlsx/tests/fixtures/storage/cells-10k.xlsx',
      'vendor/betteroffice/crates/betteroffice-xlsx/tests/fixtures/storage/cells-100k.xlsx',
      'bench/parsers/fixtures/docs/jp_llm2.pptx',
      'bench/rag/fixtures/local/2026-09-09-odl-agentic/originals/zh/zh_TW_llm.pptx',
    ];
const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
/**
 * What the service stores for an Office state that grew from `seed`: its
 * change over the seed, checked to rebuild the state exactly (migration 0039).
 */
function changeOver(seed: Uint8Array, state: Uint8Array) {
  return seedChange(seed, state);
}
const records = [];
const identity = {
  capy_revision: execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim(),
  betteroffice_revision: execFileSync(
    'git',
    ['-C', 'vendor/betteroffice', 'rev-parse', 'HEAD'],
    { encoding: 'utf8' }
  ).trim(),
  runtime_manifest: await office.runtimeManifest(),
};
try {
  for (const file of files) {
    const started = performance.now();
    const bytes = new Uint8Array(await readFile(file));
    const format = path.extname(file).slice(1) as OfficeFormat;
    assert(
      ['docx', 'xlsx', 'pptx'].includes(format),
      `Unsupported Office file: ${file}`
    );
    const seed = await office.seedOffice(format, bytes);
    const baseline =
      format === 'xlsx' ? [] : await office.officeBaseline(bytes, seed);
    const entries = await office.inspectOffice(bytes, seed);
    const target = entries.find(
      (entry) =>
        entry.value &&
        !/[\n\r\v]/.test(entry.value) &&
        (format !== 'xlsx' ||
          (!entry.value.startsWith('=') && /![A-Z]+[0-9]+$/.test(entry.label)))
    );
    assert(target, `No editable target in ${file}`);
    const room = new Y.Doc();
    attachDocumentContributorTracker(
      room,
      'storage-probe',
      () => 'storage-probe'
    );
    Y.applyUpdate(room, seed.state);
    let value = target.value;
    let stored = seed.state;
    const checkpoint = (): OfficeCheckpoint => ({ ...seed, state: stored });
    async function edit(suffix: string) {
      const next = value + suffix;
      const command: OfficeCommand =
        format === 'xlsx'
          ? {
              type: 'set_cell',
              sheet: target!.label.slice(0, target!.label.lastIndexOf('!')),
              cell: target!.label.slice(target!.label.lastIndexOf('!') + 1),
              expectedValue: value,
              value: next,
            }
          : {
              type: 'replace_text',
              targetId: target!.id,
              expectedText: value,
              text: next,
            };
      const applied = await office.applyOfficeCommands(bytes, checkpoint(), [
        command,
      ]);
      Y.applyUpdate(room, applied.state, {
        source: 'connection',
        connection: {
          context: { access: 'write', userId: 'user_storage_probe' },
        },
      });
      const snapshot = new Y.Doc();
      Y.applyUpdate(snapshot, Y.encodeStateAsUpdate(room));
      const contributors = documentContributors(snapshot);
      removeDocumentContributors(snapshot, contributors);
      const merged = new Y.Doc();
      Y.applyUpdate(merged, stored);
      Y.applyUpdate(merged, Y.encodeStateAsUpdate(snapshot));
      stored = Y.encodeStateAsUpdate(merged);
      clearDocumentContributors(room, contributors);
      snapshot.destroy();
      merged.destroy();
      value = next;
    }
    async function effects(state: Uint8Array) {
      const current = { ...seed, state };
      return (
        format === 'xlsx'
          ? await office.xlsxPendingEffects(bytes, current)
          : office.compareBaselines(
              baseline,
              await office.officeBaseline(bytes, current)
            )
      ).map(trimEffect);
    }
    async function measure(
      state: Uint8Array | null,
      fx: unknown[],
      seedSize: number
    ) {
      const inserted = await db.query(
        'INSERT INTO measurements(state,effects,seed_bytes) VALUES($1,$2,$3) RETURNING id',
        [state && Buffer.from(state), JSON.stringify(fx), seedSize]
      );
      const row = (
        await db.query(
          `SELECT
        COALESCE(octet_length(state),0) AS state_bytes,
        COALESCE(octet_length(NULLIF(effects,'[]'::jsonb)::text),0) AS effect_bytes,
        COALESCE(pg_column_size(state),0) AS state_stored,
        pg_column_size(effects) AS effects_stored,
        COALESCE(octet_length(NULLIF(effects,'[]'::jsonb)::text),0)
          + GREATEST(0,COALESCE(octet_length(state),0)-seed_bytes) AS quota_extra
        FROM measurements WHERE id=$1`,
          [inserted.rows[0].id]
        )
      ).rows[0];
      return Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, Number(value)])
      );
    }
    // Stored and charged as the service does since migration 0039 (a change
    // over the seed, charged as stored; 0043 stores no baseline); *_full_state
    // keeps the earlier full state with its growth-over-seed charge for comparison.
    const unopened = await measure(null, [], 0);
    await edit(' Capy storage probe.');
    const oneEffects = await effects(stored);
    const one = await measure(changeOver(seed.state, stored), oneEffects, 0);
    const oneFull = await measure(stored, oneEffects, seed.state.length);
    const captured: OfficeCheckpoint = { ...seed, state: stored.slice() };
    const exported = await office.exportOffice(bytes, captured, {
      seed: hash(captured.state),
      now: '2026-09-27T00:00:00.000Z',
    });
    const exportedSeed = await office.seedOffice(format, exported);
    assert(
      (await office.inspectOffice(exported, exportedSeed)).some((entry) =>
        entry.value.includes('Capy storage probe.')
      ),
      `Export lost the measured edit in ${file}`
    );
    await edit(' Later saved edit.');
    const laterEffects = await effects(stored);
    const duringRefresh = await measure(
      changeOver(seed.state, stored),
      laterEffects,
      0
    );
    const duringRefreshFull = await measure(
      stored,
      laterEffects,
      seed.state.length
    );
    const rebase = await office.rebaseOffice(
      bytes,
      captured,
      checkpoint(),
      exported
    );
    // Every rebase lands on seed(export) and is stored as its change over it.
    const rebased = await measure(
      changeOver(exportedSeed.state, rebase.state),
      rebase.effects.map(trimEffect),
      0
    );
    const rebasedFull = await measure(
      rebase.state,
      rebase.effects.map(trimEffect),
      exportedSeed.state.length
    );
    assert(
      (
        await office.inspectOffice(exported, {
          ...exportedSeed,
          state: rebase.state,
        })
      ).some((entry) => entry.value.includes('Later saved edit.')),
      `Rebase lost the later edit in ${file}`
    );
    const zip = unzipSync(bytes);
    const media = Object.entries(zip)
      .filter(([name]) => /^(word|xl|ppt)\/media\//.test(name))
      .reduce((sum, [, data]) => sum + data.length, 0);
    const record = {
      file,
      format,
      sha256: hash(bytes),
      source_bytes: bytes.length,
      media_uncompressed_bytes: media,
      zip_uncompressed_bytes: Object.values(zip).reduce(
        (sum, data) => sum + data.length,
        0
      ),
      seed_bytes: seed.state.length,
      unopened,
      one_edit: one,
      one_edit_full_state: oneFull,
      exported_bytes: exported.length,
      exported_seed_bytes: exportedSeed.state.length,
      during_refresh: duringRefresh,
      during_refresh_full_state: duringRefreshFull,
      captured_state_bytes: captured.state.length,
      captured_state_stored: one.state_stored,
      rebased_with_later_edit: rebased,
      rebased_with_later_edit_full_state: rebasedFull,
      milliseconds: Math.round(performance.now() - started),
    };
    room.destroy();
    records.push(record);
    await writeFile(
      path.join(output, 'measurements.json'),
      JSON.stringify({ ...identity, database: databaseInfo, records }, null, 2)
    );
    console.log(JSON.stringify(record));
  }
} finally {
  await db.end();
}
