/**
 * Town, industry and railway elements for Learning's progress map. Most are
 * drawn once at the origin (base y = 0, centred on x = 0) as templates; the
 * stations, the buffer stop and the girder bridge are drawn in place.
 */
import { roundTree } from '@/features/questions/trailMap/elements';
import {
  escapeText,
  fill,
  hatch,
  line,
  n,
  type Pt,
  polyD,
  type Rng,
  sketch,
} from '@/features/questions/trailMap/sketch';

const pick = <T>(rng: Rng, items: readonly T[]) =>
  items[rng.int(0, items.length - 1)];

/** Corners from bottom-left, clockwise. */
const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  [x0, y0],
  [x0, y1],
  [x1, y1],
  [x1, y0],
];

/** A filled shape with a hand-drawn outline. */
const box = (pts: Pt[], cls: string, rng: Rng, amp = 0.25) =>
  fill(pts, cls, rng, 0.2) +
  sketch([...pts, pts[0]], rng, 'ink', { amp, passes: 1, smooth: false });

function windows(
  x0: number,
  x1: number,
  top: number,
  bottom: number,
  rng: Rng,
  { cw = 8, ch = 10, lit = 0.3 } = {}
) {
  let s = '';
  const cols = Math.max(1, Math.floor((x1 - x0 - 4) / cw));
  const rows = Math.max(1, Math.floor((bottom - top - 4) / ch));
  const ww = (x1 - x0 - 4) / cols;
  for (let c = 0; c < cols; c++)
    for (let r = 0; r < rows; r++)
      if (rng.next() < 0.88)
        s += `<rect class="${rng.next() < lit ? 'tm-window' : 'tm-pane'}" x="${n(x0 + 3 + c * ww)}" y="${n(top + 3 + r * ch)}" width="${n(ww - 3)}" height="${n(ch - 4)}"/>`;
  return s;
}

function smoke(x: number, y: number, rng: Rng) {
  let s = '';
  for (let k = 0; k < 3; k++)
    s += `<circle class="tm-puff" cx="${n(x + 5 * k + rng.uniform(-1, 1))}" cy="${n(y - 6 * k)}" r="${n(3 + 1.3 * k)}"/>`;
  return s;
}

const hLine = (x0: number, x1: number, y: number, cls = 'ink-soft') =>
  `<path class="tm-${cls}" d="M${n(x0)} ${n(y)} L${n(x1)} ${n(y)}"/>`;

// ---------- city ----------

/** A walled block with a window grid, flat or gabled roof. */
function building(
  x: number,
  y: number,
  w: number,
  h: number,
  rng: Rng,
  cls: string
) {
  return (
    box(rect(x, y, x + w, y - h), cls, rng) +
    windows(x, x + w, y - h + 2, y - 4, rng, { ch: 11, cw: 9, lit: 0.35 }) +
    line(
      rng,
      [
        [x - 2, y - h],
        [x + w + 2, y - h],
      ],
      'ink',
      0.2
    )
  );
}

export function tower(rng: Rng) {
  return (
    building(-12, 0, 24, 72, rng, pick(rng, ['stone', 'brick', 'canvas'])) +
    box(rect(-7, -72, 1, -78), 'stone', rng, 0.1) +
    line(
      rng,
      [
        [6, -72],
        [6, -86],
      ],
      'ink-soft',
      0.05
    )
  );
}

export function block(rng: Rng) {
  let s = building(
    -18,
    0,
    36,
    48,
    rng,
    pick(rng, ['stone', 'brick', 'canvas'])
  );
  if (rng.next() < 0.6) {
    // a water tank on legs
    for (const lx of [4, 12])
      s += line(
        rng,
        [
          [lx, -48],
          [lx, -54],
        ],
        'ink',
        0.05
      );
    s +=
      box(rect(2, -54, 14, -62), 'wood', rng, 0.1) +
      '<path class="tm-ink" d="M2 -62 L8 -66 L14 -62"/>';
  }
  return s;
}

export function office(rng: Rng) {
  let s = box(rect(-14, 0, 14, -82), 'glass', rng);
  for (let k = 1; k < 5; k++) {
    const x = -14 + (28 * k) / 5;
    s += `<path class="tm-ink-thin" d="M${n(x)} -80 L${n(x)} -2"/>`;
  }
  for (let y = -70; y < -4; y += 12) s += hLine(-13, 13, y);
  return (
    s +
    hatch(
      [
        [4, -80],
        [14, -80],
        [14, -2],
        [4, -2],
      ],
      rng,
      60,
      5,
      'ink-hatch',
      0.6
    ) +
    box(rect(-9, -82, 9, -90), 'stone', rng, 0.1)
  );
}

