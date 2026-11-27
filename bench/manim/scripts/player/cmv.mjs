// CMV reader in JavaScript (see ../cmv.py for the format): what a browser player would do with a
// film. Drawn form: decompress each second, undo the coding against bases, dequantize, refine
// surfaces, rebuild records, up to the point of handing arrays to the renderer. Both forms: each
// second's H.264 segments, as access units for WebCodecs.
//
//   const reader = new Reader(bytes, decompress);   // decompress: Uint8Array → Uint8Array (zstd)
//   for (let c = 0; c < reader.chunks.length; c++) reader.chunk(c, sink);
//   reader.segments(c)   // a chunk's video segments alone (all a video film needs)

const ALONE = 0, FIRST = 1, SECOND = 2, TAIL = 3;
const OP = { PATH: 1, POINTS: 2, MESH: 3, GRID: 4, ROWS: 5, TEXTURE: 6, GROW: 7, FRAME: 8, NOTE: 9, SOUND: 10, ENVIRONMENT: 11, VIDEO_FRAME: 12, END: 13 };
const RECORD = 336;

class In {
  constructor(bytes) {
    this.b = bytes;
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.at = 0;
  }
  u8() { return this.b[this.at++]; }
  u32() { const x = this.v.getUint32(this.at, true); this.at += 4; return x; }
  f32s(n) { const out = []; for (let i = 0; i < n; i++) { out.push(this.v.getFloat32(this.at, true)); this.at += 4; } return out; }
  take(n) { const s = this.b.subarray(this.at, this.at + n); this.at += n; return s; }
  bytes() { return this.take(this.u32()); }
  done() { return this.at >= this.b.length; }
  /** An int array: n rows of `lanes`, stored lane by lane as int32; returned row-major. */
  ints() {
    const n = this.u32(), lanes = this.u8();
    const raw = this.take(4 * n * lanes);
    const src = new Int32Array(raw.slice().buffer); // aligned copy
    const out = new Float64Array(n * lanes);
    for (let l = 0; l < lanes; l++) for (let i = 0; i < n; i++) out[i * lanes + l] = src[l * n + i];
    return { n, lanes, a: out };
  }
}

function cumsum({ n, lanes, a }, start) {
  for (let l = 0; l < lanes; l++) {
    let s = start ? start[l] : 0;
    for (let i = 0; i < n; i++) { s += a[i * lanes + l]; a[i * lanes + l] = s; }
  }
}

/** Order-preserving integer → float32 bits (inverse of cmv.ordered). */
function unordered(o) {
  return o < 0 ? (-(o + 1) | 0x80000000) >>> 0 : o >>> 0;
}

