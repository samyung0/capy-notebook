/**
 * A drawn film keeps a surface as its grid of samples; the player draws the
 * mesh ManimGX refines from it (manimgx.rendering.feed.refine_surface): each
 * face a bicubic Hermite patch through C² spline tangents, sampled on an
 * m × m lattice, with the face's normals.
 */

type Matrix = Float64Array<ArrayBufferLike>[];

const DERIVATIVES = new Map<string, Matrix>();

/** The (n × n) tangents of the C² cubic spline through n even samples. */
function derivative(n: number, periodic: boolean): Matrix {
  const key = `${n}:${periodic}`;
  const known = DERIVATIVES.get(key);
  if (known) return known;
  let d: Matrix;
  if (n < 4) {
    const few = [
      [[0]],
      [
        [-1, 1],
        [-1, 1],
      ],
      [
        [-1.5, 2, -0.5],
        [-0.5, 0, 0.5],
        [0.5, -2, 1.5],
      ],
    ][n - 1];
    d = (few ?? [[0]]).map((row) => Float64Array.from(row));
  } else {
    const k = periodic ? n - 1 : n;
    const a = Array.from({ length: k }, () => new Float64Array(k));
    const b = Array.from({ length: k }, () => new Float64Array(k));
    for (let i = 0; i < k; i++) {
      const row = a[i] as Float64Array;
      const rhs = b[i] as Float64Array;
      row[i] = 4;
      row[(i - 1 + k) % k] = 1;
      row[(i + 1) % k] = 1;
      rhs[(i + 1) % k] = 3;
      rhs[(i - 1 + k) % k] = -3;
    }
    if (!periodic) {
      const [a0, b0, aK, bK] = [
        a[0],
        b[0],
        a[k - 1],
        b[k - 1],
      ] as Float64Array[];
      for (const row of [a0, b0, aK, bK]) row?.fill(0);
      if (a0 && b0 && aK && bK) {
        a0[0] = 1;
        a0[2] = -1;
        b0[0] = -2;
        b0[1] = 4;
        b0[2] = -2;
        aK[k - 3] = -1;
        aK[k - 1] = 1;
        bK[k - 3] = 2;
        bK[k - 2] = -4;
        bK[k - 1] = 2;
      }
    }
    const x = solve(a, b, k);
    d = periodic
      ? Array.from({ length: n }, (_, i) => {
          const row = new Float64Array(n);
          row.set(x[i % k] as Float64Array);
          return row;
        })
      : x;
  }
  DERIVATIVES.set(key, d);
  return d;
}

/** Gauss-Jordan elimination with partial pivoting, k right-hand sides. */
function solve(aIn: Matrix, bIn: Matrix, k: number): Matrix {
  const a: Matrix = aIn.map((r) => Float64Array.from(r));
  const b: Matrix = bIn.map((r) => Float64Array.from(r));
  const at = (m: Matrix, i: number) => m[i] as Float64Array;
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++)
      if (Math.abs(at(a, r)[c] ?? 0) > Math.abs(at(a, p)[c] ?? 0)) p = r;
    [a[c], a[p]] = [at(a, p), at(a, c)];
    [b[c], b[p]] = [at(b, p), at(b, c)];
    const pivot = at(a, c);
    const pivotB = at(b, c);
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const row = at(a, r);
      const rowB = at(b, r);
      const f = (row[c] ?? 0) / (pivot[c] ?? 1);
      if (f === 0) continue;
      for (let j = c; j < k; j++) row[j] = (row[j] ?? 0) - f * (pivot[j] ?? 0);
      for (let j = 0; j < k; j++)
        rowB[j] = (rowB[j] ?? 0) - f * (pivotB[j] ?? 0);
    }
  }
  return b.map((row, i) => row.map((x) => x / (at(a, i)[i] ?? 1)));
}

const LAYOUTS = new Map<
  number,
  { order: [number, number][]; triangles: Int32Array }