export function shop(rng: Rng) {
  const awningCls = pick(rng, ['roof', 'leaf2', 'pane']);
  let s =
    box(
      rect(-15, 0, 15, -24),
      pick(rng, ['canvas', 'wood', 'stone', 'brick']),
      rng
    ) + box(rect(-15, -18, 15, -24), 'board', rng, 0.1);
  const awning: Pt[] = [
    [-16, -17],
    [16, -17],
    [18, -11],
    [-18, -11],
  ];
  s += fill(awning, awningCls, rng, 0.1);
  for (let k = 0; k < 6; k++) {
    const x = -16 + (32 * k) / 6;
    s += `<path class="tm-awning" d="M${n(x)} -17 L${n(x + 2.6)} -11"/>`;
  }
  return (
    s +
    sketch([...awning, awning[0]], rng, 'ink', {
      amp: 0.15,
      passes: 1,
      smooth: false,
    }) +
    '<rect class="tm-pane" x="-12" y="-9" width="11" height="8"/><rect class="tm-door" x="4" y="-10" width="7" height="10"/>' +
    line(
      rng,
      [
        [-12, -9],
        [-1, -9],
        [-1, -1],
        [-12, -1],
        [-12, -9],
      ],
      'ink',
      0.1
    )
  );
}

export const lamp = (rng: Rng) =>
  line(
    rng,
    [
      [0, 0],
      [0, -26],
    ],
    'ink',
    0.05
  ) +
  line(
    rng,
    [
      [0, -26],
      [5, -27],
    ],
    'ink',
    0.05
  ) +
  '<circle class="tm-window" cx="5" cy="-24.5" r="2.2"/><circle class="tm-ink-thin" cx="5" cy="-24.5" r="2.2"/>';

export function car(rng: Rng) {
  const body: Pt[] = [
    [-11, -2],
    [-11, -7],
    [-6, -7],
    [-3, -12],
    [5, -12],
    [8, -7],
    [11, -6.5],
    [11, -2],
  ];
  return (
    box(body, pick(rng, ['roof', 'pane', 'canvas', 'leaf2']), rng, 0.1) +
    '<path class="tm-glassline" d="M-4 -7.5 L-2 -11 L4 -11 L6 -7.5Z"/>' +
    '<circle class="tm-wheel" cx="-6" cy="-1.5" r="2.6"/><circle class="tm-wheel" cx="6" cy="-1.5" r="2.6"/>'
  );
}

export function bus(rng: Rng) {
  let s = box(rect(-20, -2, 20, -18), pick(rng, ['roof', 'canvas']), rng, 0.1);
  for (let k = 0; k < 5; k++)
    s += `<rect class="tm-pane" x="${n(-17 + k * 7)}" y="-15" width="5" height="5"/>`;
  return (
    s +
    hLine(-20, 20, -8) +
    '<circle class="tm-wheel" cx="-12" cy="-1.5" r="3"/><circle class="tm-wheel" cx="12" cy="-1.5" r="3"/>'
  );
}

export function clockTower(rng: Rng) {
  const h = 78;
  const roof: Pt[] = [
    [-11, -h],
    [0, -h - 16],
    [11, -h],
  ];
  return (
    building(-9, 0, 18, h, rng, 'canvas') +
    box(roof, 'roof', rng, 0.2) +
    `<circle class="tm-pane" cx="0" cy="${-h + 9}" r="5"/><circle class="tm-ink" cx="0" cy="${-h + 9}" r="5"/>` +
    `<path class="tm-ink" d="M0 ${-h + 9} l0 -3.5 M0 ${-h + 9} l2.5 1"/>`
  );
}