export class Reader {
  constructor(bytes, decompress) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (String.fromCharCode(...bytes.subarray(0, 4)) !== "CMV0") throw new Error("not a CMV file");
    const n = v.getUint32(4, true);
    this.meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + n)));
    let at = 8 + n;
    this.chunks = [];
    for (let i = 0; i < this.meta.chunks; i++, at += 24) {
      this.chunks.push({
        offset: Number(v.getBigUint64(at, true)), draw: v.getUint32(at + 8, true), video: v.getUint32(at + 12, true),
        first: v.getUint32(at + 16, true), frames: v.getUint32(at + 20, true),
      });
    }
    this.body = at;
    this.bytes = bytes;
    this.decompress = decompress;
    this.q = this.meta.q;
    this.arrays = new Map(); // "kid:role" → {n, lanes, a}
    this.parent = new Map();
    this.written = new Map(); // "kid:role" → chunk it was written in
    this.current = 0;
    this.prevView = this.prevView2 = this.prevRec = this.prevRec2 = null;
    this.resident = 0; // bytes of decoded uploads handed on (what a player keeps)
  }

  array(inp, kid, role, points) {
    const coding = inp.u8();
    let baseRef = null, base2Ref = null;
    if (coding !== ALONE) {
      baseRef = `${inp.u32()}:${role}`;
      if (coding === SECOND) base2Ref = `${inp.u32()}:${role}`;
    }
    const r = inp.ints();
    const base = baseRef && this.arrays.get(baseRef), base2 = base2Ref && this.arrays.get(base2Ref);
    let q = r;
    if (coding === ALONE) { if (points) cumsum(r); }
    else if (coding === FIRST) { for (let i = 0; i < r.a.length; i++) r.a[i] += base.a[i]; }
    else if (coding === SECOND) { for (let i = 0; i < r.a.length; i++) r.a[i] += 2 * base.a[i] - base2.a[i]; }
    else if (coding === TAIL) {
      if (points) cumsum(r, base.a.subarray(base.a.length - base.lanes));
      const a = new Float64Array(base.a.length + r.a.length);
      a.set(base.a); a.set(r.a, base.a.length);
      q = { n: base.n + r.n, lanes: r.lanes, a };
    }
    const ref = `${kid}:${role}`;
    this.arrays.set(ref, q);
    this.parent.set(ref, coding !== ALONE ? baseRef : null);
    this.written.set(ref, this.current);
    if (base2Ref && this.arrays.has(base2Ref)) this.arrays.delete(this.parent.get(base2Ref) ?? "");
    return q;
  }

  records(inp, base, base2) {
    const coding = inp.u8();
    let r = inp.ints();
    if (coding === FIRST) for (let i = 0; i < r.a.length; i++) r.a[i] += base.a[i];
    else if (coding === SECOND) for (let i = 0; i < r.a.length; i++) r.a[i] += 2 * base.a[i] - base2.a[i];
    else if (coding === TAIL) {
      const a = new Float64Array(base.a.length + r.a.length);
      a.set(base.a); a.set(r.a, base.a.length);
      r = { n: base.n + r.n, lanes: r.lanes, a };
    }
    const out = new Uint8Array(r.n * RECORD), dv = new DataView(out.buffer);
    for (let i = 0; i < r.n; i++) {
      const row = i * r.lanes, at = i * RECORD;
      for (let k = 0; k < 7; k++) dv.setBigUint64(at + 8 * k, BigInt(r.a[row + k]), true);
      dv.setInt32(at + 56, r.a[row + 7], true);
      dv.setInt32(at + 60, r.a[row + 8], true);
      for (let f = 0; f < 68; f++) dv.setUint32(at + 64 + 4 * f, unordered(r.a[row + 9 + f]), true);
    }
    return { q: r, bytes: out };
  }

  scaled(q, step, Type) {
    const out = new Type(q.a.length);
    for (let i = 0; i < q.a.length; i++) out[i] = q.a[i] / step;
    return out;
  }

  /** Chunk c's video segments: {track, first, colour: [access units], alpha: [access units]}. */
  segments(c) {
    const { offset, draw, video } = this.chunks[c];
    if (!video) return [];
    const at = this.body + offset + draw, inp = new In(this.bytes.subarray(at, at + video)), out = [];
    for (let s = inp.u8(); s > 0; s--) {
      const track = inp.u32(), first = inp.u32(), n = inp.u32();
      const sizes = Array.from({ length: n * (this.meta.tracks[track].alpha ? 2 : 1) }, () => inp.u32());
      const units = sizes.map((k) => inp.take(k));
      out.push({ track, first, colour: units.slice(0, n), alpha: units.slice(n) });
    }
    return out;
  }

  /** Decode chunk c, handing its segments to sink.segment and each upload and frame to sink[op](…). */
  chunk(c, sink) {
    // only arrays written in this chunk or the one before are bases (cmv.forget)
    this.current = c;
    for (const [ref, w] of this.written) if (w < c - 1) { this.arrays.delete(ref); this.parent.delete(ref); this.written.delete(ref); }
    for (const s of this.segments(c)) sink.segment?.(s);
    const { offset, draw } = this.chunks[c];
    const inp = new In(draw ? this.decompress(this.bytes.subarray(this.body + offset, this.body + offset + draw)) : new Uint8Array(0));
    const Q = this.q;
    while (!inp.done()) {
      const op = inp.u8();
      if (op === OP.PATH) {
        const kid = inp.u32(), ca = inp.f32s(6);
        const p = this.array(inp, kid, 0, true), s = this.array(inp, kid, 1, false);
        const points = this.scaled(p, Q.geometry, Float64Array);
        this.resident += points.byteLength + s.a.length * 4;
        sink.path?.(kid, points, Uint32Array.from(s.a), ca);
      } else if (op === OP.GROW) {
        const kid = inp.u32(), closed = inp.u8();
        const r = inp.ints(); cumsum(r);
        const points = this.scaled(r, Q.geometry, Float64Array);
        this.resident += points.byteLength;
        sink.grow?.(kid, points, closed);
      } else if (op === OP.POINTS) {
        const kid = inp.u32();
        const v = this.scaled(this.array(inp, kid, 0, true), Q.points, Float32Array);
        this.resident += v.byteLength;
        sink.points?.(kid, v);
      } else if (op === OP.MESH) {
        const kid = inp.u32(), outline = inp.u32(), block = inp.u32();
        const p = this.scaled(this.array(inp, kid, 0, true), Q.surface, Float32Array);
        const uv = this.scaled(this.array(inp, kid, 1, false), Q.uv, Float32Array);
        const nrm = this.scaled(this.array(inp, kid, 2, false), Q.normals, Float32Array);
        const tri = Uint32Array.from(this.array(inp, kid, 3, false).a);
        this.resident += p.byteLength + uv.byteLength + nrm.byteLength + tri.byteLength;
        sink.mesh?.(kid, p, uv, nrm, tri, outline, block);
      } else if (op === OP.GRID) {
        const kid = inp.u32();
        const [u, v, first, end, steps] = [inp.u32(), inp.u32(), inp.u32(), inp.u32(), inp.u32()];
        const g = this.scaled(this.array(inp, kid, 0, true), Q.surface, Float64Array);
        const uv = this.scaled(this.array(inp, kid, 1, false), Q.uv, Float64Array);
        const mesh = refine(g, uv, u, v, steps, first, end);
        this.resident += mesh.points.byteLength + mesh.uvs.byteLength + mesh.normals.byteLength + mesh.triangles.byteLength;
        sink.mesh?.(kid, mesh.points, mesh.uvs, mesh.normals, mesh.triangles, 4 * steps + 1, mesh.block);
      } else if (op === OP.ROWS) {
        const kid = inp.u32(), k = inp.u32();
        const cells = this.scaled(this.array(inp, kid, 0, false), Q.rows, Float32Array);
        const r = k === 1 ? cells : new Float32Array(cells.length * k);
        if (k > 1) for (let i = 0; i < cells.length / 4; i++) for (let j = 0; j < k; j++) r.set(cells.subarray(i * 4, i * 4 + 4), (i * k + j) * 4);
        this.resident += r.byteLength;
        sink.rows?.(kid, r);
      } else if (op === OP.TEXTURE) {
        const kid = inp.u32(), w = inp.u32(), h = inp.u32();
        const px = Uint8Array.from(this.array(inp, kid, 0, false).a);
        this.resident += px.byteLength;
        sink.texture?.(kid, w, h, px);
      } else if (op === OP.VIDEO_FRAME) {
        const kid = inp.u32(), track = inp.u32(), index = inp.u32();
        sink.video?.(kid, track, index);
      } else if (op === OP.ENVIRONMENT) {
        const id = inp.u32(), w = inp.u32(), h = inp.u32();
        const rgbe = inp.bytes(); // read before the call: an absent handler skips its arguments
        sink.environment?.(id, w, h, rgbe);
      } else if (op === OP.FRAME) {
        const repeat = inp.u32();
        const coding = inp.u8();
        const r = inp.ints();
        if (coding === FIRST) for (let i = 0; i < r.a.length; i++) r.a[i] += this.prevView.a[i];
        else if (coding === SECOND) for (let i = 0; i < r.a.length; i++) r.a[i] += 2 * this.prevView.a[i] - this.prevView2.a[i];
        this.prevView2 = this.prevView; this.prevView = r;
        const view = new Uint32Array(r.a.length);
        for (let i = 0; i < r.a.length; i++) view[i] = unordered(r.a[i]);
        const rec = this.records(inp, this.prevRec, this.prevRec2);
        this.prevRec2 = this.prevRec; this.prevRec = rec.q;
        const cams = [];
        for (let k = inp.u32(); k > 0; k--) {
          const id = inp.u32(), w = inp.u32(), h = inp.u32();
          cams.push([id, w, h, inp.bytes(), this.records(inp).bytes]);
        }
        sink.frame?.(new Uint8Array(view.buffer), rec.bytes, repeat, cams);
      } else if (op === OP.NOTE) {
        const text = new TextDecoder().decode(inp.bytes());
        sink.note?.(text);
      } else if (op === OP.SOUND) {
        const file = inp.bytes();
        sink.sound?.(file);
      } else if (op === OP.END) {
        const failed = inp.u8();
        sink.end?.(failed);
      } else throw new Error(`unknown op ${op} in chunk ${c}`);
    }
  }
}

