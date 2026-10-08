'use strict';
// Writes yjs-traffic.json.gz: random multi-writer editing made by Yjs itself
// (the browser editor's CRDT), delivered to a room as Yjs clients deliver it.
//   node collaboration-rs/crates/notes/tests/corpus/yjs-traffic.cjs
// (yjs resolves from the repository's node_modules). 60 seeds; per seed, 2-6
// Yjs docs edit nested XmlText blocks (inserts, deletes, bold on and off,
// align attributes) and gossip with each other; every fifth step on average
// one delivery reaches the room: a plain reconnect diff, a Y.mergeUpdates of
// one doc's consecutive updates (what draftStore sends), a Y.mergeUpdates of
// duplicated shuffled updates, or one of several docs' diffs. About half the
// deliveries are then applied to the room. The notes REVIEW4 jsmerge
// generator with fixed client ids (Yjs picks random ones, which change the
// order of concurrent inserts and so the whole run).
const Y = require('yjs');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

let s = 12_345;
const rnd = (n) => {
  s ^= s << 13;
  s >>>= 0;
  s ^= s >>> 17;
  s ^= s << 5;
  s >>>= 0;
  return n ? s % n : 0;
};
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const kinds = ['draft-run', 'overlap', 'cross-doc', 'diff'];
const seeds = [];
for (let seed = 0; seed < 60; seed++) {
  const room = new Y.Doc();
  room.clientID = 1;
  const croot = room.get('content', Y.XmlText);
  room.transact(() => {
    for (let i = 0; i < 3; i++) {
      const b = new Y.XmlText();
      croot.insertEmbed(i, b);
      b.setAttribute('type', 'p');
      b.insert(0, 'hello world');
    }
  });
  const base = Y.encodeStateAsUpdate(room);
  const docs = [];
  const logs = [];
  for (let i = 0; i < 2 + rnd(5); i++) {
    const d = new Y.Doc();
    d.clientID = 1000 * (seed + 1) + i;
    Y.applyUpdate(d, base);
    const log = [];
    d.on('update', (u) => log.push(u));
    docs.push(d);
    logs.push(log);
  }
  const deliveries = [];
  for (let r = 0; r < 300; r++) {
    const k = rnd(docs.length);
    const d = docs[k];
    const root = d.get('content', Y.XmlText);
    const blocks = root
      .toDelta()
      .filter((op) => op.insert instanceof Y.XmlText)
      .map((op) => op.insert);
    const op = rnd(10);
    if (op === 0 || blocks.length === 0) {
      const b = new Y.XmlText();
      root.insertEmbed(rnd(root.length + 1), b);
      b.setAttribute('type', 'p');
      b.insert(0, 'x');
    } else {
      const b = blocks[rnd(blocks.length)];
      const len = b.length;
      if (op <= 4) b.insert(rnd(len + 1), 'abcdef'.slice(0, 1 + rnd(5)));
      else if (op <= 6 && len > 0) {
        const at = rnd(len);
        b.delete(at, 1 + rnd(Math.min(4, len - at)));
      } else if (op <= 8 && len > 0) {
        const at = rnd(len);
        b.format(at, 1 + rnd(Math.min(6, len - at)), {
          bold: rnd(2) ? true : null,
        });
      } else b.setAttribute('align', ['l', 'r', 'c'][rnd(3)]);
    }
    if (rnd(4) === 0) {
      const a = docs[rnd(docs.length)];
      const b = docs[rnd(docs.length)];
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    }
    if (rnd(5) === 0) {
      const kind = rnd(4);
      let update;
      if (kind === 0) {
        const log = logs[rnd(logs.length)];
        const from = rnd(log.length + 1);
        const to = from + rnd(log.length - from + 1);
        update = Y.mergeUpdates(log.slice(from, to));
      } else if (kind === 1) {
        const log = logs[rnd(logs.length)];
        const pick = log.filter(() => rnd(2)).concat(log.filter(() => rnd(2)));
        pick.sort(() => rnd(3) - 1);
        update = Y.mergeUpdates(pick);
      } else if (kind === 2) {
        update = Y.mergeUpdates(
          docs
            .filter(() => rnd(2))
            .map((x) => Y.encodeStateAsUpdate(x, Y.encodeStateVector(room)))
        );
      } else {
        update = Y.encodeStateAsUpdate(
          docs[rnd(docs.length)],
          Y.encodeStateVector(room)
        );
      }
      const applied = rnd(2) === 1;
      if (applied) Y.applyUpdate(room, update);
      deliveries.push({ applied, kind: kinds[kind], update: b64(update) });
    }
  }
  seeds.push({ deliveries, initial: b64(base) });
}
const out = path.join(__dirname, 'yjs-traffic.json.gz');
fs.writeFileSync(
  out,
  zlib.gzipSync(
    JSON.stringify({ seeds, yjs: require('yjs/package.json').version }),
    { level: 9 }
  )
);
const deliveries = seeds.reduce((n, seed) => n + seed.deliveries.length, 0);
process.stdout.write(`${out}: ${deliveries} deliveries
`);
