import { type UpsertLinkOptions, upsertLink } from '@platejs/link';

type LinkEditor = Parameters<typeof upsertLink>[0];
export type LinkSelection = NonNullable<LinkEditor['selection']>;

export function cloneLinkSelection(
  selection: LinkEditor['selection']
): LinkSelection | null {
  if (!selection) return null;

  return {
    anchor: {
      offset: selection.anchor.offset,
      path: [...selection.anchor.path],
    },
    focus: {
      offset: selection.focus.offset,
      path: [...selection.focus.path],
    },
  };
}

export function upsertLinkAtSelection(
  editor: LinkEditor,
  selection: LinkSelection | null,
  options: UpsertLinkOptions
) {
  if (!selection) return false;

  editor.tf.select(selection);
  return Boolean(upsertLink(editor, options));
}