>();

/** A face's lattice points (its outline loop first) and triangles. */
function faceLayout(m: number) {
  const known = LAYOUTS.get(m);
  if (known) return known;
  const loop: [number, number][] = [];
  for (let p = 0; p < m; p++) loop.push([p, 0]);
  for (let q = 0; q < m; q++) loop.push([m, q]);
  for (let p = m; p > 0; p--) loop.push([p, m]);
  for (let q = m; q >= 0; q--) loop.push([0, q]);
  const order = loop.slice();
  for (let p = 1; p < m; p++) for (let q = 1; q < m; q++) order.push([p, q]);
  const index = new Int32Array((m + 1) * (m + 1));
  order.forEach(([p, q], i) => {
    if (i !== 4 * m) index[p * (m + 1) + q] = i;
  });
  const tris: number[] = [];
  for (let i = 0; i < m; i++)
    for (let j = 0; j < m; j++) {
      const a = i * (m + 1) + j;
      const b = a + 1;
      const c = a + (m + 1);
      const d = c + 1;
      // geometry.grid_triangles' order
      tris.push(
        index[a] ?? 0,
        index[c] ?? 0,
        index[d] ?? 0,
        index[a] ?? 0,
        index[d] ?? 0,
        index[b] ?? 0
      );
    }
  const out = { order, triangles: Int32Array.from(tris) };
  LAYOUTS.set(m, out);
  return out;
}

function hermite(x: number): [number[], number[]] {
  const x2 = x * x;
  const x3 = x2 * x;
  return [
    [2 * x3 - 3 * x2 + 1, 3 * x2 - 2 * x3, x3 - 2 * x2 + x, x3 - x2],
    [6 * x2 - 6 * x, 6 * x - 6 * x2, 3 * x2 - 4 * x + 1, 3 * x2 - 2 * x],
  ];
}

const DIMS = 5; // x y z u v

/** The refined mesh of faces [first, end) of a (u+1) × (v+1) grid of points
 * (xyz) and uvs. */
