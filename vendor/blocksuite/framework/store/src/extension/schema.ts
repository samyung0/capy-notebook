import { createIdentifier } from '@blocksuite/global/di';

import type { BlockSchemaType } from '../model/block/zod';
import type { Schema } from '../schema/schema';
import type { ExtensionType } from './extension';

export const BlockSchemaIdentifier =
  createIdentifier<BlockSchemaType>('BlockSchema');

export function BlockSchemaExtension(
  blockSchema: BlockSchemaType
): ExtensionType {
  return {
    setup: di => {
      di.addImpl(
        BlockSchemaIdentifier(blockSchema.model.flavour),
        () => blockSchema
      );
    },
  };
}

/* Capy (vendor/blocksuite/README.md, local change 62): `Schema.standIn` for a
 * store, from its extensions. */
export const BlockStandInIdentifier =
  createIdentifier<NonNullable<Schema['standIn']>>('BlockStandIn');

export function BlockStandInExtension(
  standIn: NonNullable<Schema['standIn']>
): ExtensionType {
  return {
    setup: di => {
      di.addImpl(BlockStandInIdentifier, () => standIn);
    },
  };
}
