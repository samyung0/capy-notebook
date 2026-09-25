// Shared: weigh a DOCX Yjs state by component (JSON bytes of payload keys,
// format attributes, text) and by encoded bytes when a component is removed.
import { office, Y } from '../storage/lib.mjs';

export const json = (v) =>
  JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? `<bin ${x.length}>` : x));
export const len = (v) => (v === undefined ? 0 : Buffer.byteLength(json(v)));

export function load(state) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc;
}

/** JSON-byte weights by component, over every story. */
export function weigh(doc) {
  const w = { text: 0, textItems: 0, formatStarts: 0, formatBytes: {}, embedKeys: {}, boundary: {}, embeds: {} };
  for (const [, story] of doc.getMap('stories')) {
    // Walk items to count format items exactly as stored.
    for (let it = story._start; it; it = it.right) {
      if (it.deleted) continue;
      const c = it.content;
      const name = c.constructor.name;
      if (name === 'ContentString') {
        w.text += Buffer.byteLength(c.str);
        w.textItems++;
      } else if (name === 'ContentFormat') {
        w.formatBytes[c.key] = (w.formatBytes[c.key] ?? 0) + Buffer.byteLength(c.key) + len(c.value);
        if (c.value !== null) w.formatStarts++;
      } else if (name === 'ContentType') {
        const obj = c.type.toJSON();
        w.embeds[obj._kind] = (w.embeds[obj._kind] ?? 0) + 1;
        for (const [k, v] of Object.entries(obj)) {
          const key = `${obj._kind}.${k}`;
          w.embedKeys[key] = (w.embedKeys[key] ?? 0) + len(v);
        }
        for (const b of obj._originalRunBoundaries ?? [])
          for (const [k, v] of Object.entries(b)) w.boundary[k] = (w.boundary[k] ?? 0) + len(v);
      }
    }
  }
  return w;
}

/**
 * Rebuild the stories in a fresh single-client Yjs doc, the way the Rust seed
 * writes them (one insert per text run with its attributes, embeds as maps),
 * after `transform` edits each delta op. Returns the v1 update.
 */
export function rebuild(doc, transform = (op) => op, { clientID = 1 } = {}) {
  const out = new Y.Doc({ gc: true });
  out.clientID = clientID;
  const stories = out.getMap('stories');
  out.transact(() => {
    for (const [id, story] of doc.getMap('stories')) {
      const text = new Y.Text();
      stories.set(id, text);
      let index = 0;
      for (const raw of story.toDelta()) {
        const op = transform(
          typeof raw.insert === 'string'
            ? { insert: raw.insert, attributes: { ...(raw.attributes ?? {}) } }
            : { insert: raw.insert.toJSON(), attributes: { ...(raw.attributes ?? {}) }, embed: true }
        );
        if (!op) continue;
        if (!op.embed) {
          text.insert(index, op.insert, op.attributes ?? {});
          index += op.insert.length;
        } else {
          const map = new Y.Map();
          for (const [k, v] of Object.entries(op.insert)) if (v !== undefined) map.set(k, v);
          text.insertEmbed(index, map, op.attributes ?? {});
          index += 1;
        }
      }
    }
  });
  return Y.encodeStateAsUpdate(out);
}

export { office, Y };
