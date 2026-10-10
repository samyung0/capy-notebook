/**
 * Map elements drawn as SVG markup. Most are drawn once at the origin as
 * templates (see TEMPLATES in map.ts); water, bridges, the signpost and the
 * flag are drawn in place.
 */
import {
  catmull,
  escapeText,
  fill,
  hatch,
  line,
  n,
  type Pt,
  polyD,
  type Rng,
  sketch,
} from './sketch';

const TAU = Math.PI * 2;

export function pine(x: number, y: number, h: number, rng: Rng) {
  let s = line(
    rng,
    [
      [x - 1.2, y],
      [x - 1, y - h * 0.22],
    ],
    'ink',
    0.15
  );
  s += line(
    rng,
    [
      [x + 1.2, y],
      [x + 1, y - h * 0.22],
    ],
    'ink',
    0.15
  );
  for (const [w, top, base] of [
    [0.5, 0.64, 0.18],
    [0.4, 0.84, 0.42],
    [0.28, 1, 0.64],
  ]) {
    const ty = y - h * top;
    const by = y - h * base;
    const hw = h * w;
    s += sketch(
      [
        [x, ty],
        [x - hw * 0.55, by - h * 0.12],
        [x - hw, by],
      ],
      rng,
      'ink',
      { amp: 0.3, passes: 1 }
    );
    s += sketch(
      [
        [x, ty],
        [x + hw * 0.55, by - h * 0.12],
        [x + hw, by],
      ],
      rng,
      'ink',
      { amp: 0.3, passes: 1 }
    );
    const saw: Pt[] = [];
    for (let i = 0; i <= 5; i++)
      saw.push([x - hw + (2 * hw * i) / 5, by + (i % 2 ? 2.2 : 0)]);
    s += line(rng, saw, 'ink', 0.2);
    s += hatch(
      [
        [x, ty],
        [x + hw, by],
        [x + 1, by],
      ],
      rng,
      112,
      2.6,
      'ink-hatch',
      0.9
    );
  }
  return s;
}

export function roundTree(x: number, y: number, h: number, rng: Rng) {
  let s = line(
    rng,
    [
      [x - 2, y],
      [x - 1.5, y - h * 0.45],
    ],
    'ink',
    0.2
  );
  s += line(
    rng,
    [
      [x + 2, y],
      [x + 1.5, y - h * 0.45],
    ],
    'ink',
    0.2
  );
  s += line(
    rng,
    [
      [x, y - h * 0.38],
      [x + h * 0.14, y - h * 0.55],
    ],
    'ink',
    0.2
  );
  const cx = x;
  const cy = y - h * 0.68;
  const r = h * 0.34;
  const ring: Pt[] = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * TAU;
    const rr = r * (1 + 0.1 * Math.abs(Math.sin(a * 4.5)));
    ring.push([cx + rr * Math.cos(a) * 1.08, cy + rr * Math.sin(a) * 0.92]);
  }
  s += `<path class="tm-leaf" d="${polyD(ring)}Z"/>`;
  s += sketch(ring, rng, 'ink', { amp: 0.5, passes: 1 });
  for (const [dx, dy] of [
    [-0.35, -0.2],
    [0.25, -0.35],
    [0.1, 0.15],
  ])
    s += `<path class="tm-ink-soft" d="M${n(cx + dx * r)} ${n(cy + dy * r)} q3 -4 6 0 q-2 3 -5 1"/>`;
  s += hatch(
    [
      [cx + r * 0.2, cy + r * 0.1],
      [cx + r, cy],
      [cx + r * 0.6, cy + r * 0.8],
      [cx, cy + r * 0.9],
    ],
    rng,
    125,
    2.8,
    'ink-hatch',
    0.85
  );
  return s;
}

export function bush(x: number, y: number, w: number, rng: Rng) {
  const pts: Pt[] = [[x - w / 2, y]];
  for (let i = 1; i < 8; i++) {
    const t = i / 8;
    pts.push([
      x - w / 2 + w * t,
      y - w * 0.32 * Math.sin(Math.PI * t) - (i % 2 ? 2 : 0),
    ]);
  }
  pts.push([x + w / 2, y]);
  return (
    `<path class="tm-leaf" d="${polyD(pts)}Z"/>` +
    sketch(pts, rng, 'ink', { amp: 0.4, passes: 1 }) +
    hatch(
      [
        [x, y - w * 0.3],
        [x + w / 2, y],
        [x, y],
      ],
      rng,
      120,
      2.6,
      'ink-hatch',
      0.9
    )
  );
}

export const tuft = (x: number, y: number, rng: Rng) =>
  line(
    rng,
    [
      [x - 5, y - 6],
      [x - 1, y],
      [x, y - 9],
      [x + 2, y],
      [x + 6, y - 5],
    ],
    'ink-soft',
    0.2
  );

