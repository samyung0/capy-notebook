// Are DOCX images carried in the Yjs state as base64 data URLs? Measure exactly.
import { readFile } from 'node:fs/promises';
import { office, sha } from './lib.mjs';
import { inflateRawSync } from 'node:zlib';
const path = process.argv[2];
const bytes = new Uint8Array(await readFile(path));
const seed = await office.seedOffice('docx', bytes);
const state = Buffer.from(seed.state);
// Read media parts from the zip central directory (stored or deflated).
const buf = Buffer.from(bytes);
const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
let off = buf.readUInt32LE(eocd + 16);
const media = [];
for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
  const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20);
  const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), commentLen = buf.readUInt16LE(off + 32);
  const local = buf.readUInt32LE(off + 42);
  const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
  off += 46 + nameLen + extraLen + commentLen;
  if (!name.startsWith('word/media/')) continue;
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const raw = buf.subarray(start, start + csize);
  media.push({ name, data: method === 0 ? raw : inflateRawSync(raw) });
}
let imageBytes = 0, base64Bytes = 0, found = 0, rawCopies = 0;
for (const m of media) {
  imageBytes += m.data.length;
  const b64 = m.data.toString('base64');
  base64Bytes += b64.length;
  if (state.indexOf(Buffer.from(b64)) >= 0) found++;
  // Is there also a raw binary copy of the image in the state?
  if (state.indexOf(m.data.subarray(0, 4096)) >= 0) rawCopies++;
}
console.log(JSON.stringify({ file: path.split('/').pop(), images: media.length, imageBytes, base64Bytes, fullBase64FoundInState: found, rawBinaryCopiesInState: rawCopies, state: state.length, stateOverImageBytes: +(state.length / imageBytes).toFixed(3), base64ShareOfState: +(base64Bytes / state.length).toFixed(3), stateExcludingBase64: state.length - base64Bytes }));
