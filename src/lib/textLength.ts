/** Characters as the backend counts them (runes), so an emoji counts once. */
export function textLength(text: string | null | undefined) {
  return text ? Array.from(text).length : 0;
}
