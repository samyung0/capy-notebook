import { useState } from 'react';
import type { CoverConfig } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { CoverArt, useCoverPaint } from '@/components/ui/CoverArt';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import {
  WorkspaceCardFace,
  type WorkspaceCardFields,
} from '@/components/ui/WorkspaceCard';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import {
  COVER_COLORS,
  GEO_PATTERNS,
  HERO_PATTERNS,
  PAPER_COLORS,
} from '@/lib/coverArt';

type Style = CoverConfig['style'];
type Variant = Pick<CoverConfig, 'kind' | 'pattern'>;

/** Each style's name, its own variants (with labels where they have one), and its colours. */
const STYLES: {
  style: Style;
  label: () => string;
  heading?: () => string;
  variants: (Variant & { label?: () => string })[];
}[] = [
  {
    heading: m.cover_subject,
    label: m.cover_style_symbols,
    style: 'symbols',
    variants: [
      { kind: 'math', label: m.cover_kind_math },
      { kind: 'latin', label: m.cover_kind_latin },
      { kind: 'kana', label: m.cover_kind_kana },
    ],
  },
  {
    heading: m.cover_subject,
    label: m.cover_style_doodles,
    style: 'doodles',
    variants: [
      { kind: 'math', label: m.cover_variant_science },
      { kind: 'latin', label: m.cover_kind_latin },
      { kind: 'kana', label: m.cover_kind_kana },
    ],
  },
  { label: m.cover_style_shelf, style: 'shelf', variants: [] },
  {
    heading: m.cover_paper,
    label: m.cover_style_paper,
    style: 'paper',
    variants: [
      { kind: 'math', label: m.cover_paper_grid },
      { kind: 'latin', label: m.cover_paper_ruled },
      { kind: 'kana', label: m.cover_paper_genko },
    ],
  },
  { label: m.cover_style_type, style: 'type', variants: [] },
  {
    heading: m.cover_pattern,
    label: m.cover_style_geo,
    style: 'geo',
    variants: GEO_PATTERNS.map((pattern) => ({ pattern })),
  },
  {
    heading: m.cover_pattern,
    label: m.cover_style_hero,
    style: 'hero',
    variants: HERO_PATTERNS.map((pattern) => ({ pattern })),
  },
];
const COLOR_NAMES = [
  m.cover_color_purple,
  m.cover_color_blue,
  m.cover_color_green,
  m.cover_color_red,
  m.cover_color_orange,
  m.cover_color_amber,
  m.cover_color_grey,
];
const PAPER_NAMES = [
  m.cover_paper_cream,
  m.cover_paper_white,
  m.cover_paper_grey,
  m.cover_paper_yellow,
];
/** Paper's colour is the paper itself, so it has paper tones only. */
const palette = (style: Style) =>
  style === 'paper'
    ? PAPER_COLORS.map((color, i) => ({ color, name: PAPER_NAMES[i] }))
    : COVER_COLORS.map((color, i) => ({ color, name: COLOR_NAMES[i] }));

/** A style with its variant; the colour carries over when the style allows it. */
function withStyle(
  style: Style,
  prev: CoverConfig | null,
  variant?: Variant
): CoverConfig {
  const colors = palette(style).map((item) => item.color);
  const color =
    prev && colors.includes(prev.color as never) ? prev.color : colors[0];
  const first = STYLES.find((item) => item.style === style)?.variants[0];
  const keep =
    prev?.style === style ? { kind: prev.kind, pattern: prev.pattern } : {};
  const pick = variant ?? (keep.kind || keep.pattern ? keep : first) ?? {};
  return {
    color,
    ...(pick.kind ? { kind: pick.kind } : {}),
    ...(pick.pattern ? { pattern: pick.pattern } : {}),
    ...(prev?.seed ? { seed: prev.seed } : {}),
    style,
  };
}

const randomSeed = () => Math.random().toString(36).slice(2, 10);

/** A small strip of one cover option. */
function CoverTile({
  cover,
  name,
  ownerId,
  label,
  selected,
  onClick,
  tall,
}: {
  cover: CoverConfig;
  /** The workspace name, which Big type draws. */
  name: string;
  ownerId: string;
  label: string;
  selected: boolean;
  onClick: () => void;
  tall?: boolean;
}) {
  const paint = useCoverPaint(ownerId, name, cover);
  return (
    <button
      aria-label={label}
      aria-pressed={selected}
      className={cn(
        'relative flex min-w-0 flex-col gap-1 rounded-card border-2 p-0.75 text-left outline-none transition-colors hover:bg-overlay-hover focus-visible:ring-2 focus-visible:ring-tint-accent-1-fg',
        selected
          ? 'border-solid-accent-1 bg-tint-accent-1 hover:bg-tint-accent-1'
          : 'border-transparent'
      )}
      onClick={onClick}
      type="button"
    >
      <span
        className={cn(
          'relative block w-full overflow-hidden rounded-button',
          tall ? 'h-14' : 'h-11'
        )}
      >
        <CoverArt paint={{ ...paint, shade: false }} />
      </span>
      {selected && (
        <span className="absolute top-2 right-2 rounded-full bg-tint-accent-1-fg p-0.5 text-surface">
          <Icon name="check" size={12} />
        </span>
      )}
    </button>
  );
}