// ── surfaces: ManimGX's refinement (feed.refine_surface), from the sample grid ───────────────
const DERIV = new Map();

/** (n × n) tangents of the C² cubic spline through n even samples (feed._derivative). */
function derivative(n, periodic) {
  const key = `${n}:${periodic}`;
  if (DERIV.has(key)) return DERIV.get(key);
  let d;
  if (n < 4) {
    const few = [[[0]], [[-1, 1], [-1, 1]], [[-1.5, 2, -0.5], [-0.5, 0, 0.5], [0.5, -2, 1.5]]];
    d = few[n - 1];
  } else {
    const k = periodic ? n - 1 : n;
    const A = Array.from({ length: k }, () => new Float64Array(k)), B = Array.from({ length: k }, () => new Float64Array(k));
    for (let i = 0; i < k; i++) {
      A[i][i] = 4; A[i][(i - 1 + k) % k] = 1; A[i][(i + 1) % k] = 1;
      B[i][(i + 1) % k] = 3; B[i][(i - 1 + k) % k] = -3;
    }
    if (!periodic) {
      A[0].fill(0); B[0].fill(0); A[k - 1].fill(0); B[k - 1].fill(0);
      A[0][0] = 1; A[0][2] = -1; B[0][0] = -2; B[0][1] = 4; B[0][2] = -2;
      A[k - 1][k - 3] = -1; A[k - 1][k - 1] = 1; B[k - 1][k - 3] = 2; B[k - 1][k - 2] = -4; B[k - 1][k - 1] = 2;
    }
    const X = solve(A, B, k);
    if (periodic) {
      d = Array.from({ length: n }, (_, i) => { const row = new Float64Array(n); row.set(X[i % k]); return row; });
    } else d = X;
  }
  DERIV.set(key, d);
  return d;
}