export const flower = (x: number, y: number, rng: Rng) =>
  line(
    rng,
    [
      [x, y],
      [x + 0.5, y - 9],
    ],
    'ink-soft',
    0.2
  ) + `<circle class="tm-petal" cx="${n(x + 0.5)}" cy="${n(y - 11)}" r="2.6"/>`;

export function rock(x: number, y: number, w: number, rng: Rng) {
  const pts: Pt[] = [
    [x, y],
    [x + w * 0.15, y - w * 0.35],
    [x + w * 0.45, y - w * 0.5],
    [x + w * 0.8, y - w * 0.38],
    [x + w, y],
  ];
  return (
    `<path class="tm-stone" d="${polyD(pts)}Z"/>` +
    sketch(pts, rng, 'ink', { amp: 0.3, passes: 1 }) +
    line(
      rng,
      [
        [x, y],
        [x + w, y],
      ],
      'ink-soft',
      0.3
    ) +
    hatch(
      [
        [x + w * 0.5, y - w * 0.48],
        [x + w * 0.8, y - w * 0.38],
        [x + w, y],
        [x + w * 0.55, y],
      ],
      rng,
      120,
      2.4,
      'ink-hatch',
      0.95
    ) +
    line(
      rng,
      [
        [x + w * 0.42, y - w * 0.3],
        [x + w * 0.5, y - w * 0.15],
      ],
      'ink-soft',
      0.1
    )
  );
}

export function pebbles(x: number, y: number, rng: Rng) {
  let s = '';
  for (let i = 0; i < 4; i++) {
    const px = x + rng.uniform(-10, 10);
    const py = y + rng.uniform(-3, 3);
    s += `<ellipse class="tm-ink-soft" cx="${n(px)}" cy="${n(py)}" rx="${n(rng.uniform(1.5, 3))}" ry="${n(rng.uniform(1, 1.8))}"/>`;
  }
  return s;
}

export const bird = (x: number, y: number) =>
  `<path class="tm-ink-soft" d="M${n(x)} ${n(y)} q4 -4 7 0 q3 -4 7 0"/>`;

export function mushroom(x: number, y: number, rng: Rng) {
  const cap = `d="M${n(x - 5)} ${n(y - 5)} q5 -7 10 0 z"`;
  return (
    line(
      rng,
      [
        [x - 1, y],
        [x - 1, y - 5],
      ],
      'ink',
      0.1
    ) +
    line(
      rng,
      [
        [x + 1, y],
        [x + 1, y - 5],
      ],
      'ink',
      0.1
    ) +
    `<path class="tm-cap" ${cap}/><path class="tm-ink" ${cap}/>`
  );
}

export function reeds(x: number, y: number, rng: Rng) {
  let s = '';
  for (let i = 0; i < 3; i++) {
    const px = x + i * 4;
    const top = y - 14 - (i % 2) * 5;
    s += line(
      rng,
      [
        [px, y],
        [px + (i - 1) * 1.5, top],
      ],
      'ink',
      0.2
    );
    s += `<ellipse class="tm-reedhead" cx="${n(px + (i - 1) * 1.5)}" cy="${n(top + 2)}" rx="1.6" ry="3.6"/>`;
  }
  return (
    s +
    line(
      rng,
      [
        [x - 3, y],
        [x - 8, y - 9],
      ],
      'ink-soft',
      0.2
    )
  );
}

// ---------- structures ----------

export function tent(x: number, y: number, w: number, rng: Rng) {
  const h = w * 0.72;
  const apex: Pt = [x, y - h];
  let s = fill([[x - w / 2, y], apex, [x + w / 2, y]], 'canvas', rng);
  s += sketch([[x - w / 2, y], apex, [x + w / 2, y]], rng, 'ink', {
    amp: 0.4,
    smooth: false,
  });
  s += fill(
    [
      [x - w * 0.13, y],
      [x, y - h * 0.62],
      [x + w * 0.13, y],
    ],
    'door',
    rng,
    0.2
  );
  s += line(
    rng,
    [
      [x, y - h * 0.62],
      [x - w * 0.13, y],
    ],
    'ink',
    0.2
  );
  s += line(
    rng,
    [
      [x, y - h * 0.62],
      [x + w * 0.13, y],
    ],
    'ink',
    0.2
  );
  s += hatch(
    [apex, [x + w / 2, y], [x + w * 0.14, y]],
    rng,
    112,
    2.8,
    'ink-hatch',
    0.9
  );
  s += line(rng, [apex, [x - 4, y - h - 6]], 'ink', 0.2);
  for (const side of [-1, 1]) {
    const px = x + side * (w / 2 + 12);
    s += line(
      rng,
      [
        [x + side * w * 0.3, y - h * 0.55],
        [px, y],
      ],
      'ink-soft',
      0.2
    );
    s += line(
      rng,
      [
        [px, y + 1],
        [px + side * 1.5, y - 4],
      ],
      'ink',
      0.1
    );
  }
  return (
    s +
    line(
      rng,
      [
        [x - w / 2 - 16, y + 1],
        [x + w / 2 + 16, y + 1],
      ],
      'ink-soft',
      0.4
    )
  );
}

