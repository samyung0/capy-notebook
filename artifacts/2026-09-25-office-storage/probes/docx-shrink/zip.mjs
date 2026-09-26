// Minimal ZIP reader (stored/deflated) for comparing exported packages.
import { inflateRawSync } from 'node:zlib';

export function unzip(bytes) {
  const buf = Buffer.from(bytes);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let off = buf.readUInt32LE(eocd + 16);
  const parts = new Map();
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    parts.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
  }
  return parts;
}

/** Part-level comparison: same, changed (with sizes) and one-sided names. */
export function compareParts(a, b) {
  const out = { same: 0, changed: [], onlyA: [], onlyB: [] };
  for (const [name, bytes] of a) {
    const other = b.get(name);
    if (!other) out.onlyA.push(name);
    else if (Buffer.compare(bytes, other) === 0) out.same++;
    else out.changed.push({ name, a: bytes.length, b: other.length });
  }
  for (const name of b.keys()) if (!a.has(name)) out.onlyB.push(name);
  return out;
}

export const count = (xml, tag) => (xml.match(new RegExp(`<${tag}[ >/]`, 'g')) ?? []).length;