export function refine(
  g: Float64Array,
  uvg: Float64Array,
  u: number,
  v: number,
  m: number,
  first: number,
  end: number
) {
  const nu = u + 1;
  const nv = v + 1;
  const grid = new Float64Array(nu * nv * DIMS);
  for (let i = 0; i < nu * nv; i++) {
    grid.set(g.subarray(3 * i, 3 * i + 3), DIMS * i);
    grid.set(uvg.subarray(2 * i, 2 * i + 2), DIMS * i + 3);
  }
  const at = (i: number, j: number, d: number) =>
    grid[(i * nv + j) * DIMS + d] ?? 0;
  let largest = 0;
  for (const x of g) largest = Math.max(largest, Math.abs(x));
  const scale = 1 + largest;
  const tol = 1e-7 * scale;
  let pu = true;
  let pv = true;
  for (let j = 0; j < nv && pu; j++)
    for (let d = 0; d < 3; d++)
      if (Math.abs(at(0, j, d) - at(u, j, d)) > tol) {
        pu = false;
        break;
      }
  for (let i = 0; i < nu && pv; i++)
    for (let d = 0; d < 3; d++)
      if (Math.abs(at(i, 0, d) - at(i, v, d)) > tol) {
        pv = false;
        break;
      }
  const du = derivative(nu, pu);
  const dv = derivative(nv, pv);
  const gu = new Float64Array(grid.length);
  const gv = new Float64Array(grid.length);
  const guv = new Float64Array(grid.length);
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++)
      for (let d = 0; d < DIMS; d++) {
        let su = 0;
        let sv = 0;
        const rowU = du[i] as Float64Array;
        const rowV = dv[j] as Float64Array;
        for (let k = 0; k < nu; k++) su += (rowU[k] ?? 0) * at(k, j, d);
        for (let k = 0; k < nv; k++) sv += (rowV[k] ?? 0) * at(i, k, d);
        gu[(i * nv + j) * DIMS + d] = su;
        gv[(i * nv + j) * DIMS + d] = sv;
      }
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++)
      for (let d = 0; d < DIMS; d++) {
        let s = 0;
        const rowV = dv[j] as Float64Array;
        for (let k = 0; k < nv; k++)
          s += (rowV[k] ?? 0) * (gu[(i * nv + k) * DIMS + d] ?? 0);
        guv[(i * nv + j) * DIMS + d] = s;
      }
  const data = [
    [grid, gv],
    [gu, guv],
  ] as const;
  const { order, triangles } = faceLayout(m);
  const block = order.length;
  const faces = end - first;
  const points = new Float32Array(faces * block * 3);
  const uvs = new Float32Array(faces * block * 2);
  const normals = new Float32Array(faces * block * 3);
  const xs = Array.from({ length: m + 1 }, (_, k) => k / m);
  const thin = 1e-10 * scale * scale;
  const value = [
    new Float64Array(DIMS),
    new Float64Array(DIMS),
    new Float64Array(DIMS),
  ] as const;
  const cross = (s: Float64Array, t: Float64Array) => [
    (s[1] ?? 0) * (t[2] ?? 0) - (s[2] ?? 0) * (t[1] ?? 0),
    (s[2] ?? 0) * (t[0] ?? 0) - (s[0] ?? 0) * (t[2] ?? 0),
    (s[0] ?? 0) * (t[1] ?? 0) - (s[1] ?? 0) * (t[0] ?? 0),
  ];
  for (let f = first; f < end; f++) {
    const fu = Math.floor(f / v);
    const fv = f % v;
    // a, b ∈ 0..3: the values at 0 and 1, then the derivatives at 0 and 1
    const cell = (a: number, b: number, d: number) =>
      data[a >> 1][b >> 1][((fu + (a & 1)) * nv + (fv + (b & 1))) * DIMS + d] ??
      0;
    const evalAt = (s: number, t: number) => {
      const [hs, dhs] = hermite(s);
      const [ht, dht] = hermite(t);
      for (let d = 0; d < DIMS; d++) {
        let p = 0;
        let ps = 0;
        let pt = 0;
        for (let a = 0; a < 4; a++)
          for (let b = 0; b < 4; b++) {
            const c = cell(a, b, d);
            p += (hs[a] ?? 0) * (ht[b] ?? 0) * c;
            ps += (dhs[a] ?? 0) * (ht[b] ?? 0) * c;
            pt += (hs[a] ?? 0) * (dht[b] ?? 0) * c;
          }
        value[0][d] = p;
        value[1][d] = ps;
        value[2][d] = pt;
      }
    };
    order.forEach(([p, q], k) => {
      const s = xs[p] ?? 0;
      const t = xs[q] ?? 0;
      evalAt(s, t);
      let n = cross(value[1], value[2]);
      if (Math.hypot(...n) <= thin) {
        // ManimGX's pole rule: the normal a hair inside the face
        evalAt(1e-3 + (1 - 2e-3) * s, 1e-3 + (1 - 2e-3) * t);
        n = cross(value[1], value[2]);
        evalAt(s, t);
      }
      const o = (f - first) * block + k;
      points[3 * o] = value[0][0] ?? 0;
      points[3 * o + 1] = value[0][1] ?? 0;
      points[3 * o + 2] = value[0][2] ?? 0;
      uvs[2 * o] = value[0][3] ?? 0;
      uvs[2 * o + 1] = value[0][4] ?? 0;
      normals.set(n, 3 * o);
    });
  }
  const tri = new Uint32Array(faces * triangles.length);
  for (let f = 0; f < faces; f++)
    for (let k = 0; k < triangles.length; k++)
      tri[f * triangles.length + k] = (triangles[k] ?? 0) + f * block;
  return { block, normals, points, triangles: tri, uvs };
}
