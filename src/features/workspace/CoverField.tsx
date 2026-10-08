import type { CoverConfig } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { CoverArt, useCoverPaint } from '@/components/ui/CoverArt';
import { Icon } from '@/components/ui/Icon';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { COVER_COLORS, GEO_PATTERNS, HERO_PATTERNS } from '@/lib/coverArt';

type Style = CoverConfig['style'];
type Kind = NonNullable<CoverConfig['kind']>;

const STYLES: { value: Style; label: () => string }[] = [
  { label: m.cover_style_symbols, value: 'symbols' },
  { label: m.cover_style_doodles, value: 'doodles' },
  { label: m.cover_style_shelf, value: 'shelf' },
  { label: m.cover_style_paper, value: 'paper' },
  { label: m.cover_style_type, value: 'type' },
  { label: m.cover_style_geo, value: 'geo' },
  { label: m.cover_style_hero, value: 'hero' },
];
const KINDS: { value: Kind; label: () => string }[] = [
  { label: m.cover_kind_math, value: 'math' },
  { label: m.cover_kind_latin, value: 'latin' },
  { label: m.cover_kind_kana, value: 'kana' },
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
const pick = <T,>(list: readonly T[]) =>
  list[Math.floor(Math.random() * list.length)];
const randomSeed = () => Math.random().toString(36).slice(2, 10);

/** The fields a style draws, keeping the colour (and subject where it has one). */
function withStyle(style: Style, prev: CoverConfig | null): CoverConfig {
  const color = prev?.color ?? COVER_COLORS[0];
  if (style === 'symbols' || style === 'doodles' || style === 'paper')
    return { color, kind: prev?.kind ?? 'math', style };
  if (style === 'geo') return { color, pattern: pick(GEO_PATTERNS), style };
  if (style === 'hero') return { color, pattern: pick(HERO_PATTERNS), style };
  return { color, style };
}

/**
 * A workspace card's cover: None (the default) or a style with its subject,
 * a colour, and Shuffle for new art. The preview shows the workspace name.
 */
export function CoverField({
  value,
  onChange,
  ownerId,
  label,
  disabled,
}: {
  value: CoverConfig | null;
  onChange: (next: CoverConfig | null) => void;
  ownerId: string;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      {value && <CoverPreview cover={value} label={label} ownerId={ownerId} />}
      <div className="flex gap-2">
        <Select
          disabled={disabled}
          onValueChange={(style) =>
            onChange(style === 'none' ? null : withStyle(style as Style, value))
          }
          value={value?.style ?? 'none'}
        >
          <SelectTrigger aria-label={m.cover_label()} className="flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{m.cover_none()}</SelectItem>
            {STYLES.map((style) => (
              <SelectItem key={style.value} value={style.value}>
                {style.label()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {value?.kind && (
          <Select
            disabled={disabled}
            onValueChange={(kind) => onChange({ ...value, kind: kind as Kind })}
            value={value.kind}
          >
            <SelectTrigger aria-label={m.cover_subject()} className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KINDS.map((kind) => (
                <SelectItem key={kind.value} value={kind.value}>
                  {kind.label()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {value && (
        <div className="flex items-center gap-2">
          <div className="flex flex-wrap gap-2">
            {COVER_COLORS.map((color, i) => (
              <button
                aria-label={COLOR_NAMES[i]()}
                aria-pressed={value.color === color}
                className={cn(
                  'size-5.5 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-tint-accent-1-fg',
                  value.color === color &&
                    'ring-2 ring-fg ring-offset-2 ring-offset-overlay'
                )}
                disabled={disabled}
                key={color}
                onClick={() => onChange({ ...value, color })}
                style={{ backgroundColor: color }}
                type="button"
              />
            ))}
          </div>
          <Button
            className="ml-auto"
            disabled={disabled}
            onClick={() =>
              onChange(
                value.style === 'geo' || value.style === 'hero'
                  ? {
                      ...value,
                      pattern: pick(
                        value.style === 'geo' ? GEO_PATTERNS : HERO_PATTERNS
                      ),
                    }
                  : { ...value, seed: randomSeed() }
              )
            }
            size="sm"
            type="button"
            variant="ghost-hover"
          >
            <Icon className="size-4" name="shuffle" />
            {m.cover_shuffle()}
          </Button>
        </div>
      )}
    </div>
  );
}

function CoverPreview({
  cover,
  label,
  ownerId,
}: {
  cover: CoverConfig;
  label: string;
  ownerId: string;
}) {
  const paint = useCoverPaint(ownerId, label, cover);
  return (
    <div className="relative flex h-16 items-end overflow-hidden rounded-button px-3 pb-2">
      <CoverArt paint={paint} />
      <span
        className={cn(
          'relative truncate font-bold',
          paint.light ? 'text-[#1d1d1f]' : 'text-white'
        )}
      >
        {label}
      </span>
    </div>
  );
}
