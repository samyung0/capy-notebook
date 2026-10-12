import { type RefObject, useEffect, useState } from 'react';
import { PREF_KEYS, readPref, writePref } from '@/lib/localPrefs';
import { scrollIntoViewWithMotion } from '@/lib/scrollIntoViewWithMotion';
import { n, type Pt } from './sketch';

/*
 * A progress map's finish: the map draws its finished state, and the first
 * time a finished topic or workspace leads its page (per browser) the
 * animation plays into it. Elements the animation drives carry data-finish:
 * line (the solid line, start to end), stop (the last stop), ring and dot
 * (drawn only while celebrating), tag (Finished) and burst (an empty layer
 * over the map, outside its clipping scroller). The flag and the done stops
 * are found by their map classes.
 */

/** A map's played key: the topic or workspace and its question or tracked-item
 * count, so finishing again after new content plays again. */
export const finishKey = (
  kind: 'topic' | 'workspace',
  id: string,
  count: number
) => `${kind}:${id}:${count}`;

/** Played keys kept, oldest dropped first. */
const KEEP = 200;

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

const playedKeys = () => readPref(PREF_KEYS.mapFinishPlayed, [], isStrings);

/**
 * Whether the map celebrates: it is finished (`key` set, with the topic or
 * workspace and its count, so finishing again after new content replays) and
 * this browser has not played that key. Decided once per key on mount; the
 * key is marked played when the animation starts.
 */
export function useFinishCelebration(
  key: string | undefined,
  hostRef: RefObject<HTMLElement | null>
) {
  const [first] = useState(() => ({
    key,
    play: key !== undefined && !playedKeys().includes(key),
  }));
  const celebrate = first.play && first.key === key;
  useEffect(() => {
    const host = hostRef.current;
    if (!(celebrate && key && host)) return;
    writePref(PREF_KEYS.mapFinishPlayed, [
      ...playedKeys()
        .filter((k) => k !== key)
        .slice(1 - KEEP),
      key,
    ]);
    return playFinish(host);
  }, [celebrate, key, hostRef]);
  return celebrate;
}

/** The celebration's extras on the last stop: its ring and the dot that rides
 * the line on (both end hidden), and the stop itself, which pops filled. */
export function FinishMarks({ at: [x, y] }: { at: Pt }) {
  return (
    <>
      <circle
        className="tm-you-ring"
        cx={n(x)}
        cy={n(y)}
        data-finish="ring"
        r={11}
        style={{ opacity: 0 }}
      />
      <circle
        className="tm-stop-done"
        cx={n(x)}
        cy={n(y)}
        data-finish="stop"
        r={6}
      />
      <circle
        className="tm-you-dot"
        cx={n(x)}
        cy={n(y)}
        data-finish="dot"
        r={4.5}
        style={{ opacity: 0 }}
      />
    </>
  );
}

/** The burst's layer: over the map host, outside the scroller's clip. */
export function FinishBurst() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 size-full overflow-visible"
      data-finish="burst"
    />
  );
}

const EASE = 'cubic-bezier(.3,.7,.4,1)';
const SVG = 'http://www.w3.org/2000/svg';
/** Firework colours beside the trail's: the map's own washes at full strength. */
const FIREWORKS = ['#f0a04b', '#8cc47a', '#5b9bd5', '#ec8fa3', '#f5cf4a'];
/** Fireworks around the flag (px from its middle), in turn, clear of the
 * Finished tag beside the bank's flag; no colour takes the trail's. */
const SHELLS: {
  delay: number;
  dx: number;
  dy: number;
  r: number;
  colour?: string;
}[] = [
  { delay: 0, dx: -150, dy: -26, r: 24 },
  { colour: FIREWORKS[0], delay: 260, dx: -225, dy: 4, r: 20 },
  { colour: FIREWORKS[2], delay: 520, dx: -60, dy: -52, r: 20 },
  { colour: FIREWORKS[3], delay: 820, dx: 75, dy: -36, r: 18 },
];
/** A lead-in, so a page still revealing its content (Learning) shows the pop. */
const STOP_POP = 650;
const RUN_AT = 1000;

