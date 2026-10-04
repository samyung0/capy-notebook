import * as Y from 'yjs';

/**
 * A service-side working Y.Doc (a merge, a measurement, a snapshot). The guid
 * is fixed because the default costs a webcrypto UUID per document (about
 * 150-200 us against 7-16 us); a guid only names subdocuments, which these
 * documents never hold or encode.
 */
export function scratchDoc(gc = true) {
  return new Y.Doc({ gc, guid: 'scratch' });
}
