import { cn } from '@/lib/cn';
import { n, type Pt, Rng } from './sketch';

/** The board's width and the posts under it, in CSS pixels. */
export const BOARD_WIDTH = 236;
const POSTS = 12;

/** A sketched outline in a 100×100 box, stretched to the board (strokes keep their width). */
const outline = (() => {
  const rng = new Rng('map-board');
  const corners = [
    [0, 0],
    [50, 0],
    [100, 0],
    [100, 50],
    [100, 100],
    [50, 100],
    [0, 100],
    [0, 50],
  ];
  // About a pixel either way on a 236×80 board.
  const pass = () =>
    `M${corners
      .map(
        ([x, y]) =>
          `${n(x + rng.uniform(-0.4, 0.4))} ${n(y + rng.uniform(-1.3, 1.3))}`
      )
      .join(' L')}Z`;
  return [pass(), pass()];
})();

/**
 * Where the board's feet go, in CSS pixels: `x` (map units) and a little above
 * the highest point of the trail beneath it, so the posts end at the line.
 */
export function boardSpot(
  trail: readonly Pt[],
  x: number,
  scale: number,
  top: number
) {
  const right = x + BOARD_WIDTH / scale;
  const under = trail.filter(([px]) => px >= x && px <= right);
  const y = Math.min(...under.map(([, py]) => py));
  return { ground: (y - 10 - top) * scale, left: x * scale };
}

/**
 * A notice board on two posts, planted with its feet at `ground` (CSS pixels
 * in the map): the empty map's hint, drawn like the map's own signs. Wood on
 * the question bank's trail, a blue station board on the railway.
 */
export function MapBoard({
  left,
  ground,
  tone,
  title,
  text,
}: {
  left: number;
  ground: number;
  tone: 'wood' | 'station';
  title: string;
  text: string;
}) {
  const station = tone === 'station';
  return (
    <div
      className="pointer-events-none absolute -translate-y-full"
      // A narrow map (an @container) pulls it left so it ends inside the opening view.
      style={{
        left: `min(${left}px, calc(100cqw - ${BOARD_WIDTH + 12}px))`,
        top: ground,
        width: BOARD_WIDTH,
      }}
    >
      <div className="relative px-3 pt-2 pb-2.5">
        <svg
          aria-hidden
          className="trail-map absolute inset-0 size-full overflow-visible"
          preserveAspectRatio="none"
          viewBox="0 0 100 100"
        >
          <path
            className={cn('tm-ink', station ? 'tm-board' : 'tm-wood')}
            d={outline[0]}
            vectorEffect="non-scaling-stroke"
          />
          <path
            className="tm-ink-thin"
            d={outline[1]}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <p
          className={cn(
            'relative font-extrabold text-[11px] uppercase tracking-[0.08em]',
            station ? 'text-white' : 'text-fg'
          )}
        >
          {title}
        </p>
        <p
          className={cn(
            'relative mt-1 text-xs leading-snug',
            station ? 'text-white/85' : 'text-fg-secondary'
          )}
        >
          {text}
        </p>
      </div>
      <svg
        aria-hidden
        className="trail-map block overflow-visible"
        height={POSTS}
        width={BOARD_WIDTH}
      >
        {[28, BOARD_WIDTH - 28].map((x) => (
          <g key={x}>
            <path
              className="tm-ink"
              d={`M${x} 0 L${x + 0.6} ${POSTS}`}
              style={{ strokeWidth: 2.4 }}
            />
            <path
              className="tm-ink-thin"
              d={`M${x - 6} ${POSTS} L${x + 6} ${POSTS + 0.5}`}
            />
          </g>
        ))}
      </svg>
    </div>
  );
}
