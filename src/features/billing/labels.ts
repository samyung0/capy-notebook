import type { PlanTier, UserColor } from '@/api/types';
import { m } from '@/i18n';

export function planLabel(tier: PlanTier) {
  return tier === 'pro'
    ? m.subscription_plan_pro()
    : m.subscription_plan_free();
}

export function kindLabel(kind: string): string {
  switch (kind) {
    case 'llm':
      return m.billing_kind_llm();
    case 'embedding':
      return m.billing_kind_embedding();
    case 'rerank':
      return m.billing_kind_rerank();
    // Historical rows: figure captioning was retired, the ledger keeps them.
    case 'caption':
      return m.billing_kind_caption();
    case 'parse':
      return m.billing_kind_parse();
    case 'email':
      return m.billing_kind_email();
    default:
      return kind;
  }
}

type Area = { key: string; tone: UserColor; label: () => string };

const OTHER: Area = {
  key: 'other',
  label: m.billing_surface_other,
  tone: 'coral',
};

/** Product surfaces as the Usage tab groups them. Anything else, such as the
 * system surface that sends emails, counts as Other. */
export const AREAS: Area[] = [
  { key: 'chat', label: m.billing_surface_chat, tone: 'purple' },
  { key: 'generate', label: m.billing_surface_generate, tone: 'blue' },
  { key: 'ingest', label: m.billing_surface_ingest, tone: 'green' },
  { key: 'editor', label: m.billing_surface_editor, tone: 'amber' },
  OTHER,
];

export function areaOf(surface: string): Area {
  return AREAS.find((a) => a.key === surface) ?? OTHER;
}