export function crane(rng: Rng) {
  const [x, h] = [-13, 86];
  let s =
    line(
      rng,
      [
        [x, 0],
        [x, -h],
      ],
      'ink',
      0.2
    ) +
    line(
      rng,
      [
        [x + 4, 0],
        [x + 4, -h],
      ],
      'ink',
      0.2
    );
  for (let k = 1; k < Math.floor(h / 8); k++)
    s += `<path class="tm-ink-soft" d="M${x} ${-k * 8} l4 -8"/>`;
  const jib = (pts: Pt[], cls = 'ink', amp = 0.2) => line(rng, pts, cls, amp);
  return (
    s +
    jib([
      [x - 14, -h],
      [x + 40, -h],
    ]) +
    jib(
      [
        [x + 2, -h - 8],
        [x + 40, -h],
      ],
      'ink-soft'
    ) +
    jib(
      [
        [x + 2, -h - 8],
        [x - 14, -h],
      ],
      'ink-soft'
    ) +
    jib(
      [
        [x + 32, -h],
        [x + 32, -h + 18],
      ],
      'ink-soft',
      0.1
    )
  );
}

// ---------- industry ----------

export function factory(rng: Rng) {
  let s = box(rect(-28, 0, 14, -24), pick(rng, ['brick', 'stone']), rng);
  // sawtooth roof: four bays, glazed on the steep side
  for (let k = 0; k < 4; k++) {
    const x0 = -28 + k * 10.5;
    const tooth: Pt[] = [
      [x0, -24],
      [x0, -34],
      [x0 + 10.5, -24],
    ];
    s +=
      fill(tooth, 'glass', rng, 0.1) +
      sketch(tooth, rng, 'ink', { amp: 0.1, passes: 1, smooth: false });
  }
  s += windows(-28, 14, -20, -4, rng, { ch: 16, cw: 7, lit: 0.15 });
  s += box(rect(16, 0, 24, -62), 'brick', rng);
  for (const y of [-50, -38]) s += hLine(16, 24, y);
  return s + smoke(22, -68, rng);
}

export function chimneys(rng: Rng) {
  let s = box(rect(-14, 0, 14, -16), 'brick', rng);
  for (const [x0, h] of [
    [-9, 80],
    [3, 66],
  ]) {
    s += box(rect(x0, -16, x0 + 7, -h), 'brick', rng);
    for (let y = -h + 8; y < -18; y += 12) s += hLine(x0, x0 + 7, y);
    s += smoke(x0 + 4, -h - 6, rng);
  }
  return s;
}

export function tanks(rng: Rng) {
  let s = '';
  for (const [cx, w, h] of [
    [-9, 17, 26],
    [10, 14, 19],
  ]) {
    s +=
      fill(rect(cx - w / 2, 0, cx + w / 2, -h), 'metal', rng, 0.1) +
      line(
        rng,
        [
          [cx - w / 2, 0],
          [cx - w / 2, -h],
        ],
        'ink',
        0.1
      ) +
      line(
        rng,
        [
          [cx + w / 2, 0],
          [cx + w / 2, -h],
        ],
        'ink',
        0.1
      ) +
      `<ellipse class="tm-metal" cx="${n(cx)}" cy="${-h}" rx="${n(w / 2)}" ry="2.6"/><ellipse class="tm-ink" cx="${n(cx)}" cy="${-h}" rx="${n(w / 2)}" ry="2.6"/>` +
      `<path class="tm-ink-soft" d="M${n(cx - w / 2)} ${n(-h * 0.5)} q${n(w / 2)} 2.6 ${n(w)} 0"/>`;
  }
  return (
    s +
    '<path class="tm-ink-thin" d="M-15 0 L-15 -26 M-13 0 L-13 -26 M-15 -6 L-13 -6 M-15 -12 L-13 -12 M-15 -18 L-13 -18 M-15 -24 L-13 -24"/>' +
    line(
      rng,
      [
        [-1, -9],
        [3, -9],
      ],
      'ink',
      0.05
    )
  );
}

export function warehouse(rng: Rng) {
  let s = box(rect(-25, 0, 25, -22), pick(rng, ['metal', 'wood']), rng);
  s += box(
    [
      [-27, -22],
      [0, -31],
      [27, -22],
    ],
    'roof2',
    rng,
    0.15
  );
  for (const x0 of [-19, 4]) {
    s += box(rect(x0, 0, x0 + 14, -14), 'stone', rng, 0.1);
    for (const y of [-4, -8, -12]) s += hLine(x0, x0 + 14, y);
  }
  return s;
}

