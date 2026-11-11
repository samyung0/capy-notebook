/** One page of a mocked list, as the server's cursor-paged lists answer: the
 * request's `limit` rows (50 unless it asks) from its `cursor`, here the offset. */
export function mockPage<T>(rows: T[], request: Request, size = 50) {
  const search = new URL(request.url).searchParams;
  const offset = Number(search.get('cursor') ?? 0);
  const end = offset + Number(search.get('limit') ?? size);
  return {
    items: rows.slice(offset, end),
    nextCursor: end < rows.length ? String(end) : undefined,
  };
}