function solve(A, B, k) {
  // Gaussian elimination with partial pivoting, k right-hand sides
  A = A.map((r) => Float64Array.from(r)); B = B.map((r) => Float64Array.from(r));
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [B[c], B[p]] = [B[p], B[c]];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      if (f === 0) continue;
      for (let j = c; j < k; j++) A[r][j] -= f * A[c][j];
      for (let j = 0; j < k; j++) B[r][j] -= f * B[c][j];
    }
  }
  return B.map((row, i) => row.map((x) => x / A[i][i]));
}

const LAYOUT = new Map();
function faceLayout(m) {
  if (LAYOUT.has(m)) return LAYOUT.get(m);
  const loop = [];
  for (let p = 0; p < m; p++) loop.push([p, 0]);
  for (let q = 0; q < m; q++) loop.push([m, q]);
  for (let p = m; p > 0; p--) loop.push([p, m]);
  for (let q = m; q >= 0; q--) loop.push([0, q]);
  const order = loop.slice();
  for (let p = 1; p < m; p++) for (let q = 1; q < m; q++) order.push([p, q]);
  const index = new Int32Array((m + 1) * (m + 1));
  order.forEach(([p, q], i) => { if (i !== 4 * m) index[p * (m + 1) + q] = i; });
  const tris = [];
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) {
    const a = i * (m + 1) + j, b = a + 1, c = a + (m + 1), d = c + 1;
    tris.push(index[a], index[c], index[d], index[a], index[d], index[b]); // geometry.grid_triangles' order
  }
  const out = { order, triangles: Int32Array.from(tris) };
  LAYOUT.set(m, out);
  return out;
}

function hermite(x) {
  const x2 = x * x, x3 = x2 * x;
  return [[2 * x3 - 3 * x2 + 1, 3 * x2 - 2 * x3, x3 - 2 * x2 + x, x3 - x2], [6 * x2 - 6 * x, 6 * x - 6 * x2, 3 * x2 - 4 * x + 1, 3 * x2 - 2 * x]];
}