export function campfire(x: number, y: number, rng: Rng) {
  let s = '';
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * TAU;
    const at = `cx="${n(x + 11 * Math.cos(a))}" cy="${n(y + 3.6 * Math.sin(a))}" rx="2.6" ry="1.8"`;
    s += `<ellipse class="tm-stone" ${at}/><ellipse class="tm-ink-thin" ${at}/>`;
  }
  s += line(
    rng,
    [
      [x - 8, y + 1],
      [x + 7, y - 5],
    ],
    'ink',
    0.15
  );
  s += line(
    rng,
    [
      [x - 8, y - 3],
      [x + 7, y + 2],
    ],
    'ink',
    0.15
  );
  s += `<path class="tm-flame" d="M${n(x)} ${n(y - 3)} c-7 -5 -3 -12 -1 -19 c2 6 8 8 6 14 c-1 3 -3 5 -5 5z"/>`;
  s += `<path class="tm-flame-in" d="M${n(x)} ${n(y - 4)} c-3 -3 -1 -7 0 -10 c1 4 4 5 3 8 c-1 1 -2 2 -3 2z"/>`;
  s += `<path class="tm-ink-soft" d="M${n(x + 2)} ${n(y - 26)} c-4 -4 4 -6 0 -10 c-4 -4 4 -6 0 -10"/>`;
  // a log to sit on
  const lx = x + 10;
  const ly = y + 9;
  s += `<path class="tm-wood" d="M${n(lx)} ${n(ly - 5)} ${n(lx + 16)} ${n(ly - 5)} ${n(lx + 16)} ${n(ly)} ${n(lx)} ${n(ly)}Z"/>`;
  s += line(
    rng,
    [
      [lx, ly - 5],
      [lx + 16, ly - 5],
    ],
    'ink',
    0.2
  );
  s += line(
    rng,
    [
      [lx, ly],
      [lx + 16, ly],
    ],
    'ink',
    0.2
  );
  return (
    s +
    `<ellipse class="tm-ink" cx="${n(lx + 16)}" cy="${n(ly - 2.5)}" rx="2" ry="2.7"/>`
  );
}

export function cabin(x: number, y: number, w: number, rng: Rng) {
  const h = w * 0.55;
  const body: Pt[] = [
    [x, y],
    [x, y - h],
    [x + w, y - h],
    [x + w, y],
  ];
  let s = fill(body, 'wood', rng);
  s += sketch(body, rng, 'ink', { amp: 0.3, smooth: false });
  for (let k = 1; k < 4; k++)
    s += line(
      rng,
      [
        [x + 1, y - (h * k) / 4],
        [x + w - 1, y - (h * k) / 4],
      ],
      'ink-soft',
      0.3
    );
  const roof: Pt[] = [
    [x - 6, y - h],
    [x + w * 0.5, y - h - w * 0.42],
    [x + w + 6, y - h],
  ];
  s += fill(roof, 'roof', rng);
  s += sketch([...roof, roof[0]], rng, 'ink', { amp: 0.3, smooth: false });
  s += hatch(roof, rng, 20, 3.4, 'ink-hatch', 0.8);
  const door: Pt[] = [
    [x + w * 0.14, y],
    [x + w * 0.14, y - h * 0.7],
    [x + w * 0.36, y - h * 0.7],
    [x + w * 0.36, y],
  ];
  s += fill(door, 'door', rng, 0.2) + line(rng, door, 'ink', 0.2);
  const wx = x + w * 0.58;
  const wy = y - h * 0.72;
  const ww = w * 0.26;
  s += `<rect class="tm-window" x="${n(wx)}" y="${n(wy)}" width="${n(ww)}" height="${n(ww * 0.8)}"/>`;
  s += line(
    rng,
    [
      [wx, wy],
      [wx + ww, wy],
      [wx + ww, wy + ww * 0.8],
      [wx, wy + ww * 0.8],
      [wx, wy],
    ],
    'ink',
    0.2
  );
  s += line(
    rng,
    [
      [wx + ww / 2, wy],
      [wx + ww / 2, wy + ww * 0.8],
    ],
    'ink',
    0.1
  );
  s += line(
    rng,
    [
      [wx, wy + ww * 0.4],
      [wx + ww, wy + ww * 0.4],
    ],
    'ink',
    0.1
  );
  const cx = x + w * 0.74;
  const chimney: Pt[] = [
    [cx, y - h - w * 0.14],
    [cx, y - h - w * 0.32],
    [cx + 6, y - h - w * 0.32],
    [cx + 6, y - h - w * 0.1],
  ];
  s += fill(chimney, 'wood', rng, 0.2) + line(rng, chimney, 'ink', 0.2);
  return (
    s +
    `<path class="tm-ink-soft" d="M${n(cx + 3)} ${n(y - h - w * 0.32 - 3)} c-5 -4 5 -7 0 -11 c-5 -4 6 -7 1 -12"/>`
  );
}

