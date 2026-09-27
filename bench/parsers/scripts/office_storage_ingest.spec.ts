// Uses the normal disposable UAT actor, browser upload, parser, index and cleanup.
// This is an opt-in capacity measurement, outside the regular UAT test directory.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { read as readWorkbook } from 'xlsx';
import { readManifest, verify } from '../../../e2e/uat/journeys/evidence';
import {
  fixture,
  object,
  officeBundle,
  processed,
  upload,
  workspace,
} from '../../../e2e/uat/journeys/files';
import {
  editOffice,
  officeCharge,
  openEditor,
  refresh,
  saved,
  savedExport,
  storageCharge,
  type OfficeFormat,
} from '../../../e2e/uat/journeys/office';
import { editRich } from '../../../e2e/uat/journeys/richContent';
import { test } from '../../../e2e/uat/journeys/runtime';

for (const [set, name] of [
  ['basic', 'lesson.docx'],
  ['basic', 'grades.xlsx'],
  ['basic', 'lesson.pptx'],
  ['rich-content', 'exchange-plan.docx'],
  ['rich-content', 'course-guide.xlsx'],
  ['rich-content', 'lecture.pptx'],
] as const) {
  test(`storage: ${set}/${name}`, async ({ run }) => {
    test.setTimeout(20 * 60_000);
    const workspaceId = await workspace(run, `storage-${name}`);
    const before = await storageCharge(run);
    const marker = `UAT_${randomUUID().replaceAll('-', '')}`;
    const bytes = await fixture(name, marker, set);
    const fileId = await upload(run, workspaceId, name, bytes);
    await processed(run, fileId, []);
    await officeBundle(run, fileId);
    async function measure(phase: string) {
      const [stored] = await run.query(
        `WITH target AS (
      SELECT f.source_sha256,f.size_bytes,r.content_id FROM files f
      JOIN rag_file_contents r ON r.file_id=f.id WHERE f.id=%s
    ) SELECT source_sha256,size_bytes,
      (SELECT count(*) FROM rag_chunks c WHERE c.content_id=t.content_id) AS chunks,
      (SELECT sum(octet_length(c.text)) FROM rag_chunks c WHERE c.content_id=t.content_id) AS text_bytes,
      (SELECT sum(pg_column_size(c.text)+pg_column_size(c.indexed_text)+pg_column_size(c.section_path)
        +pg_column_size(c.regions)+COALESCE(pg_column_size(c.search),0))
        FROM rag_chunks c WHERE c.content_id=t.content_id) AS chunk_columns_stored,
      (SELECT sum(pg_column_size(v.embedding)) FROM rag_chunk_vectors_2560 v JOIN rag_chunks c ON c.id=v.chunk_id
        WHERE c.content_id=t.content_id) AS vector_values_stored,
      (SELECT sum(octet_length(s.descriptor)) FROM rag_content_summaries s WHERE s.content_id=t.content_id) AS descriptor_bytes,
      (SELECT sum(pg_column_size(s.descriptor)) FROM rag_content_summaries s WHERE s.content_id=t.content_id) AS descriptor_stored,
      (SELECT COALESCE(sum(a.size_bytes),0) FROM image_caption_associations a WHERE a.file_id=%s) AS caption_bytes,
      (SELECT pg_column_size(r) FROM rag_contents r WHERE r.id=t.content_id) AS content_row,
      (SELECT jsonb_build_object('state_bytes',COALESCE(octet_length(d.state),0),
        'state_stored',COALESCE(pg_column_size(d.state),0),
        'baseline_bytes',COALESCE(octet_length(d.indexed_baseline),0),
        'baseline_stored',COALESCE(pg_column_size(d.indexed_baseline),0),
        'effects_stored',pg_column_size(d.pending_effects),'seed_bytes',d.seed_bytes,
        'quota_extra',d.storage_bytes) FROM source_documents d WHERE d.file_id=%s) AS editing,
      (SELECT COALESCE(sum(a.size_bytes),0) FROM artifact_cache a WHERE a.source_sha256=t.source_sha256) AS cache_bytes,
      (SELECT jsonb_agg(jsonb_build_object('kind',a.kind,'size',a.size_bytes)) FROM artifact_cache a
        WHERE a.source_sha256=t.source_sha256) AS caches
      FROM target t`,
        [fileId, fileId, fileId]
      );
      assert(stored && Number(stored.chunks) > 0, 'Missing processed content');
      const stateBytes = Number(
        stored.editing === null ? 0 : object(stored.editing).state_bytes
      );
      if (phase === 'edited') assert(stateBytes > 0, 'Edit was not saved');
      else assert.equal(stateBytes, 0, 'Unexpected retained editing state');
      const keys = new Set(
        readManifest(run.id)
          .resources.filter(
            (resource) =>
              resource.kind === 'blob' &&
              (resource.details.fileId === fileId ||
                resource.details.workspaceId === workspaceId)
          )
          .map((resource) => resource.id)
      );
      for (const row of await run.query(
        `SELECT caption_blob_path AS key FROM image_caption_associations WHERE file_id=%s
        UNION SELECT object_path AS key FROM artifact_cache WHERE source_sha256=%s`,
        [fileId, stored.source_sha256]
      )) {
        assert.equal(typeof row.key, 'string');
        keys.add(row.key as string);
        await run.record('blob', row.key as string, { cache: true, fileId });
      }
      const objects = [];
      for (const key of keys) {
        const versions = await verify<
          Array<{ latest: boolean; deleteMarker: boolean; size: number }>
        >({ key, operation: 'versions' });
        objects.push({
          key,
          current_bytes: versions.reduce(
            (sum, version) =>
              sum +
              (version.latest && !version.deleteMarker ? version.size : 0),
            0
          ),
          hidden_bytes: versions.reduce(
            (sum, version) =>
              sum +
              (!version.latest && !version.deleteMarker ? version.size : 0),
            0
          ),
        });
      }
      await run.attach(`storage-${set}-${name}-${phase}`, {
        set,
        name,
        phase,
        upload_bytes: bytes.length,
        ...stored,
        objects,
        object_current_bytes: objects.reduce(
          (sum, value) => sum + value.current_bytes,
          0
        ),
        object_hidden_bytes: objects.reduce(
          (sum, value) => sum + value.hidden_bytes,
          0
        ),
      });
    }
    await measure('initial');
    const format = name.split('.').at(-1) as OfficeFormat;
    const frame = await openEditor(run, run.owner, workspaceId, fileId);
    if (set === 'basic') await editOffice(run.owner, frame, format, false);
    else await editRich(run.owner.page, frame, format, false);
    await saved(run.owner.page);
    // Compare quota only after the requested edit exists in the durable export.
    await run.poll(
      `saved storage edit ${fileId}`,
      () => savedExport(run, fileId),
      (result) => {
        if (format === 'xlsx') {
          const sheets = readWorkbook(result.bytes, { type: 'buffer' }).Sheets;
          return set === 'basic'
            ? sheets.Grades.B2?.v === 43
            : sheets['CC info'].H5?.v === 4;
        }
        return result.text.includes(
          set === 'rich-content' && format === 'docx'
            ? '人數：24人'
            : 'Owner sentence: The launch code is CEDAR-42.'
        );
      },
      120_000
    );
    await officeCharge(run, fileId, before);
    await measure('edited');
    await refresh(run, fileId);
    await processed(run, fileId, []);
    await officeBundle(run, fileId);
    await officeCharge(run, fileId, before);
    await measure('reparsed');
  });
}