export function containers(rng: Rng) {
  let s = '';
  for (const [x0, y0, cls] of [
    [-16, 0, pick(rng, ['roof', 'pane'])],
    [0, 0, pick(rng, ['leaf2', 'canvas'])],
    [-9, -8, pick(rng, ['pane', 'roof', 'canvas'])],
  ] as const) {
    s +=
      box(rect(x0, y0, x0 + 15, y0 - 8), cls, rng, 0.1) +
      `<path class="tm-ink-soft" d="M${x0 + 4} ${y0 - 1} l0 -6 M${x0 + 7.5} ${y0 - 1} l0 -6 M${x0 + 11} ${y0 - 1} l0 -6"/>`;
  }
  return s;
}

export function truck(rng: Rng) {
  return (
    box(
      rect(-22, -4, 5, -19),
      pick(rng, ['metal', 'canvas', 'pane']),
      rng,
      0.1
    ) +
    box(
      [
        [6, -4],
        [6, -15],
        [13, -15],
        [18, -10],
        [18, -4],
      ],
      pick(rng, ['roof', 'leaf2']),
      rng,
      0.1
    ) +
    '<path class="tm-pane" d="M8 -10 L8 -13.5 L12.5 -13.5 L15.5 -10Z"/>' +
    '<circle class="tm-wheel" cx="-17" cy="-2.5" r="3.2"/><circle class="tm-wheel" cx="-9" cy="-2.5" r="3.2"/><circle class="tm-wheel" cx="12" cy="-2.5" r="3.2"/>'
  );
}

export function barrels(rng: Rng) {
  let s = '';
  for (const [x0, y0] of [
    [-8, 0],
    [-2, 0],
    [-5, -8],
  ])
    s +=
      box(
        rect(x0, y0, x0 + 5.5, y0 - 8),
        pick(rng, ['roof', 'metal', 'leaf2']),
        rng,
        0.05
      ) +
      `<path class="tm-ink-thin" d="M${x0} ${y0 - 2.5} l5.5 0 M${x0} ${y0 - 5.5} l5.5 0"/>`;
  return s;
}

export function pylon(rng: Rng) {
  let s =
    line(
      rng,
      [
        [-9, 0],
        [-2, -62],
      ],
      'ink',
      0.1
    ) +
    line(
      rng,
      [
        [9, 0],
        [2, -62],
      ],
      'ink',
      0.1
    );
  for (let k = 0; k < 5; k++) {
    const [y0, y1] = [-k * 12, -(k + 1) * 12];
    const [w0, w1] = [9 - (7 * k) / 5, 9 - (7 * (k + 1)) / 5];
    s += `<path class="tm-ink-thin" d="M${n(-w0)} ${y0} L${n(w1)} ${y1} M${n(w0)} ${y0} L${n(-w1)} ${y1}"/>`;
  }
  for (const [y, w] of [
    [-52, 13],
    [-40, 10],
  ])
    s +=
      line(
        rng,
        [
          [-w, y],
          [w, y],
        ],
        'ink',
        0.05
      ) + `<path class="tm-ink-thin" d="M${-w} ${y} l0 4 M${w} ${y} l0 4"/>`;
  return s;
}

// ---------- town ----------

export function house(rng: Rng) {
  const roof: Pt[] = [
    [-16, -18],
    [0, -31],
    [16, -18],
  ];
  return (
    box(
      rect(-13, 0, 13, -18),
      pick(rng, ['canvas', 'wood', 'stone', 'brick']),
      rng
    ) +
    box(rect(5, -24, 9, -33), 'brick', rng, 0.1) +
    box(roof, pick(rng, ['roof', 'roof2']), rng, 0.15) +
    hatch(roof, rng, 20, 3.4, 'ink-hatch', 0.6) +
    box(rect(-9, 0, -3, -11), 'door', rng, 0.1) +
    '<rect class="tm-window" x="2" y="-13" width="7" height="6"/><path class="tm-ink-thin" d="M2 -13 h7 v6 h-7z M5.5 -13 v6"/>'
  );
}

export function terrace(rng: Rng) {
  const walls = ['canvas', 'brick', 'stone'];
  const start = rng.int(0, 2);
  let s = '';
  [-24, -8, 8].forEach((x0, k) => {
    s +=
      box(rect(x0, 0, x0 + 16, -22), walls[(k + start) % 3], rng) +
      `<rect class="tm-door" x="${n(x0 + 2)}" y="-9" width="4" height="9"/>` +
      `<rect class="${rng.next() < 0.4 ? 'tm-window' : 'tm-pane'}" x="${n(x0 + 9)}" y="-17" width="5" height="5"/><rect class="tm-pane" x="${n(x0 + 9)}" y="-8" width="5" height="5"/>`;
  });
  s += box(
    [
      [-26, -22],
      [-20, -30],
      [20, -30],
      [26, -22],
    ],
    'roof2',
    rng,
    0.15
  );
  for (const cx of [-12, 4])
    s += box(rect(cx, -30, cx + 4, -35), 'brick', rng, 0.05);
  return s;
}