export function fence(x0: number, x1: number, y: number, rng: Rng) {
  let s = '';
  for (let i = 0; i < 4; i++) {
    const px = x0 + ((x1 - x0) * i) / 3;
    s += line(
      rng,
      [
        [px, y + 2],
        [px, y - 16],
      ],
      'ink',
      0.2
    );
    s += `<path class="tm-ink" d="M${n(px - 1.5)} ${n(y - 16)} l1.5 -2 l1.5 2"/>`;
  }
  return (
    s +
    line(
      rng,
      [
        [x0 - 3, y - 12],
        [x1 + 3, y - 12.5],
      ],
      'ink',
      0.4
    ) +
    line(
      rng,
      [
        [x0 - 3, y - 5],
        [x1 + 3, y - 5],
      ],
      'ink',
      0.4
    )
  );
}

export function boat(x: number, y: number, w: number, rng: Rng) {
  const hull: Pt[] = [
    [x, y - 5],
    [x + w, y - 5],
    [x + w * 0.82, y],
    [x + w * 0.14, y],
  ];
  const sail: Pt[] = [
    [x + w * 0.52, y - 21],
    [x + w * 0.52, y - 7],
    [x + w * 0.9, y - 7],
  ];
  return (
    fill(hull, 'wood', rng, 0.2) +
    sketch([...hull, hull[0]], rng, 'ink', {
      amp: 0.2,
      passes: 1,
      smooth: false,
    }) +
    line(
      rng,
      [
        [x + w * 0.5, y - 5],
        [x + w * 0.5, y - 22],
      ],
      'ink',
      0.15
    ) +
    fill(sail, 'canvas', rng, 0.2) +
    line(rng, [sail[0], sail[2], sail[1]], 'ink', 0.2)
  );
}

export function windmill(x: number, y: number, h: number, rng: Rng) {
  const w0 = h * 0.22;
  const w1 = h * 0.13;
  const tower: Pt[] = [
    [x - w0, y],
    [x - w1, y - h * 0.7],
    [x + w1, y - h * 0.7],
    [x + w0, y],
  ];
  let s = fill(tower, 'wood', rng, 0.3);
  s += sketch(tower, rng, 'ink', { amp: 0.3, smooth: false });
  s += hatch(
    [
      [x, y - h * 0.7],
      [x + w1, y - h * 0.7],
      [x + w0, y],
      [x + 1, y],
    ],
    rng,
    112,
    2.8,
    'ink-hatch',
    0.9
  );
  const cap: Pt[] = [
    [x - w1 - 3, y - h * 0.7],
    [x, y - h * 0.84],
    [x + w1 + 3, y - h * 0.7],
  ];
  s +=
    fill(cap, 'roof', rng, 0.2) +
    sketch([...cap, cap[0]], rng, 'ink', {
      amp: 0.2,
      passes: 1,
      smooth: false,
    });
  s += fill(
    [
      [x - 3, y],
      [x - 3, y - 9],
      [x + 3, y - 9],
      [x + 3, y],
    ],
    'door',
    rng,
    0.1
  );
  const hx = x;
  const hy = y - h * 0.72;
  for (let k = 0; k < 4; k++) {
    const a = 0.35 + (k * Math.PI) / 2;
    const ex = hx + h * 0.52 * Math.cos(a);
    const ey = hy + h * 0.52 * Math.sin(a);
    const nx = -Math.sin(a) * 4;
    const ny = Math.cos(a) * 4;
    const root: Pt = [hx + (ex - hx) * 0.2, hy + (ey - hy) * 0.2];
    const blade: Pt[] = [
      root,
      [ex, ey],
      [ex + nx, ey + ny],
      [root[0] + nx, root[1] + ny],
    ];
    s += fill(blade, 'canvas');
    s += line(
      rng,
      [
        [hx, hy],
        [ex, ey],
      ],
      'ink',
      0.2
    );
    s += line(rng, blade.slice(1), 'ink-soft', 0.15);
    for (const t of [0.45, 0.7])
      s += `<path class="tm-ink-soft" d="M${n(hx + (ex - hx) * t)} ${n(hy + (ey - hy) * t)} l${n(nx)} ${n(ny)}"/>`;
  }
  return s + `<circle class="tm-ink" cx="${n(hx)}" cy="${n(hy)}" r="2"/>`;
}

