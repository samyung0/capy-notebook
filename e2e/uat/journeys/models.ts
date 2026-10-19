/* biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared assertion helpers execute inside the UAT tests. */
// Model slot checks: a real call per slot reached the catalog row the slot's
// platform default names (model_configs.is_default_for), through the transport
// EliteLLM routes it to, and settled. They validate the catalog and the
// adapter, never what a model said.
import assert from 'node:assert/strict';
import type { UatRun } from './runtime';

export type CatalogRow = {
  provider_slug: string;
  model_slug: string;
  version: number;
};

/** The slot's platform default; rerank alone may have none (search then
 * keeps fused order). */
export async function slotDefault(
  run: UatRun,
  slot: 'chat' | 'captioning' | 'retrieval' | 'rerank'
): Promise<CatalogRow | undefined> {
  const rows = await run.query<CatalogRow>(
    `SELECT provider_slug,model_slug,version FROM model_configs
    WHERE enabled AND %s=ANY(is_default_for)`,
    [slot]
  );
  assert(rows.length <= 1, `${slot} has more than one default`);
  if (slot !== 'rerank') assert.equal(rows.length, 1, `${slot} has no default`);
  return rows[0];
}

export type ProviderCall = {
  id: string;
  kind: string;
  purpose: string;
  status: string;
  provider: string;
  model: string;
  opened_at: string;
  abandoned_at: string | null;
  error_code: string | null;
  catalog_provider_slug: string | null;
  catalog_model_slug: string | null;
  model_version: number | null;
  credit_micros: string | null;
};

const CALLS = `SELECT DISTINCT c.id,c.kind,c.purpose,c.status,c.provider,c.model,c.opened_at,c.abandoned_at,c.error_code,
  u.catalog_provider_slug,u.catalog_model_slug,u.model_version,u.credit_micros
  FROM provider_calls c
  LEFT JOIN usage_events u ON u.provider_call_id=c.id AND u.reservation_id=c.reservation_id`;

/** One provider session's calls with the usage rows that settled them. */
export const sessionCalls = (run: UatRun, sessionId: string) =>
  run.query<ProviderCall>(
    `${CALLS} WHERE c.reservation_id=%s ORDER BY c.opened_at`,
    [sessionId]
  );

/**
 * Each call succeeded on `row`: applied, sent to its transport, and its usage
 * row priced against that exact catalog row. `charged` says whether the
 * actor pays credits for it (LLM calls) or it is recorded at zero (query
 * embeddings, reranks).
 */
export function onRow(
  calls: ProviderCall[],
  row: CatalogRow,
  charged: boolean
) {
  for (const call of calls) {
    assert.equal(call.status, 'applied', `${call.kind} call ${call.id}`);
    assert.equal(call.provider, row.provider_slug);
    assert.equal(call.model, row.model_slug);
    assert.deepEqual(
      [
        call.catalog_provider_slug,
        call.catalog_model_slug,
        Number(call.model_version),
      ],
      [row.provider_slug, row.model_slug, Number(row.version)]
    );
    if (charged) assert(Number(call.credit_micros) > 0, `${call.id} is free`);
    else assert.equal(Number(call.credit_micros), 0);
  }
}

/**
 * Rerank calls on `row`. Applied ones as `onRow` (free); one that timed out
 * (still open, or abandoned `receipt_timeout`) has no usage row and no charge,
 * since search keeps fused order by design (Epo 2026-10-17). Returns those
 * tolerated calls for the evidence.
 */
export function rerankOnRow(calls: ProviderCall[], row: CatalogRow) {
  onRow(
    calls.filter((call) => call.status === 'applied'),
    row,
    false
  );
  const tolerated = calls.filter((call) => call.status !== 'applied');
  for (const call of tolerated) {
    assert(
      call.status === 'open' ||
        (call.status === 'abandoned' && call.error_code === 'receipt_timeout'),
      `rerank call ${call.id} is ${call.status} (${call.error_code})`
    );
    assert.equal(call.provider, row.provider_slug);
    assert.equal(call.model, row.model_slug);
    assert.deepEqual(
      [call.catalog_provider_slug, call.credit_micros],
      [null, null],
      `unanswered rerank call ${call.id} has a usage row`
    );
  }
  return tolerated.map(({ abandoned_at, id, opened_at, status }) => ({
    abandoned_at,
    id,
    opened_at,
    status,
  }));
}

/** A standalone image's caption was one applied call on the captioning
 * default, which its ingest job pinned at enqueue. */
export async function captionedByDefault(run: UatRun, fileId: string) {
  const row = await slotDefault(run, 'captioning');
  assert(row);
  const pins = await run.query(
    `SELECT payload->>'captioningProviderSlug' AS provider_slug,payload->>'captioningModelSlug' AS model_slug,
    (payload->>'captioningModelVersion')::int AS version FROM jobs WHERE payload->>'fileId'=%s AND type='ingest'`,
    [fileId]
  );
  assert(pins.length > 0, 'the image has no ingest job');
  for (const pin of pins)
    assert.deepEqual(
      [pin.provider_slug, pin.model_slug, Number(pin.version)],
      [row.provider_slug, row.model_slug, Number(row.version)]
    );
  const calls = await run.query<ProviderCall>(
    `${CALLS} JOIN jobs j ON j.payload->>'reservationId'=c.reservation_id
    WHERE j.payload->>'fileId'=%s AND c.purpose='image_caption'`,
    [fileId]
  );
  assert.equal(calls.length, 1, 'one caption call');
  onRow(calls, row, true);
  await run.attach(`${fileId}-caption`, { calls, row });
}