export function church(rng: Rng) {
  let s =
    box(rect(-21, 0, 6, -22), 'stone', rng) +
    box(
      [
        [-23, -22],
        [-8, -32],
        [6, -22],
      ],
      'roof2',
      rng,
      0.15
    ) +
    box(rect(6, 0, 20, -40), 'stone', rng) +
    box(
      [
        [5, -40],
        [13, -66],
        [21, -40],
      ],
      'roof2',
      rng,
      0.15
    ) +
    '<path class="tm-ink" d="M13 -66 L13 -73 M10.5 -70.5 L15.5 -70.5"/>';
  for (const wx of [-16, -9, -2]) {
    const d = `M${wx} -6 L${wx} -14 Q${wx + 2} -17 ${wx + 4} -14 L${wx + 4} -6Z`;
    s += `<path class="tm-pane" d="${d}"/><path class="tm-ink-thin" d="${d}"/>`;
  }
  return (
    s +
    '<circle class="tm-window" cx="13" cy="-31" r="3.2"/><circle class="tm-ink-thin" cx="13" cy="-31" r="3.2"/>' +
    '<path class="tm-door" d="M10 0 L10 -9 Q13 -13 16 -9 L16 0Z"/>'
  );
}

// ---------- country ----------

export function hedge(rng: Rng) {
  const pts: Pt[] = [[-20, 0]];
  for (let i = 1; i < 9; i++)
    pts.push([
      -20 + (40 * i) / 9,
      -7 - 2.5 * Math.sin(i * 1.7) - rng.uniform(0, 1.5),
    ]);
  pts.push([20, 0]);
  return (
    fill(pts, 'leaf', rng, 0.2) +
    sketch(pts, rng, 'ink', { amp: 0.3, passes: 1 }) +
    hatch(pts, rng, 120, 3, 'ink-hatch', 0.7)
  );
}

export function wall(rng: Rng) {
  let s = box(rect(-20, 0, 20, -6), 'stone', rng, 0.3);
  for (let x = -16; x < 20; x += 6)
    s += `<path class="tm-ink-soft" d="M${n(x + rng.uniform(-1, 1))} 0 l0 -6"/>`;
  return s + hLine(-20, 20, -3);
}

export function tractor(rng: Rng) {
  const cls = pick(rng, ['roof', 'leaf2']);
  return (
    box(
      [
        [-6, -5],
        [-6, -12],
        [8, -10],
        [12, -5],
      ],
      cls,
      rng,
      0.1
    ) +
    box(rect(-9, -8, -2, -19), cls, rng, 0.1) +
    '<rect class="tm-pane" x="-7.5" y="-17" width="4" height="5"/>' +
    line(
      rng,
      [
        [6, -10],
        [6, -15],
      ],
      'ink',
      0.05
    ) +
    '<circle class="tm-wheel" cx="-6" cy="-5" r="5.5"/><circle class="tm-ink-thin" cx="-6" cy="-5" r="2"/><circle class="tm-wheel" cx="9" cy="-3" r="3.2"/>'
  );
}

export function barn(rng: Rng) {
  const [x, w] = [-20, 40];
  const h = w * 0.55;
  const dx = x + w * 0.3;
  const dw = w * 0.4;
  return (
    box(rect(x, 0, x + w, -h), 'roof', rng) +
    box(
      [
        [x - 3, -h],
        [x + w * 0.25, -h - w * 0.3],
        [x + w * 0.75, -h - w * 0.3],
        [x + w + 3, -h],
      ],
      'stone',
      rng,
      0.2
    ) +
    `<path class="tm-ink" d="M${n(dx)} 0 L${n(dx)} ${n(-h * 0.7)} L${n(dx + dw)} ${n(-h * 0.7)} L${n(dx + dw)} 0 M${n(dx)} 0 L${n(dx + dw)} ${n(-h * 0.7)} M${n(dx + dw)} 0 L${n(dx)} ${n(-h * 0.7)}"/>`
  );
}