/**
 * Picks a workspace card's cover: every style on the left drawn in the chosen
 * colour (mock B), and on the right the card as it will look, the style's own
 * variants, its colours and Shuffle. Nothing changes until Use cover.
 */
export function CoverPicker({
  open,
  onOpenChange,
  value,
  onChange,
  ownerId,
  card,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: CoverConfig | null;
  onChange: (next: CoverConfig | null) => void;
  ownerId: string;
  card: WorkspaceCardFields;
}) {
  const [draft, setDraft] = useState<CoverConfig>(
    () => value ?? withStyle('symbols', null)
  );
  const entry = STYLES.find((item) => item.style === draft.style)!;
  const paint = useCoverPaint(ownerId, card.name, draft);
  return (
    <Dialog
      onOpenChange={(next) => {
        if (next) setDraft(value ?? withStyle('symbols', null));
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent aria-describedby={undefined} className="max-w-[912px]">
        <DialogTitle className="shrink-0 pr-8">{m.cover_choose()}</DialogTitle>
        <div className="mt-3 flex flex-col gap-5 md:flex-row">
          <div className="grid grid-cols-2 content-start gap-2 md:w-[46%]">
            {STYLES.map((item) => (
              <div className="flex min-w-0 flex-col gap-1" key={item.style}>
                <CoverTile
                  cover={withStyle(item.style, draft)}
                  label={item.label()}
                  name={card.name}
                  onClick={() => setDraft(withStyle(item.style, draft))}
                  ownerId={ownerId}
                  selected={item.style === draft.style}
                  tall
                />
                <span className="t-meta truncate px-1 font-semibold">
                  {item.label()}
                </span>
              </div>
            ))}
          </div>
          <div className="hidden w-px bg-line md:block" />
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="pointer-events-none">
              <WorkspaceCardFace paint={paint} workspace={card} />
            </div>
            {entry.variants.length > 0 && entry.heading && (
              <div className="flex flex-col gap-1.5">
                <span className="t-label text-fg-muted uppercase">
                  {entry.heading()}
                </span>
                <div
                  className={cn(
                    'grid gap-1.5',
                    entry.variants.length > 3
                      ? 'max-h-44 grid-cols-4 overflow-auto pr-1'
                      : 'grid-cols-3'
                  )}
                >
                  {entry.variants.map((variant, i) => {
                    const label =
                      variant.label?.() ?? m.cover_pattern_n({ n: i + 1 });
                    return (
                      <div
                        className="flex min-w-0 flex-col gap-1"
                        key={variant.kind ?? variant.pattern}
                      >
                        <CoverTile
                          cover={withStyle(draft.style, draft, variant)}
                          label={label}
                          name={card.name}
                          onClick={() =>
                            setDraft(withStyle(draft.style, draft, variant))
                          }
                          ownerId={ownerId}
                          selected={
                            variant.kind
                              ? variant.kind === draft.kind
                              : variant.pattern === draft.pattern
                          }
                        />
                        {variant.label && (
                          <span className="t-meta truncate px-1">{label}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <span className="t-label text-fg-muted uppercase">
                {m.cover_color()}
              </span>
              <div className="flex items-center gap-2">
                <div className="flex flex-wrap gap-2">
                  {palette(draft.style).map(({ color, name }) => (
                    <button
                      aria-label={name()}
                      aria-pressed={draft.color === color}
                      className={cn(
                        'size-5.5 rounded-full border border-line outline-none focus-visible:ring-2 focus-visible:ring-tint-accent-1-fg',
                        draft.color === color &&
                          'ring-2 ring-fg ring-offset-2 ring-offset-overlay'
                      )}
                      key={color}
                      onClick={() => setDraft({ ...draft, color })}
                      style={{ backgroundColor: color }}
                      type="button"
                    />
                  ))}
                </div>
                <Button
                  className="ml-auto"
                  onClick={() => setDraft({ ...draft, seed: randomSeed() })}
                  size="sm"
                  type="button"
                  variant="ghost-hover"
                >
                  <Icon className="size-4" name="shuffle" />
                  {m.cover_shuffle()}
                </Button>
              </div>
            </div>
          </div>
        </div>
        <DialogFooter className="shrink-0 flex-row">
          {value && (
            <Button
              className="mr-auto"
              onClick={() => {
                onChange(null);
                onOpenChange(false);
              }}
              size="lg"
              type="button"
              variant="danger-light"
            >
              {m.cover_remove()}
            </Button>
          )}
          <Button
            onClick={() => onOpenChange(false)}
            size="lg"
            type="button"
            variant="ghost-hover"
          >
            {m.action_cancel()}
          </Button>
          <Button
            onClick={() => {
              onChange(draft);
              onOpenChange(false);
            }}
            size="lg"
            type="button"
            variant="accent"
          >
            {m.cover_use()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
