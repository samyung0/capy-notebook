import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useSyncCustomization } from '@/api/hooks';
import type {
  FrostPanel,
  PageFrame,
  PageFrameColor,
  PageFramePattern,
} from '@/api/types';
import { Button } from '@/components/ui/Button';
import { ButtonGroup } from '@/components/ui/ButtonGroup';
import { InputTitle } from '@/components/ui/Input';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import {
  dotColor,
  FRAME_PATTERNS,
  FRAME_PRESET_NAMES,
  FRAME_PRESETS,
  FROST_PANELS,
  frameColors,
  MAX_FRAME_COLORS,
  patternImage,
  STRENGTH_MAX,
  shuffleFrame,
} from '@/theme/pageFrame';
import { useTheme } from '@/theme/theme';

const PATTERN_LABEL: Record<PageFramePattern, () => string> = {
  arc: m.page_frame_pattern_arc,
  glow: m.page_frame_pattern_glow,
  mesh: m.page_frame_pattern_mesh,
  none: m.page_frame_pattern_none,
};

const FROST_LABEL: Record<FrostPanel, () => string> = {
  center: m.page_frame_frost_center,
  left: m.page_frame_frost_left,
  right: m.page_frame_frost_right,
};

const PRESET_LABEL: Record<(typeof FRAME_PRESET_NAMES)[number], () => string> =
  {
    dawn: m.page_frame_preset_dawn,
    dusk: m.page_frame_preset_dusk,
    meadow: m.page_frame_preset_meadow,
    mist: m.page_frame_preset_mist,
    rose: m.page_frame_preset_rose,
    sea: m.page_frame_preset_sea,
    sunset: m.page_frame_preset_sunset,
    wheat: m.page_frame_preset_wheat,
  };

const clamp = (v: number, max = 1) => Math.max(0, Math.min(max, v));
const STEP = 0.05;
/** While a dot or slider drags, the page frame takes every third value
 * (~20 a second) and the stylesheet glides between them, so the whole
 * window repaints from a few samples instead of on every pointer move. */
const SAMPLE_FRAMES = 3;

/** The frame being edited: `set` applies at once, `drag` shows each value in
 * the drawer but hands the page frame a sample every few frames, `end`
 * commits the last one. */
function useLiveFrame() {
  const { pageFrame, setPageFrame } = useTheme();
  const [draft, setDraft] = useState<PageFrame | null>(null);
  const latest = useRef<PageFrame | null>(null);
  const dirty = useRef(false);
  const raf = useRef(0);
  const stop = () => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    delete document.documentElement.dataset.pageFrameLive;
  };
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.pageFrameEdit = '';
    return () => {
      stop();
      delete root.dataset.pageFrameEdit;
    };
  }, []);
  const end = () => {
    if (!raf.current) return;
    stop();
    if (latest.current) setPageFrame(latest.current);
    latest.current = null;
    setDraft(null);
  };
  return {
    drag: (next: PageFrame) => {
      latest.current = next;
      dirty.current = true;
      setDraft(next);
      if (raf.current) return;
      document.documentElement.dataset.pageFrameLive = '';
      let frames = 0;
      const tick = () => {
        if (++frames % SAMPLE_FRAMES === 0 && dirty.current && latest.current) {
          dirty.current = false;
          setPageFrame(latest.current);
        }
        raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    },
    end,
    frame: draft ?? pageFrame,
    set: (next: PageFrame) => {
      stop();
      latest.current = null;
      setDraft(null);
      setPageFrame(next);
    },
  };
}

/**
 * The Theme drawer's Page frame section (openwiki/frontend/appearance.md):
 * pattern, colours (a preset or up to three custom colours on a hue and
 * saturation field), Strength and which panels frost over the frame, each
 * change kept on this device; then
 * Sync, which stores the style, theme and frame on the account for the
 * user's other devices, and Shuffle, a random set of colours and Strength.
 */
