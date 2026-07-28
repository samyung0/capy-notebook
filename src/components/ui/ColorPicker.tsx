import { Check, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

export interface ColorOption {
  name: string;
  value: string;
}

export const DOCUMENT_COLORS: readonly ColorOption[] = [
  { name: 'Black', value: '#000000' },
  { name: 'Charcoal', value: '#434343' },
  { name: 'Dark gray', value: '#666666' },
  { name: 'Gray', value: '#999999' },
  { name: 'Silver', value: '#b7b7b7' },
  { name: 'Light gray', value: '#cccccc' },
  { name: 'Cloud', value: '#eeeeee' },
  { name: 'White', value: '#ffffff' },
  { name: 'Dark red', value: '#991b1b' },
  { name: 'Dark orange', value: '#9a3412' },
  { name: 'Dark yellow', value: '#a16207' },
  { name: 'Dark green', value: '#3f6212' },
  { name: 'Dark teal', value: '#0f766e' },
  { name: 'Dark blue', value: '#1d4ed8' },
  { name: 'Dark purple', value: '#6d28d9' },
  { name: 'Dark pink', value: '#9d174d' },
  { name: 'Red', value: '#dc2626' },
  { name: 'Orange', value: '#ea580c' },
  { name: 'Yellow', value: '#ca8a04' },
  { name: 'Green', value: '#65a30d' },
  { name: 'Teal', value: '#0d9488' },
  { name: 'Blue', value: '#2563eb' },
  { name: 'Purple', value: '#7c3aed' },
  { name: 'Pink', value: '#db2777' },
  { name: 'Soft red', value: '#fca5a5' },
  { name: 'Soft orange', value: '#fdba74' },
  { name: 'Soft yellow', value: '#fde047' },
  { name: 'Soft green', value: '#bef264' },
  { name: 'Soft teal', value: '#5eead4' },
  { name: 'Soft blue', value: '#93c5fd' },
  { name: 'Soft purple', value: '#c4b5fd' },
  { name: 'Soft pink', value: '#f9a8d4' },
  { name: 'Pale red', value: '#fee2e2' },
  { name: 'Pale orange', value: '#ffedd5' },
  { name: 'Pale yellow', value: '#fef9c3' },
  { name: 'Pale green', value: '#ecfccb' },
  { name: 'Pale teal', value: '#ccfbf1' },
  { name: 'Pale blue', value: '#dbeafe' },
  { name: 'Pale purple', value: '#ede9fe' },
  { name: 'Pale pink', value: '#fce7f3' },
];

const HEX_COLOR_RE = /^#[\da-f]{6}$/i;

export function ColorPicker({
  value,
  onChange,
  onClear,
  colors = DOCUMENT_COLORS,
}: {
  value?: string;
  onChange: (color: string) => void;
  onClear: () => void;
  colors?: readonly ColorOption[];
}) {
  const normalizedValue = value?.toLowerCase();
  const customValue = value && HEX_COLOR_RE.test(value) ? value : '#000000';
  const customLabel =
    normalizedValue && HEX_COLOR_RE.test(normalizedValue)
      ? normalizedValue
      : '';
  const customInputRef = useRef<HTMLInputElement>(null);
  const [customDraft, setCustomDraft] = useState(customLabel);

  useEffect(() => {
    const input = customInputRef.current;
    if (!input) return;

    const updateDraft = () => setCustomDraft(input.value);
    const commitColor = () => onChange(input.value);

    // React normalizes a color input's `onChange` to the native `input`
    // event, which fires continuously while the user drags. Listen for the
    // native `change` event so the document is updated only on commit.
    input.addEventListener('input', updateDraft);
    input.addEventListener('change', commitColor);

    return () => {
      input.removeEventListener('input', updateDraft);
      input.removeEventListener('change', commitColor);
    };
  }, [onChange]);

  useEffect(() => {
    setCustomDraft(customLabel);

    if (customInputRef.current) {
      customInputRef.current.value = customValue;
    }
  }, [customLabel, customValue]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold text-fg-secondary text-xs">
          Document colors
        </span>
        <button
          className="inline-flex h-7 items-center gap-1 rounded-button px-2 text-fg-secondary text-xs outline-none hover:bg-surface-hover-bg hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
          data-plate-prevent-deselect
          onClick={onClear}
          onMouseDown={(event) => event.preventDefault()}
          type="button"
        >
          <RotateCcw className="size-3.5" />
          <span className="translate-y-px">Default</span>
        </button>
      </div>

      <div
        aria-label="Document color palette"
        className="grid grid-cols-8 gap-1.5"
        role="grid"
      >
        {colors.map((color) => {
          const selected = normalizedValue === color.value.toLowerCase();

          return (
            <button
              aria-label={color.name}
              aria-selected={selected}
              className={cn(
                "flex size-6 items-center justify-center rounded-full border border-line-strong outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-focus",
                selected &&
                  "ring-2 ring-action ring-offset-1 ring-offset-surface",
              )}
              data-plate-prevent-deselect
              key={color.value}
              onClick={() => onChange(color.value)}
              onMouseDown={(event) => event.preventDefault()}
              role="gridcell"
              style={{ backgroundColor: color.value }}
              title={`${color.name} (${color.value})`}
              type="button"
            >
              {selected && (
                <Check
                  className={cn(
                    "size-3.5 drop-shadow-sm",
                    isBrightColor(color.value) ? "text-black" : "text-white",
                  )}
                />
              )}
            </button>
          );
        })}
      </div>

      <label className="mt-2 flex items-center justify-between gap-3 border-divider border-t pt-2 font-semibold text-fg-secondary text-xs">
        Custom color
        <span className="flex items-center gap-2 font-mono font-normal text-fg">
          {customDraft}
          <input
            aria-label="Choose a custom color"
            className="h-7 w-9 cursor-pointer rounded-button border border-line bg-transparent p-0.5"
            data-plate-prevent-deselect
            defaultValue={customValue}
            ref={customInputRef}
            type="color"
          />
        </span>
      </label>
    </div>
  );
}

function isBrightColor(hex: string) {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);

  return (red * 299 + green * 587 + blue * 114) / 1000 > 150;
}