export function well(x: number, y: number, rng: Rng) {
  let s = fill(
    [
      [x - 11, y],
      [x - 11, y - 10],
      [x + 11, y - 10],
      [x + 11, y],
    ],
    'stone',
    rng,
    0.2
  );
  s +=
    line(
      rng,
      [
        [x - 11, y],
        [x - 11, y - 10],
      ],
      'ink',
      0.2
    ) +
    line(
      rng,
      [
        [x + 11, y],
        [x + 11, y - 10],
      ],
      'ink',
      0.2
    );
  s += `<ellipse class="tm-ink" cx="${n(x)}" cy="${n(y - 10)}" rx="11" ry="3"/>`;
  s += `<path class="tm-ink" d="M${n(x - 11)} ${n(y)} q11 4 22 0"/>`;
  for (const [ax, ay, bx, by] of [
    [-11, -5, -4, -5],
    [2, -5, 11, -5],
    [-6, -1, 5, -1],
  ])
    s += `<path class="tm-ink-soft" d="M${n(x + ax)} ${n(y + ay)} ${n(x + bx)} ${n(y + by)}"/>`;
  s +=
    line(
      rng,
      [
        [x - 10, y - 10],
        [x - 10, y - 30],
      ],
      'ink',
      0.15
    ) +
    line(
      rng,
      [
        [x + 10, y - 10],
        [x + 10, y - 30],
      ],
      'ink',
      0.15
    );
  const roof: Pt[] = [
    [x - 15, y - 28],
    [x, y - 38],
    [x + 15, y - 28],
  ];
  s +=
    fill(roof, 'roof', rng, 0.2) +
    sketch([...roof, roof[0]], rng, 'ink', {
      amp: 0.2,
      passes: 1,
      smooth: false,
    });
  s += line(
    rng,
    [
      [x, y - 28],
      [x, y - 18],
    ],
    'ink-soft',
    0.05
  );
  const bucket: Pt[] = [
    [x - 3, y - 18],
    [x + 3, y - 18],
    [x + 2.4, y - 13],
    [x - 2.4, y - 13],
  ];
  return (
    s + fill(bucket, 'wood') + line(rng, [...bucket, bucket[0]], 'ink', 0.05)
  );
}

export function tower(x: number, y: number, h: number, rng: Rng) {
  let s =
    line(
      rng,
      [
        [x - 11, y],
        [x - 7, y - h * 0.7],
      ],
      'ink',
      0.2
    ) +
    line(
      rng,
      [
        [x + 11, y],
        [x + 7, y - h * 0.7],
      ],
      'ink',
      0.2
    );
  for (const t of [0.25, 0.5]) {
    const yy = y - h * 0.7 * t;
    s += line(
      rng,
      [
        [x - 11 + 4 * t, yy],
        [x + 11 - 4 * t, yy],
      ],
      'ink-soft',
      0.15
    );
  }
  s +=
    line(
      rng,
      [
        [x - 11, y],
        [x + 9, y - h * 0.35],
      ],
      'ink-soft',
      0.15
    ) +
    line(
      rng,
      [
        [x + 11, y],
        [x - 9, y - h * 0.35],
      ],
      'ink-soft',
      0.15
    );
  const deck: Pt[] = [
    [x - 11, y - h * 0.7],
    [x + 11, y - h * 0.7],
    [x + 11, y - h * 0.7 - 3],
    [x - 11, y - h * 0.7 - 3],
  ];
  s +=
    fill(deck, 'wood', rng, 0.1) +
    sketch([...deck, deck[0]], rng, 'ink', {
      amp: 0.1,
      passes: 1,
      smooth: false,
    });
  for (const px of [-10, 10])
    s += line(
      rng,
      [
        [x + px, y - h * 0.7 - 3],
        [x + px, y - h * 0.92],
      ],
      'ink',
      0.1
    );
  s += line(
    rng,
    [
      [x - 10, y - h * 0.78],
      [x + 10, y - h * 0.78],
    ],
    'ink-soft',
    0.1
  );
  const roof: Pt[] = [
    [x - 14, y - h * 0.9],
    [x, y - h],
    [x + 14, y - h * 0.9],
  ];
  return (
    s +
    fill(roof, 'roof', rng, 0.2) +
    sketch([...roof, roof[0]], rng, 'ink', {
      amp: 0.2,
      passes: 1,
      smooth: false,
    })
  );
}