export function PageFrameSection() {
  const { style, theme } = useTheme();
  const live = useLiveFrame();
  const { frame } = live;
  const { isPending, mutate: sync } = useSyncCustomization();
  const set = (patch: Partial<PageFrame>) => live.set({ ...frame, ...patch });
  const shown = frameColors(frame);
  const pale = frameColors(frame, 0);
  const full = frameColors(frame, STRENGTH_MAX);

  // Its blocks are sections of the Theme drawer's column, spaced as the
  // drawer's other sections are.
  return (
    <>
      <div className="flex flex-col gap-3">
        <InputTitle>{m.page_frame_title()}</InputTitle>
        <div className="grid grid-cols-4 gap-2">
          {FRAME_PATTERNS.map((pattern) => (
            <button
              aria-pressed={frame.pattern === pattern}
              className={cn(
                'group flex flex-col items-center gap-1.5 rounded-button text-fg-muted',
                frame.pattern === pattern && 'text-fg'
              )}
              key={pattern}
              onClick={() => set({ pattern })}
              type="button"
            >
              <span
                className={cn(
                  'block h-10 w-full rounded-button border border-line transition-transform ease-(--motion-ease-smooth-out) group-hover:scale-[1.03]',
                  pattern === 'none' && 'bg-page',
                  frame.pattern === pattern &&
                    'ring-2 ring-action ring-offset-2 ring-offset-surface'
                )}
                style={
                  pattern === 'none'
                    ? undefined
                    : { backgroundImage: patternImage(pattern, shown) }
                }
              />
              <span className="t-muted font-medium">
                {PATTERN_LABEL[pattern]()}
              </span>
            </button>
          ))}
        </div>
      </div>
      {frame.pattern !== 'none' && (
        <>
          <div className="flex flex-col gap-3">
            <InputTitle>{m.page_frame_colours()}</InputTitle>
            <div className="flex flex-wrap gap-2">
              {FRAME_PRESET_NAMES.map((preset) => {
                const { dots, stops, strength } = FRAME_PRESETS[preset];
                const [a, b, c] = stops;
                return (
                  <Swatch
                    key={preset}
                    label={PRESET_LABEL[preset]()}
                    onClick={() => set({ colours: preset, dots, strength })}
                    pressed={frame.colours === preset}
                    style={{
                      background: `linear-gradient(135deg, ${a}, ${b} 55%, ${c})`,
                    }}
                  />
                );
              })}
              <Swatch
                label={m.page_frame_custom()}
                onClick={() => set({ colours: 'custom' })}
                pressed={frame.colours === 'custom'}
                style={{
                  background:
                    'conic-gradient(#f05a5a, #f0b45a, #5ae08c, #5a8cf0, #f05ac8, #f05a5a)',
                }}
              />
            </div>
            <ColorField
              dots={frame.dots}
              onChange={(dots) => set({ colours: 'custom', dots })}
              onDrag={(dots) =>
                live.drag({ ...frame, colours: 'custom', dots })
              }
              onDragEnd={live.end}
            />
          </div>
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-4">
            <span className="t-muted font-semibold">
              {m.page_frame_strength()}
            </span>
            <Track
              label={m.page_frame_strength()}
              max={STRENGTH_MAX}
              onChange={(strength) => set({ strength })}
              onDrag={(strength) => live.drag({ ...frame, strength })}
              onDragEnd={live.end}
              style={{
                background: `linear-gradient(90deg, ${pale[1]}, ${pale[2]} 20%, ${full[1]} 55%, ${full[2]})`,
              }}
              value={frame.strength}
            />
            <span className="t-muted font-semibold">
              {m.page_frame_frosted()}
            </span>
            <ButtonGroup aria-label={m.page_frame_frosted()}>
              {FROST_PANELS.map((panel) => {
                const on = frame.frosted.includes(panel);
                return (
                  <Button
                    aria-pressed={on}
                    key={panel}
                    onClick={() =>
                      set({
                        frosted: FROST_PANELS.filter((p) =>
                          p === panel ? !on : frame.frosted.includes(p)
                        ),
                      })
                    }
                    size="sm"
                    variant={on ? 'dark' : 'outline'}
                  >
                    {FROST_LABEL[panel]()}
                  </Button>
                );
              })}
            </ButtonGroup>
          </div>
        </>
      )}
      <div className="flex items-center justify-between gap-2">
        <Button
          disabled={isPending}
          iconRight="cloudSync"
          onClick={() =>
            sync(
              { pageFrame: frame, style, theme },
              {
                onSuccess: () =>
                  userToast({
                    title: m.customization_synced(),
                    variant: 'success',
                  }),
              }
            )
          }
          size="sm"
        >
          {m.customization_sync()}
        </Button>
        {frame.pattern !== 'none' && (
          <Button
            iconLeft="shuffle"
            onClick={() => live.set(shuffleFrame(frame))}
            size="sm"
            variant="outline"
          >
            {m.page_frame_shuffle()}
          </Button>
        )}
      </div>
    </>
  );
}

