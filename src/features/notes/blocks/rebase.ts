import type { PlotBlock } from '@/features/questions/types';
import { sameJson } from '@/lib/sameJson';

type Fields = Record<string, unknown>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The user's change since `base` wins, else the peer's value, absent
 * (`undefined`) included. */
const pick = (base: unknown, draft: unknown, peer: unknown) =>
  sameJson(draft, base) ? peer : draft;

function fields(base: Fields, draft: Fields, peer: Fields, series: boolean) {
  const out: Fields = {};
  const keys = new Set([
    ...Object.keys(peer),
    ...Object.keys(draft),
    ...Object.keys(base),
  ]);
  for (const key of keys) {
    const [b, d, p] = [base[key], draft[key], peer[key]];
    const value =
      series &&
      key === 'series' &&
      Array.isArray(b) &&
      Array.isArray(d) &&
      Array.isArray(p)
        ? byIndex(b, d, p)
        : pick(b, d, p);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Series by index, each series' fields on their own; one the user added,
 * changed or deleted keeps the user's say. */
function byIndex(base: unknown[], draft: unknown[], peer: unknown[]) {
  const out: unknown[] = [];
  for (let i = 0; i < Math.max(draft.length, peer.length); i++) {
    const [b, d, p] = [base[i], draft[i], peer[i]];
    const value =
      isRecord(b) && isRecord(d) && isRecord(p)
        ? fields(b, d, p, false)
        : pick(b, d, p);
    if (value !== undefined) out.push(value);
  }
  return out;
}

/**
 * A plot dialog's draft on a peer's newer plot (Epo 2026-10-17): what the
 * user changed since `base` keeps the user's value, the rest follows `peer`,
 * field by field and its series by index, so Save writes only what the user
 * changed. Charts and graphs hold no draft: their dialog is live (Epo
 * 2026-11-16).
 */
export function rebasePlot(
  base: PlotBlock,
  draft: PlotBlock,
  peer: PlotBlock
): PlotBlock {
  return fields(base, draft, peer, true) as PlotBlock;
}