export function haybale(x: number, y: number, rng: Rng) {
  let s = `<rect class="tm-hay" x="${n(x - 9)}" y="${n(y - 12)}" width="16" height="12"/>`;
  s +=
    line(
      rng,
      [
        [x - 9, y - 12],
        [x + 7, y - 12],
      ],
      'ink',
      0.2
    ) +
    line(
      rng,
      [
        [x - 9, y],
        [x + 7, y],
      ],
      'ink',
      0.2
    );
  const end = `cx="${n(x + 7)}" cy="${n(y - 6)}" rx="4" ry="6"`;
  s += `<ellipse class="tm-hay" ${end}/><ellipse class="tm-ink" ${end}/>`;
  s += `<path class="tm-ink-soft" d="M${n(x + 5)} ${n(y - 6)} a2 3 0 1 0 4 0 a2 3 0 1 0 -4 0"/>`;
  s += `<path class="tm-ink-soft" d="M${n(x - 9)} ${n(y - 12)} a4 6 0 0 0 0 12"/>`;
  for (const px of [-5, 0])
    s += `<path class="tm-ink-soft" d="M${n(x + px)} ${n(y - 12)} l0 12"/>`;
  return s;
}

export function bench(x: number, y: number, rng: Rng) {
  let s = `<path class="tm-wood" d="M${n(x - 12)} ${n(y - 8)} ${n(x + 12)} ${n(y - 8)} ${n(x + 12)} ${n(y - 6)} ${n(x - 12)} ${n(y - 6)}Z"/>`;
  s += line(
    rng,
    [
      [x - 12, y - 8],
      [x + 12, y - 8],
    ],
    'ink',
    0.1
  );
  s +=
    line(
      rng,
      [
        [x - 12, y - 14],
        [x + 12, y - 14],
      ],
      'ink',
      0.1
    ) +
    line(
      rng,
      [
        [x - 12, y - 17],
        [x + 12, y - 17],
      ],
      'ink',
      0.1
    );
  for (const px of [-9, 9])
    s += line(
      rng,
      [
        [x + px, y],
        [x + px, y - 17],
      ],
      'ink',
      0.1
    );
  return s;
}

// ---------- animals ----------

export function duck(x: number, y: number, rng: Rng) {
  const body: Pt[] = [
    [x - 9, y - 3],
    [x - 6, y - 7],
    [x + 2, y - 7],
    [x + 6, y - 5],
    [x + 8, y - 1],
    [x - 8, y],
  ];
  const head = `cx="${n(x + 6)}" cy="${n(y - 13)}" r="3"`;
  return (
    fill(body, 'feather', rng, 0.2) +
    sketch([...body, body[0]], rng, 'ink', { amp: 0.2, passes: 1 }) +
    line(
      rng,
      [
        [x + 3, y - 6],
        [x + 5, y - 12],
      ],
      'ink',
      0.1
    ) +
    `<circle class="tm-feather" ${head}/><circle class="tm-ink" ${head}/>` +
    `<path class="tm-beak" d="M${n(x + 8.6)} ${n(y - 13.5)} l4 1 l-4 1.4z"/>` +
    `<circle class="tm-eye" cx="${n(x + 6.6)}" cy="${n(y - 13.8)}" r=".8"/>` +
    line(
      rng,
      [
        [x - 2, y - 5],
        [x + 3, y - 4],
      ],
      'ink-soft',
      0.1
    ) +
    `<path class="tm-water" d="M${n(x - 13)} ${n(y + 2)} q4 -2 8 0 M${n(x + 4)} ${n(y + 2)} q4 -2 8 0"/>`
  );
}

export function rabbit(x: number, y: number, rng: Rng) {
  const body = `cx="${n(x)}" cy="${n(y - 5)}" rx="7" ry="5"`;
  const hx = x + 6;
  const hy = y - 10;
  const head = `cx="${n(hx)}" cy="${n(hy)}" r="3.4"`;
  let s = `<ellipse class="tm-fur" ${body}/><ellipse class="tm-ink" ${body}/>`;
  s += `<circle class="tm-fur" ${head}/><circle class="tm-ink" ${head}/>`;
  for (const dx of [-1, 1.4])
    s += `<path class="tm-ink" d="M${n(hx + dx)} ${n(hy - 2.6)} q-1.5 -6 .6 -9 q1.6 3 .8 9"/>`;
  s += `<circle class="tm-eye" cx="${n(hx + 1.4)}" cy="${n(hy - 0.4)}" r=".7"/>`;
  s += `<circle class="tm-tail" cx="${n(x - 7)}" cy="${n(y - 6)}" r="2"/>`;
  return (
    s +
    line(
      rng,
      [
        [x + 3, y],
        [x + 6, y],
      ],
      'ink',
      0.1
    ) +
    line(
      rng,
      [
        [x - 5, y],
        [x - 1, y],
      ],
      'ink',
      0.1
    )
  );
}

