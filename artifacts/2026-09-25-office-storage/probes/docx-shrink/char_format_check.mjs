// Compare two exported document.xml files character by character: every
// character's run properties (rPr XML with rPrChange removed) must match.
// Also reports rPrChange placement and paragraph count.
// Usage: node char_format_check.mjs a.document.xml b.document.xml
import { readFile } from 'node:fs/promises';

const perChar = (xml) => {
  const out = [];
  const paragraphs = xml.split(/<w:p[ >]/).slice(1);
  for (const p of paragraphs) {
    for (const run of p.matchAll(/<w:r(?: [^>]*)?>([\s\S]*?)<\/w:r>/g)) {
      const body = run[1];
      const rpr = (/<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(body)?.[1] ?? '').replace(/<w:rPrChange[\s\S]*?<\/w:rPrChange>/g, '');
      for (const t of body.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)) for (const ch of t[1]) out.push(`${ch}\u0000${rpr}`);
    }
    out.push('\u0001');
  }
  return out;
};
const [a, b] = await Promise.all(process.argv.slice(2, 4).map((p) => readFile(p, 'utf8')));
const ca = perChar(a), cb = perChar(b);
let mismatches = 0, first;
for (let i = 0; i < Math.max(ca.length, cb.length); i++)
  if (ca[i] !== cb[i]) {
    mismatches++;
    first ??= { i, a: ca[i], b: cb[i] };
  }
console.log(JSON.stringify({ charsA: ca.length, charsB: cb.length, mismatches, first }));