/** The refined mesh of faces [first, end) of a (u+1) × (v+1) grid (points xyz, uvs). */
export function refine(g, uvg, u, v, m, first, end) {
  const nu = u + 1, nv = v + 1, D = 5; // dims: x y z (+ u v)
  const G = new Float64Array(nu * nv * D);
  for (let i = 0; i < nu * nv; i++) { G.set(g.subarray(3 * i, 3 * i + 3), D * i); G.set(uvg.subarray(2 * i, 2 * i + 2), D * i + 3); }
  const at = (i, j, d) => G[(i * nv + j) * D + d];
  const scale = 1 + Math.max(...g.map(Math.abs));
  const tol = 1e-7 * scale;
  const close = (pairs) => pairs.every(([a, b]) => Math.abs(a - b) <= tol);
  let pu = true, pv = true;
  for (let j = 0; j < nv && pu; j++) for (let d = 0; d < 3; d++) if (Math.abs(at(0, j, d) - at(u, j, d)) > tol) { pu = false; break; }
  for (let i = 0; i < nu && pv; i++) for (let d = 0; d < 3; d++) if (Math.abs(at(i, 0, d) - at(i, v, d)) > tol) { pv = false; break; }
  const du = derivative(nu, pu), dv = derivative(nv, pv);
  const GU = new Float64Array(G.length), GV = new Float64Array(G.length), GUV = new Float64Array(G.length);
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) for (let d = 0; d < D; d++) {
    let su = 0, sv = 0;
    for (let k = 0; k < nu; k++) su += du[i][k] * at(k, j, d);
    for (let k = 0; k < nv; k++) sv += dv[j][k] * at(i, k, d);
    GU[(i * nv + j) * D + d] = su; GV[(i * nv + j) * D + d] = sv;
  }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) for (let d = 0; d < D; d++) {
    let s = 0;
    for (let k = 0; k < nv; k++) s += dv[j][k] * GU[(i * nv + k) * D + d];
    GUV[(i * nv + j) * D + d] = s;
  }
  const data = [[G, GV], [GU, GUV]];
  const { order, triangles } = faceLayout(m);
  const block = order.length, faces = end - first;
  const points = new Float32Array(faces * block * 3), uvs = new Float32Array(faces * block * 2), normals = new Float32Array(faces * block * 3);
  const xs = Array.from({ length: m + 1 }, (_, k) => k / m);
  const thin = 1e-10 * scale * scale;
  // per face: its 4×4 Hermite data, then its lattice points
  for (let f = first; f < end; f++) {
    const fu = Math.floor(f / v), fv = f % v;
    const cell = (a, b, d) => { // a, b ∈ 0..3: [value at 0, 1; derivative at 0, 1]
      const arr = data[a >> 1][b >> 1];
      return arr[((fu + (a & 1)) * nv + (fv + (b & 1))) * D + d];
    };
    const evalAt = (s, t, out) => {
      const [hs, dhs] = hermite(s), [ht, dht] = hermite(t);
      for (let d = 0; d < D; d++) {
        let p = 0, ps = 0, pt = 0;
        for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
          const c = cell(a, b, d);
          p += hs[a] * ht[b] * c; ps += dhs[a] * ht[b] * c; pt += hs[a] * dht[b] * c;
        }
        out[0][d] = p; out[1][d] = ps; out[2][d] = pt;
      }
    };
    const tmp = [new Float64Array(D), new Float64Array(D), new Float64Array(D)];
    order.forEach(([p, q], k) => {
      evalAt(xs[p], xs[q], tmp);
      const [P, S, T] = tmp;
      let n = [S[1] * T[2] - S[2] * T[1], S[2] * T[0] - S[0] * T[2], S[0] * T[1] - S[1] * T[0]];
      if (Math.hypot(...n) <= thin) { // ManimGX's pole rule: the normal a hair inside the face
        evalAt(1e-3 + (1 - 2e-3) * xs[p], 1e-3 + (1 - 2e-3) * xs[q], tmp);
        const [, S2, T2] = tmp;
        n = [S2[1] * T2[2] - S2[2] * T2[1], S2[2] * T2[0] - S2[0] * T2[2], S2[0] * T2[1] - S2[1] * T2[0]];
        evalAt(xs[p], xs[q], tmp);
      }
      const o = (f - first) * block + k;
      points[3 * o] = tmp[0][0]; points[3 * o + 1] = tmp[0][1]; points[3 * o + 2] = tmp[0][2];
      uvs[2 * o] = tmp[0][3]; uvs[2 * o + 1] = tmp[0][4];
      normals.set(n, 3 * o);
    });
  }
  const tri = new Uint32Array(faces * triangles.length);
  for (let f = 0; f < faces; f++) for (let k = 0; k < triangles.length; k++) tri[f * triangles.length + k] = triangles[k] + f * block;
  return { points, uvs, normals, triangles: tri, block };
}