export function deer(x: number, y: number, rng: Rng) {
  const body: Pt[] = [
    [x - 13, y - 18],
    [x - 6, y - 21],
    [x + 8, y - 21],
    [x + 13, y - 17],
    [x + 11, y - 12],
    [x - 11, y - 12],
    [x - 14, y - 15],
  ];
  let s =
    fill(body, 'fur', rng, 0.2) +
    sketch([...body, body[0]], rng, 'ink', { amp: 0.25, passes: 1 });
  for (const lx of [-10, -7, 7, 10])
    s += line(
      rng,
      [
        [x + lx, y - 12.5],
        [x + lx + 0.6, y - 5],
        [x + lx, y],
      ],
      'ink',
      0.15
    );
  s += fill(
    [
      [x + 9, y - 20],
      [x + 14, y - 31],
      [x + 17, y - 31],
      [x + 14, y - 18],
    ],
    'fur',
    rng,
    0.1
  );
  s +=
    line(
      rng,
      [
        [x + 9, y - 20],
        [x + 14, y - 31],
      ],
      'ink',
      0.15
    ) +
    line(
      rng,
      [
        [x + 14, y - 18],
        [x + 17, y - 30],
      ],
      'ink',
      0.15
    );
  const head: Pt[] = [
    [x + 13, y - 31],
    [x + 16, y - 35],
    [x + 22, y - 33],
    [x + 23, y - 30],
    [x + 17, y - 29],
  ];
  s +=
    fill(head, 'fur', rng, 0.1) +
    sketch([...head, head[0]], rng, 'ink', { amp: 0.15, passes: 1 });
  s += `<circle class="tm-eye" cx="${n(x + 18)}" cy="${n(y - 32.5)}" r=".8"/>`;
  s += line(
    rng,
    [
      [x + 15, y - 35],
      [x + 13, y - 41],
      [x + 10, y - 44],
    ],
    'ink',
    0.1
  );
  s += line(
    rng,
    [
      [x + 13.6, y - 39],
      [x + 16, y - 43],
    ],
    'ink',
    0.1
  );
  s += line(
    rng,
    [
      [x + 17, y - 35],
      [x + 18, y - 41],
      [x + 21, y - 44],
    ],
    'ink',
    0.1
  );
  s += `<path class="tm-ink" d="M${n(x + 14)} ${n(y - 34)} l-3 -2 l1 3z"/>`;
  s += `<path class="tm-tail" d="M${n(x - 13)} ${n(y - 18)} l-3 -2 l1 4z"/>`;
  for (const [sx, sy] of [
    [-4, -18],
    [1, -19],
    [5, -17],
  ])
    s += `<circle class="tm-spot" cx="${n(x + sx)}" cy="${n(y + sy)}" r="1"/>`;
  return s;
}

export function sheep(x: number, y: number, rng: Rng) {
  const wool: Pt[] = [];
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * TAU;
    const r = 1 + 0.12 * Math.abs(Math.sin(a * 5));
    wool.push([x + 11 * r * Math.cos(a), y - 11 + 7 * r * Math.sin(a)]);
  }
  let s = '';
  for (const lx of [-6, -2, 3, 7])
    s += line(
      rng,
      [
        [x + lx, y - 6],
        [x + lx, y],
      ],
      'ink',
      0.1
    );
  s += `<path class="tm-wool" d="${polyD(wool)}Z"/>`;
  s += sketch(wool, rng, 'ink', { amp: 0.3, passes: 1 });
  s += `<ellipse class="tm-face" cx="${n(x + 12)}" cy="${n(y - 13)}" rx="3.4" ry="4.6" transform="rotate(20 ${n(x + 12)} ${n(y - 13)})"/>`;
  s += `<path class="tm-face" d="M${n(x + 9)} ${n(y - 17)} l-3 1 l2 2z"/>`;
  return (
    s +
    line(
      rng,
      [
        [x - 4, y - 12],
        [x - 1, y - 14],
        [x + 2, y - 12],
      ],
      'ink-soft',
      0.1
    )
  );
}

export function fishJump(x: number, y: number) {
  const fish = `d="M${n(x + 4)} ${n(y - 13)} q6 -4 11 1 q-5 5 -11 1z M${n(x + 4)} ${n(y - 13)} l-4 -3 l1 5z"`;
  return (
    `<path class="tm-ink-soft" d="M${n(x - 12)} ${n(y)} q8 -18 22 -6" stroke-dasharray="2 3"/>` +
    `<path class="tm-fishfill" ${fish}/><path class="tm-ink" ${fish}/>` +
    `<path class="tm-water" d="M${n(x - 16)} ${n(y)} q3 -3 6 0 M${n(x - 13)} ${n(y + 4)} l8 0"/>`
  );
}

export const butterfly = (x: number, y: number) =>
  `<path class="tm-petal" d="M${n(x)} ${n(y)} q-5 -6 -6 0 q1 3 6 0 q5 -6 6 0 q-1 3 -6 0z"/>` +
  `<path class="tm-ink-soft" d="M${n(x)} ${n(y - 2)} l0 4"/>`;

// ---------- drawn in place ----------

