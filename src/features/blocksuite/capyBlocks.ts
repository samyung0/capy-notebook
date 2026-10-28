import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from '@blocksuite/affine/ext-loader';
import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
} from '@blocksuite/affine/store';

/* Our own flavours (todo-blocksuite-layout.md, "Media and embeds"). Every
 * default is `undefined`, so loading a block writes nothing into the room:
 * the seed writes what a block holds. Their views are in capyViews.ts. */

/** Blocks a note, a list item or a paragraph may hold. */
const CONTENT_PARENTS = [
  'affine:note',
  'affine:paragraph',
  'affine:list',
  'capy:column',
];

export const CAPY_FLAVOURS: Record<
  string,
  { parent: string[]; props: string[] }
> = {
  'capy:audio': {
    parent: CONTENT_PARENTS,
    props: ['assetId', 'name', 'contentType', 'sizeBytes', 'caption'],
  },
  'capy:chart': { parent: ['affine:note'], props: ['block', 'width'] },
  'capy:column': { parent: ['capy:columns'], props: ['width'] },
  'capy:columns': { parent: ['affine:note'], props: [] },
  'capy:graph': { parent: ['affine:note'], props: ['block', 'width'] },
  'capy:html-embed': { parent: ['affine:note'], props: ['html', 'caption'] },
  'capy:material-ref': {
    parent: ['affine:note'],
    props: ['materialId', 'refKind'],
  },
  'capy:mermaid': {
    parent: CONTENT_PARENTS,
    props: ['source', 'caption', 'width', 'theme'],
  },
  'capy:plot': { parent: ['affine:note'], props: ['block', 'width'] },
  'capy:toc': { parent: CONTENT_PARENTS, props: [] },
  'capy:video': {
    parent: CONTENT_PARENTS,
    props: ['provider', 'videoId', 'width', 'caption'],
  },
};

/** Which flavours hold children: a column group its columns, a column
 * content blocks. */
const CHILDREN: Record<string, string[]> = {
  'capy:column': ['@content'],
  'capy:columns': ['capy:column'],
};

export class CapyBlockModel extends BlockModel<Record<string, unknown>> {}

export const capySchemas = Object.entries(CAPY_FLAVOURS).map(
  ([flavour, { parent, props }]) =>
    defineBlockSchema({
      flavour,
      metadata: {
        children: CHILDREN[flavour] ?? [],
        parent,
        // A column sits under its group, which a note may hold as content.
        role: flavour === 'capy:column' ? 'hub' : 'content',
        version: 1,
      },
      props: () =>
        Object.fromEntries(props.map((name) => [name, undefined])) as Record<
          string,
          unknown
        >,
      toModel: () => new CapyBlockModel(),
    })
);

export class CapyStoreExtension extends StoreExtensionProvider {
  override name = 'capy-blocks';

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(capySchemas.map((schema) => BlockSchemaExtension(schema)));
  }
}
