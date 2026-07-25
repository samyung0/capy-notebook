import { cn } from '@/lib/cn';
import { USER_COLORS, userColorPair } from '@/lib/userColor';
import { Icon } from './Icon';

export function UserColorChooser({
  selected,
  onChange,
}: {
  /** Single color, or multiple when multi-selecting. */
  selected?: string | readonly string[];
  onChange: (color: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {USER_COLORS.map((c) => {
        const p = userColorPair(c);
        const isTransparent = c === 'transparent';
        const isSelected = Array.isArray(selected)
          ? selected.includes(c)
          : selected === c;
        return (
          <button
            aria-label={c}
            aria-pressed={isSelected}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-pill transition-transform',
              isTransparent && 'border border-line-strong text-fg-muted',
              isSelected &&
                'ring-2 ring-action ring-offset-2 ring-offset-surface'
            )}
            key={c}
            onClick={() => onChange(c)}
            style={isTransparent ? undefined : { background: p.bg }}
            type="button"
          >
            {isTransparent && <Icon name="x" size={15} />}
          </button>
        );
      })}
    </div>
  );
}