/** Plays the finish on a map host; returns a cancel that leaves the finished map. */
function playFinish(host: HTMLElement) {
  const scroller = host.querySelector<HTMLElement>('[data-finish-scroll]');
  const svg = scroller?.querySelector('svg');
  const line = host.querySelector<SVGPathElement>('[data-finish="line"]');
  const stop = host.querySelector<SVGCircleElement>('[data-finish="stop"]');
  const ring = host.querySelector<SVGCircleElement>('[data-finish="ring"]');
  const dot = host.querySelector<SVGCircleElement>('[data-finish="dot"]');
  const tag = host.querySelector<HTMLElement>('[data-finish="tag"]');
  const burst = host.querySelector<SVGSVGElement>('[data-finish="burst"]');
  if (!(scroller && svg && line && stop && ring && dot && tag && burst))
    return () => {};
  const end = () => scroller.scrollWidth - scroller.clientWidth;
  // The page may open scrolled away (the bank keeps its scroll from the
  // topic): bring the map in, its heading above it.
  const box = host.getBoundingClientRect();
  if (box.top < 0 || box.bottom > innerHeight)
    scrollIntoViewWithMotion(host, 96);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    scroller.scrollLeft = end();
    return () => {};
  }

  const animations: Animation[] = [];
  const animate = (
    el: Element,
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions
  ) => animations.push(el.animate(keyframes, { fill: 'both', ...options }));
  scroller.scrollTo({ behavior: 'smooth', left: end() });

  // The last stop pops filled; its ring opens out.
  for (const el of [stop, ring]) {
    el.style.transformBox = 'fill-box';
    el.style.transformOrigin = 'center';
  }
  animate(
    stop,
    [
      { fill: 'var(--surface-card-bg)', transform: 'scale(1)' },
      { fill: 'var(--map-trail)', offset: 0.45, transform: 'scale(1.6)' },
      { fill: 'var(--map-trail)', transform: 'scale(1)' },
    ],
    { delay: STOP_POP, duration: 420, easing: EASE }
  );
  animate(
    ring,
    [
      { opacity: 0.45, transform: 'scale(1)' },
      { opacity: 0, transform: 'scale(2.2)' },
    ],
    { delay: STOP_POP, duration: 500 }
  );

  // The line runs on from the last stop to the end, a dot riding its head.
  const total = line.getTotalLength();
  const [sx, sy] = [stop.cx.baseVal.value, stop.cy.baseVal.value];
  let from = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let at = 0; at <= total; at += 3) {
    const p = line.getPointAtLength(at);
    const d = Math.hypot(p.x - sx, p.y - sy);
    if (d < best) [best, from] = [d, at];
  }
  const runMs = Math.min(1100, 300 + (total - from) * 3);
  animate(
    line,
    [
      { strokeDasharray: `${total}`, strokeDashoffset: total - from },
      { strokeDasharray: `${total}`, strokeDashoffset: 0 },
    ],
    { delay: RUN_AT, duration: runMs, easing: 'cubic-bezier(.45,0,.3,1)' }
  );
  const started = performance.now() + RUN_AT;
  let frame = 0;
  const ride = (now: number) => {
    const t = Math.min(1, Math.max(0, (now - started) / runMs));
    // Near enough the line's own curve.
    const k = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const p = line.getPointAtLength(from + (total - from) * k);
    dot.setAttribute('cx', `${p.x}`);
    dot.setAttribute('cy', `${p.y}`);
    if (t < 1) frame = requestAnimationFrame(ride);
  };
  frame = requestAnimationFrame(ride);
  animate(dot, [{ opacity: 1 }, { offset: 0.85, opacity: 1 }, { opacity: 0 }], {
    delay: RUN_AT,
    duration: runMs + 300,
  });

  // Arrival: measured once the scroll has settled.
  const arrive = RUN_AT + runMs;
  const timer = setTimeout(() => {
    arrival(host, svg, burst, animate);
  }, arrive);
  animate(
    tag,
    [
      { opacity: 0, transform: 'translateY(6px) scale(0.8)' },
      { offset: 0.6, opacity: 1, transform: 'translateY(-2px) scale(1.06)' },
      { opacity: 1, transform: 'none' },
    ],
    { delay: arrive + 250, duration: 450, easing: EASE }
  );

  return () => {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    for (const a of animations) a.cancel();
    burst.replaceChildren();
  };
}