export function silo(rng: Rng) {
  const h = 44;
  let s =
    fill(rect(-7, 0, 7, -h), 'stone', rng, 0.2) +
    line(
      rng,
      [
        [-7, 0],
        [-7, -h],
      ],
      'ink',
      0.2
    ) +
    line(
      rng,
      [
        [7, 0],
        [7, -h],
      ],
      'ink',
      0.2
    ) +
    `<path class="tm-roof" d="M-7 ${-h} q7 -10 14 0z"/><path class="tm-ink" d="M-7 ${-h} q7 -10 14 0"/>`;
  for (let k = 1; k < 4; k++)
    s += `<path class="tm-ink-soft" d="M-7 ${n((-h * k) / 4)} q7 2 14 0"/>`;
  return s;
}

export function cow(rng: Rng) {
  let s = box(
    [
      [-10, -12],
      [8, -12],
      [9, -5],
      [-10, -5],
    ],
    'feather',
    rng,
    0.2
  );
  for (const lx of [-8, -4, 4, 7])
    s += line(
      rng,
      [
        [lx, -5],
        [lx, 0],
      ],
      'ink',
      0.1
    );
  return (
    s +
    '<ellipse class="tm-face" cx="-6" cy="-10" rx="2.6" ry="2"/><ellipse class="tm-face" cx="3" cy="-8" rx="2.4" ry="1.8"/>' +
    '<path class="tm-feather" d="M8 -13 l6 -1 l1 6 l-6 0z"/><path class="tm-ink" d="M8 -13 l6 -1 l1 6 l-6 0z"/>'
  );
}

export const oak = (rng: Rng) => roundTree(0, 0, 60, rng);

// ---------- drawn in place ----------

/** Name board width per character, at the board's font size. */
const CHAR_W = 6;

/** Platform start to its far end: the house, a canopy as long as the name's longest line, the lamp. */
export const stationWidth = (lines: readonly string[]) =>
  44 + Math.max(60, CHAR_W * Math.max(...lines.map((t) => t.length)) + 20) + 12;

/**
 * A station house with a canopy over the platform; the name runs along the
 * canopy's fascia on one or two lines. x is where the platform starts, y the
 * line under it. The terminus carries the finish flag.
 */