export function flag(x: number, y: number, rng: Rng, h = 28, w = 20) {
  return (
    sketch(
      [
        [x, y],
        [x, y - h],
      ],
      rng,
      'trail-ink',
      { amp: 0.5, smooth: false }
    ) +
    `<path class="tm-flag" d="M${n(x)} ${n(y - h)} Q${n(x + w * 0.55)} ${n(y - h - 4)} ${n(x + w)} ${n(y - h + 2)} ` +
    `L${n(x + w * 0.62)} ${n(y - h + 8)} L${n(x + w)} ${n(y - h + 15)} Q${n(x + w * 0.5)} ${n(y - h + 12)} ${n(x)} ${n(y - h + 14)}Z"/>`
  );
}

export function signpost(x: number, y: number, label: string, rng: Rng) {
  const board: Pt[] = [
    [x - 12, y - 46],
    [x + 28, y - 46],
    [x + 36, y - 39],
    [x + 28, y - 32],
    [x - 12, y - 32],
  ];
  return (
    line(
      rng,
      [
        [x - 1.2, y + 2],
        [x - 1.2, y - 44],
      ],
      'ink',
      0.2
    ) +
    line(
      rng,
      [
        [x + 1.2, y + 2],
        [x + 1.2, y - 44],
      ],
      'ink',
      0.2
    ) +
    fill(board, 'wood', rng, 0.2) +
    line(rng, [...board, board[0]], 'ink', 0.3) +
    `<text class="tm-sign" x="${n(x + 11)}" y="${n(y - 35.5)}" text-anchor="middle">${escapeText(label)}</text>`
  );
}

export function bridge(x0: number, x1: number, y: number, rng: Rng) {
  let s = `<path class="tm-wood" d="M${n(x0)} ${n(y - 6)} ${n(x1)} ${n(y - 6)} ${n(x1)} ${n(y + 6)} ${n(x0)} ${n(y + 6)}Z"/>`;
  s +=
    line(
      rng,
      [
        [x0, y - 6],
        [x1, y - 6],
      ],
      'ink',
      0.2
    ) +
    line(
      rng,
      [
        [x0, y + 6],
        [x1, y + 6],
      ],
      'ink',
      0.2
    );
  for (let px = Math.floor(x0) + 4; px < x1; px += 5)
    s += `<path class="tm-ink-soft" d="M${px} ${n(y - 6)} ${px} ${n(y + 6)}"/>`;
  for (const yy of [y - 6, y + 6]) {
    for (const px of [x0, (x0 + x1) / 2, x1])
      s += line(
        rng,
        [
          [px, yy],
          [px, yy - 10],
        ],
        'ink',
        0.1
      );
    s += line(
      rng,
      [
        [x0 - 1, yy - 9],
        [x1 + 1, yy - 9],
      ],
      'ink',
      0.3
    );
  }
  return s;
}

/** Two banks with a tinted bed, flow ticks and bank stones. */
export function stream(pts: readonly Pt[], rng: Rng, width: number) {
  const left = catmull(pts, 6);
  const right: Pt[] = left.map(([x, y]) => [x + width, y]);
  let s = `<path class="tm-waterfill" d="${polyD([...left, ...[...right].reverse()])}Z"/>`;
  s +=
    sketch(left, rng, 'water', { amp: 0.6, passes: 1 }) +
    sketch(right, rng, 'water', { amp: 0.6, passes: 1 });
  for (let i = 3; i < left.length - 3; i += 7)
    s += `<path class="tm-water" d="M${n(left[i][0] + 4)} ${n(left[i][1])} q2 -2 4 0"/>`;
  for (let i = 5; i < right.length; i += 11) {
    const at = `cx="${n(right[i][0] + 4)}" cy="${n(right[i][1])}" rx="2.6" ry="1.8"`;
    s += `<ellipse class="tm-stone" ${at}/><ellipse class="tm-ink-thin" ${at}/>`;
  }
  return s;
}

export function lake(cx: number, cy: number, rx: number, ry: number, rng: Rng) {
  const shore: Pt[] = [];
  for (let k = 0; k <= 40; k++) {
    const a = (k / 40) * TAU;
    shore.push([
      cx + rx * Math.cos(a) * (1 + 0.05 * Math.sin(a * 3)),
      cy + ry * Math.sin(a),
    ]);
  }
  let s =
    `<path class="tm-waterfill" d="${polyD(shore)}Z"/>` +
    sketch(shore, rng, 'water', { amp: 0.5 });
  for (const [dx, dy, w] of [
    [-0.45, -0.2, 0.3],
    [0.05, 0.1, 0.4],
    [-0.15, 0.45, 0.22],
    [0.35, -0.35, 0.2],
  ])
    s += `<path class="tm-water" d="M${n(cx + dx * rx)} ${n(cy + dy * ry)} l${n(w * rx)} 0"/>`;
  return s;
}
