import { m } from '@/i18n';
import { isKnownElementType } from './document';

/** Under an element the embed catalog does not list (a block from a newer
 * version): the document stays readable, with this notice where the block
 * is (Epo 2026-10-13, todo-embeds.md decision 5). */
export function UnsupportedBlockNotice({
  element,
}: {
  element: { type: string };
}) {
  if (isKnownElementType(element.type)) return null;
  return (
    <span
      className="block font-sans text-fg-muted text-sm"
      contentEditable={false}
      data-unsupported-block={element.type}
    >
      {m.material_unsupported_block()}
    </span>
  );
}