export function station(
  x: number,
  y: number,
  lines: readonly string[],
  rng: Rng,
  terminus = false
) {
  const right = x + stationWidth(lines);
  const [hx0, hx1] = [x + 8, x + 44];
  const [can0, can1] = [hx1, right - 12];
  const bh = lines.length === 1 ? 13 : 24;
  const base = y - 9;
  let s = box(rect(x, y - 3, can1 + 10, base), 'stone', rng, 0.15);
  for (let px = x + 6; px < can1 + 10; px += 9)
    s += `<path class="tm-ink-soft" d="M${n(px)} ${n(base)} l0 6"/>`;
  // the house: walls, hipped roof, chimney, door, arched windows, a clock
  const top = base - 30;
  const roof: Pt[] = [
    [hx0 - 4, top],
    [hx0 + 6, top - 11],
    [hx1 - 6, top - 11],
    [hx1 + 4, top],
  ];
  s +=
    box(rect(hx0, base, hx1, top), 'brick', rng) +
    box(rect(hx1 - 12, top - 6, hx1 - 7, top - 16), 'brick', rng, 0.05) +
    box(roof, 'roof2', rng, 0.15) +
    hatch(roof, rng, 20, 3.4, 'ink-hatch', 0.6) +
    box(rect(hx0 + 14, base, hx0 + 22, y - 28), 'door', rng, 0.05);
  for (const wx of [hx0 + 4, hx0 + 27]) {
    const d = `M${n(wx)} ${n(y - 18)} L${n(wx)} ${n(y - 27)} Q${n(wx + 2.5)} ${n(y - 31)} ${n(wx + 5)} ${n(y - 27)} L${n(wx + 5)} ${n(y - 18)}Z`;
    s += `<path class="tm-window" d="${d}"/><path class="tm-ink-thin" d="${d}"/>`;
  }
  const [cx, cy] = [hx0 + 18, top + 6];
  s += `<circle class="tm-card" cx="${n(cx)}" cy="${n(cy)}" r="3.6"/><circle class="tm-ink-thin" cx="${n(cx)}" cy="${n(cy)}" r="3.6"/><path class="tm-ink-thin" d="M${n(cx)} ${n(cy)} l0 -2.4 M${n(cx)} ${n(cy)} l1.8 .8"/>`;
  // the canopy: posts, valance teeth, the name board as fascia, a shallow roof
  const fy = base - 24;
  for (let px = can0 + 10; px <= can1; px += 34)
    s +=
      line(
        rng,
        [
          [px, base],
          [px, fy],
        ],
        'ink',
        0.05
      ) +
      `<path class="tm-ink-thin" d="M${n(px - 4)} ${n(fy)} L${n(px)} ${n(fy + 4)} L${n(px + 4)} ${n(fy)}"/>`;
  let teeth = '';
  for (let tx = can0; tx < can1 - 3; tx += 4)
    teeth += ` L${n(tx + 2)} ${n(fy + 3)} L${n(tx + 4)} ${n(fy)}`;
  s += `<path class="tm-ink-soft" d="M${n(can0)} ${n(fy)}${teeth}"/>`;
  s += box(rect(can0, fy, can1, fy - bh), 'board', rng, 0.1);
  lines.forEach((text, i) => {
    s += `<text class="tm-board-t" x="${n((can0 + can1) / 2)}" y="${n(fy - 3.6 - 11 * (lines.length - 1 - i))}" text-anchor="middle">${escapeText(text)}</text>`;
  });
  s += box(
    [
      [can0 - 2, fy - bh],
      [can0 + 4, fy - bh - 5],
      [can1 + 2, fy - bh - 5],
      [can1 + 6, fy - bh],
    ],
    'roof2',
    rng,
    0.1
  );
  s += `<g transform="translate(${n(can1 + 4)} ${n(base)})">${lamp(rng)}</g>`;
  if (terminus) {
    // the finish flag on the canopy's far end, away from the last item
    const [fx, fb] = [can1 - 8, fy - bh - 5];
    const ft = fb - 26;
    s +=
      sketch(
        [
          [fx, fb],
          [fx, ft],
        ],
        rng,
        'trail-ink',
        { amp: 0.3, smooth: false }
      ) +
      `<path class="tm-flag" d="M${n(fx)} ${n(ft)} Q${n(fx + 12)} ${n(ft - 4)} ${n(fx + 22)} ${n(ft + 2)} L${n(fx + 14)} ${n(ft + 8)} L${n(fx + 22)} ${n(ft + 15)} Q${n(fx + 11)} ${n(ft + 12)} ${n(fx)} ${n(ft + 14)}Z"/>`;
  }
  return { right, svg: s, top: Math.min(fy - bh - 5, top - 17) };
}

export function bufferStop(x: number, y: number, rng: Rng) {
  return (
    box(rect(x - 3, y + 3, x + 3, y - 12), 'roof', rng, 0.1) +
    line(
      rng,
      [
        [x - 10, y + 3],
        [x - 3, y - 8],
      ],
      'ink',
      0.05
    ) +
    line(
      rng,
      [
        [x + 3, y - 8],
        [x + 8, y + 3],
      ],
      'ink',
      0.05
    )
  );
}

/** A steel truss over a river: deck along the line, top chord, diagonals, two piers. */
export function girderBridge(x0: number, x1: number, y: number, rng: Rng) {
  const top = 16;
  let s =
    box(rect(x0, y + 4, x1, y - 1), 'metal', rng, 0.1) +
    line(
      rng,
      [
        [x0 + 4, y - top],
        [x1 - 4, y - top],
      ],
      'ink',
      0.1
    ) +
    line(
      rng,
      [
        [x0, y],
        [x0 + 4, y - top],
      ],
      'ink',
      0.05
    ) +
    line(
      rng,
      [
        [x1, y],
        [x1 - 4, y - top],
      ],
      'ink',
      0.05
    );
  const count = Math.max(3, Math.floor((x1 - x0) / 12));
  const pts: Pt[] = [];
  for (let k = 0; k <= count; k++)
    pts.push([x0 + 4 + ((x1 - x0 - 8) * k) / count, y - (k % 2 ? top : 0)]);
  s += `<path class="tm-ink-thin" d="${polyD(pts)}"/>`;
  for (const px of [x0 + 2, x1 - 2])
    s += box(rect(px - 4, y + 34, px + 4, y + 4), 'stone', rng, 0.1);
  return s;
}