function Swatch({
  label,
  onClick,
  pressed,
  style,
}: {
  label: string;
  onClick: () => void;
  pressed: boolean;
  style: CSSProperties;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={pressed}
      className={cn(
        'size-6 rounded-full border border-line transition-transform ease-(--motion-ease-smooth-out) hover:scale-110',
        pressed && 'ring-2 ring-action ring-offset-2 ring-offset-surface'
      )}
      onClick={onClick}
      style={style}
      title={label}
      type="button"
    />
  );
}

/** Up to three colours as dots on a field: hue across, saturation down. A
 * dot drags, a click elsewhere moves the selected one, arrow keys nudge it.
 * Dots glide to a preset's or a shuffle's places, and follow a drag at once. */
function ColorField({
  dots,
  onChange,
  onDrag,
  onDragEnd,
}: {
  dots: PageFrameColor[];
  onChange: (dots: PageFrameColor[]) => void;
  onDrag: (dots: PageFrameColor[]) => void;
  onDragEnd: () => void;
}) {
  const field = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(0);
  const [dragging, setDragging] = useState(false);
  const sel = Math.min(selected, dots.length - 1);
  const endDrag = () => {
    setDragging(false);
    onDragEnd();
  };
  const moveTo = (index: number, clientX: number, clientY: number) => {
    const box = field.current?.getBoundingClientRect();
    if (!box) return;
    onDrag(
      dots.map((d, i) =>
        i === index
          ? {
              x: clamp((clientX - box.left) / box.width),
              y: clamp((clientY - box.top) / box.height),
            }
          : d
      )
    );
  };
  const nudge = (event: KeyboardEvent, index: number) => {
    const delta = {
      ArrowDown: [0, 0.02],
      ArrowLeft: [-0.02, 0],
      ArrowRight: [0.02, 0],
      ArrowUp: [0, -0.02],
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    onChange(
      dots.map((d, i) =>
        i === index ? { x: clamp(d.x + delta[0]), y: clamp(d.y + delta[1]) } : d
      )
    );
  };
  return (
    <div className="flex flex-col gap-1">
      <div
        aria-label={m.page_frame_field()}
        className="relative h-32 touch-none overflow-hidden rounded-card [background:radial-gradient(circle,rgb(255_255_255/.35)_1px,transparent_1.4px)_0_0/9px_9px,linear-gradient(to_bottom,rgb(255_255_255/0),rgb(128_128_128/.88)),linear-gradient(to_right,#f05a5a,#f0b45a,#c8e05a,#5ae08c,#5ad2e0,#5a8cf0,#a05af0,#f05ac8,#f05a5a)]"
        onLostPointerCapture={endDrag}
        onPointerDown={(event) => {
          const dot = (event.target as HTMLElement).closest<HTMLElement>(
            '[data-dot]'
          );
          const index = dot ? Number(dot.dataset.dot) : sel;
          setSelected(index);
          setDragging(true);
          event.currentTarget.setPointerCapture(event.pointerId);
          moveTo(index, event.clientX, event.clientY);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            moveTo(sel, event.clientX, event.clientY);
        }}
        ref={field}
        role="group"
      >
        {dots.map((d, i) => (
          <button
            aria-label={m.page_frame_colour_n({ n: String(i + 1) })}
            aria-pressed={i === sel}
            className={cn(
              'absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-3 border-white shadow-pop',
              i === sel && 'size-7',
              !dragging &&
                'transition-[left,top,background-color] duration-(--motion-duration-slow) ease-(--motion-ease-smooth-out)'
            )}
            data-dot={i}
            key={i}
            onKeyDown={(event) => nudge(event, i)}
            style={{
              background: dotColor(d),
              left: `${d.x * 100}%`,
              top: `${d.y * 100}%`,
            }}
            type="button"
          />
        ))}
      </div>
      <div className="flex items-center justify-between text-fg-muted text-sm">
        <span>
          {dots.length === 1
            ? m.page_frame_one_colour()
            : m.page_frame_colour_count({ count: String(dots.length) })}
        </span>
        <span className="flex">
          <Button
            aria-label={m.page_frame_remove_colour()}
            disabled={dots.length <= 1}
            iconLeft="minus"
            onClick={() => {
              onChange(dots.filter((_, i) => i !== sel));
              setSelected(Math.max(0, sel - 1));
            }}
            size="sm"
            variant="ghost-hover"
          />
          <Button
            aria-label={m.page_frame_add_colour()}
            disabled={dots.length >= MAX_FRAME_COLORS}
            iconLeft="plus"
            onClick={() => {
              onChange([
                ...dots,
                { x: (dots.at(-1)?.x ?? 0.5) * 0.5 + 0.25, y: 0.3 },
              ]);
              setSelected(dots.length);
            }}
            size="sm"
            variant="ghost-hover"
          />
        </span>
      </div>
    </div>
  );
}

/** A slider whose track shows its effect: Strength from pale to the chosen
 * colours. Its thumb glides to a preset's or a shuffle's value. */
function Track({
  label,
  max = 1,
  onChange,
  onDrag,
  onDragEnd,
  style,
  value,
}: {
  label: string;
  max?: number;
  onChange: (value: number) => void;
  onDrag: (value: number) => void;
  onDragEnd: () => void;
  style: CSSProperties;
  value: number;
}) {
  const [dragging, setDragging] = useState(false);
  const set = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    onDrag(clamp((event.clientX - box.left) / box.width, max));
  };
  return (
    <div
      aria-label={label}
      aria-valuemax={max}
      aria-valuemin={0}
      aria-valuenow={Math.round(value * 100) / 100}
      className="relative h-5.5 cursor-pointer touch-none rounded-full border border-line outline-none focus-visible:ring-2 focus-visible:ring-action"
      onKeyDown={(event) => {
        const delta = { ArrowLeft: -STEP, ArrowRight: STEP }[event.key];
        if (delta === undefined) return;
        event.preventDefault();
        onChange(clamp(value + delta, max));
      }}
      onLostPointerCapture={() => {
        setDragging(false);
        onDragEnd();
      }}
      onPointerDown={(event) => {
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        set(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) set(event);
      }}
      role="slider"
      style={style}
      tabIndex={0}
    >
      <span
        className={cn(
          'absolute -top-1 h-7 w-3 -translate-x-1/2 rounded-full bg-white shadow-pop ring-1 ring-black/10',
          !dragging &&
            'transition-[left] duration-(--motion-duration-slow) ease-(--motion-ease-smooth-out)'
        )}
        style={{ left: `${value * 100}%` }}
      />
    </div>
  );
}
