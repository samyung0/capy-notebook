const QUIZ_RETURN_PATH = /^\/(?:files|(?:materials|workspaces)\/[^/]+)$/;

/** Quiz editors return to their source page, never another quiz editor. */
export function parseQuizEditSearch(search: Record<string, unknown>): {
  returnTo?: string;
} {
  const value = search.returnTo;
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\')
  )
    return {};
  for (const character of value) {
    if (character.charCodeAt(0) <= 32) return {};
  }
  const url = new URL(value, 'https://capy.invalid');
  if (!QUIZ_RETURN_PATH.test(url.pathname)) {
    return {};
  }
  return { returnTo: `${url.pathname}${url.search}${url.hash}` };
}
