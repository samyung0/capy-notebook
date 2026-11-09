import {
  makeDeepOptional,
  NodePropsSchema,
} from '@blocksuite/affine/shared/utils';
import { expect, it } from 'vitest';
import type { z } from 'zod';

// Every edit on the canvas records its props against these, with only the props it
// changed, so a required key throws on a stroke, shape, label or note.
it('accepts a partial edit of every kind of element', () => {
  const schema = makeDeepOptional(
    NodePropsSchema
  ) as z.ZodOptional<z.ZodObject>;
  for (const kind of Object.values(schema._def.innerType.shape)) {
    expect((kind as z.ZodType).safeParse({ xywh: '[0,0,1,1]' }).success).toBe(
      true
    );
  }
});
