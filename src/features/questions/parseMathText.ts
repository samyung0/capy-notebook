export type MathTextToken = {
  type: 'text' | 'inline' | 'display';
  value: string;
};

/** Only paired, unescaped delimiters become math. Incomplete input stays readable. */
export function parseMathText(source: string): MathTextToken[] {
  const tokens: MathTextToken[] = [];
  let text = '';
  for (let i = 0; i < source.length; ) {
    if (source[i] === '\\' && source[i + 1] === '$') {
      text += '$';
      i += 2;
      continue;
    }
    if (source[i] !== '$') {
      text += source[i++];
      continue;
    }
    const delimiter = source.startsWith('$$', i) ? '$$' : '$';
    let end = i + delimiter.length;
    while (end < source.length) {
      if (source[end] === '\\') {
        end += 2;
        continue;
      }
      if (
        source.startsWith(delimiter, end) &&
        (delimiter === '$$' ||
          (source[end + 1] !== '$' && source[end - 1] !== '$'))
      )
        break;
      end++;
    }
    if (end >= source.length || end === i + delimiter.length) {
      text += delimiter;
      i += delimiter.length;
      continue;
    }
    if (text) tokens.push({ type: 'text', value: text });
    text = '';
    tokens.push({
      type: delimiter === '$$' ? 'display' : 'inline',
      value: source.slice(i + delimiter.length, end),
    });
    i = end + delimiter.length;
  }
  if (text) tokens.push({ type: 'text', value: text });
  return tokens;
}