/** The flag waves, fireworks open in the sky beside it, the done stops ripple back. */
function arrival(
  host: HTMLElement,
  svg: SVGSVGElement,
  burst: SVGSVGElement,
  animate: (el: Element, k: Keyframe[], o: KeyframeAnimationOptions) => void
) {
  const flag = [...svg.querySelectorAll<SVGGraphicsElement>('.tm-flag')]
    .map((el) => ({ box: el.getBoundingClientRect(), el }))
    .sort((a, b) => b.box.left - a.box.left)[0];
  if (!flag) return;
  flag.el.style.transformBox = 'fill-box';
  flag.el.style.transformOrigin = 'left center';
  animate(
    flag.el,
    [
      { transform: 'none' },
      { transform: 'scaleX(1.15) skewY(-8deg)' },
      { transform: 'scaleX(0.9) skewY(6deg)' },
      { transform: 'scaleX(1.1) skewY(-4deg)' },
      { transform: 'none' },
    ],
    { duration: 1100, easing: 'ease-in-out' }
  );

  const origin = host.getBoundingClientRect();
  const x = flag.box.left + flag.box.width / 2 - origin.left;
  const y = flag.box.top + flag.box.height / 2 - origin.top;
  const colour = getComputedStyle(flag.el).fill;
  const add = (d: string, style: string) => {
    const el = document.createElementNS(SVG, 'path');
    el.setAttribute('d', d);
    el.setAttribute(
      'style',
      `fill:none;stroke-linecap:round;stroke-linejoin:round;${style}`
    );
    burst.append(el);
    return el;
  };
  // Shells open in the sky beside the flag (the bank's summit flag sits at
  // the map's top edge), one after another, each kept inside the map's width.
  for (const shell of SHELLS) {
    const tint = shell.colour ?? colour;
    const bx = Math.min(
      Math.max(x + shell.dx, shell.r),
      host.clientWidth - shell.r
    );
    const by = y + shell.dy;
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2 + (Math.random() - 0.5) * 0.24;
      const [r0, r1] = [
        shell.r * 0.35,
        shell.r * (0.85 + Math.random() * 0.25),
      ];
      // A ray drawn out from the centre, drooping a little at its tip.
      const ray = add(
        `M${bx + Math.cos(a) * r0} ${by + Math.sin(a) * r0}Q${bx + Math.cos(a) * r1 * 0.8} ${by + Math.sin(a) * r1 * 0.8} ${bx + Math.cos(a) * r1} ${by + Math.sin(a) * r1 + 4}`,
        `stroke:${i % 3 ? tint : FIREWORKS[(i + 1) % FIREWORKS.length]};stroke-width:2`
      );
      // Drawn out over the first third, then it falls a little and fades.
      const dash = `${ray.getTotalLength()}`;
      animate(
        ray,
        [
          {
            opacity: 1,
            strokeDasharray: dash,
            strokeDashoffset: dash,
            transform: 'none',
          },
          {
            offset: 0.35,
            opacity: 1,
            strokeDasharray: dash,
            strokeDashoffset: 0,
          },
          { offset: 0.5, opacity: 1 },
          {
            opacity: 0,
            strokeDasharray: dash,
            strokeDashoffset: 0,
            transform: 'translateY(10px)',
          },
        ],
        { delay: shell.delay, duration: 1100, easing: 'ease-out' }
      );
      // A spark past each ray's tip that twinkles as it falls.
      const spark = add(
        `M${bx + Math.cos(a) * r1 * 1.25} ${by + Math.sin(a) * r1 * 1.25 + 4}l0 0.1`,
        `stroke:${tint};stroke-width:3`
      );
      animate(
        spark,
        [
          { opacity: 0 },
          { offset: 0.35, opacity: 1 },
          { offset: 0.6, opacity: 0.2 },
          { offset: 0.75, opacity: 1 },
          { opacity: 0, transform: 'translateY(14px)' },
        ],
        { delay: shell.delay + 200, duration: 1100 }
      );
    }
  }

  const stops = [
    ...svg.querySelectorAll<SVGCircleElement>('circle.tm-stop-done'),
  ]
    .filter((c) => c.r.baseVal.value === 6)
    .sort((a, b) => b.cx.baseVal.value - a.cx.baseVal.value);
  stops.forEach((c, i) => {
    c.style.transformBox = 'fill-box';
    c.style.transformOrigin = 'center';
    animate(
      c,
      [
        { transform: 'none' },
        { offset: 0.4, transform: 'scale(1.35)' },
        { transform: 'none' },
      ],
      { delay: 150 + i * 45, duration: 360, easing: EASE }
    );
  });
}
