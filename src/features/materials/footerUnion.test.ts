import { describe, expect, it } from 'vitest';
import type { Provenance } from '@/api/types';
import parity from '../../../server/internal/store/testdata/footer_union_parity.json';
import { noteFooterProvenance } from './footerUnion';

type ParityCase = {
  name: string;
  own: Provenance | null;
  embeds: Provenance[];
  want: { books: string[]; web: string[]; license: string } | null;
};

// The app's note footer credits what Go's union credits, under the same
// licence line, on the shared parity table (TestFooterUnionParity reads it).
describe('noteFooterProvenance', () => {
  it.each((parity as ParityCase[]).map((c) => [c.name, c] as const))(
    '%s',
    (_name, c) => {
      const got = noteFooterProvenance(c.own ?? undefined, c.embeds);
      if (!c.want) {
        expect(got).toBeUndefined();
        return;
      }
      expect({
        books: got?.books.map((book) => book.id),
        license: got?.license ?? '',
        web: (got?.web ?? []).map((page) => page.url),
      }).toEqual(c.want);
    }
  );
});
