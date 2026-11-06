import type { ResolvedEditorAsset } from '@/api/editorAssets';

/** Signed links a tab already holds, by asset, in memory only (Epo 2026-11-06,
 * narrowing the 2026-09-11 "each consumer fetches its own" for note images): a
 * note and its Preview show an image once, offline too. */
const links = new Map<string, ResolvedEditorAsset>();

/** How long before its expiry a link stops being handed out. */
const EXPIRY_MARGIN_MS = 10_000;

const live = (link: ResolvedEditorAsset) =>
  Date.parse(link.expiresAt) - Date.now() > EXPIRY_MARGIN_MS;

/** A link still good now, to paint without waiting. */
export function heldAssetLink(assetId: string) {
  const link = links.get(assetId);
  return link && live(link) ? link : undefined;
}

/** The asset's link, asking only when none is good. `again`: the one held failed. */
export async function assetLink(
  assetId: string,
  signal: AbortSignal,
  again: boolean
) {
  const held = again ? undefined : links.get(assetId);
  if (held && live(held)) return held;
  try {
    // Its module holds the upload code, which shared pages never load.
    const { resolveEditorAsset } = await import('@/api/editorAssets');
    const link = await resolveEditorAsset(assetId, signal);
    links.set(assetId, link);
    return link;
  } catch (error) {
    // Unreachable, the browser may still have the image at its old link. An
    // answer (a refusal, it's gone) ends it.
    const answered = error instanceof Error && 'status' in error;
    if (held && !answered) return held;
    links.delete(assetId);
    throw error;
  }
}

/** At sign-out: another account in this tab asks for its own. */
export function forgetAssetLinks() {
  links.clear();
}
