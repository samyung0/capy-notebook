import { useMemo, useRef, useState } from 'react';
import { useTags } from '@/api/hooks';
import type { Tag, TagInput } from '@/api/types';
import { cn } from '@/lib/cn';
import { Badge } from './Badge';
import { Icon } from './Icon';
import { IconButton } from './IconButton';

const MAX_LEN = 50;

type Option =
  | { type: 'create'; value: string }
  | { type: 'existing'; tag: Tag };

export interface TagSelectProps {
  invalid?: boolean;
  /** Tag catalog scope — 'workspace' | 'quiz' | 'card'. */
  kind?: string;
  onChange: (next: TagInput[]) => void;
  placeholder?: string;
  value: TagInput[];
}

/**
 * Tag editor with reuse-aware autocomplete. Selected tags render as removable
 * chips; typing filters the user's existing catalog (loaded once via useTags,
 * filtered client-side). Picking an existing tag carries its `id` so the backend
 * reuses that catalog row (preserving its metadata); creating a new one sends
 * `{ value }` with no id.
 */
export function TagSelect({
  value,
  onChange,
  kind = 'workspace',
  placeholder = 'Search or create a tag…',
  invalid,
}: TagSelectProps) {
  const { data: catalog = [] } = useTags(kind);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selected = value ?? [];
  const selectedKeys = useMemo(
    () => new Set(selected.map((t) => t.value.trim().toLowerCase())),
    [selected]
  );

  const q = query.trim();
  const suggestions = useMemo(() => {
    const ql = q.toLowerCase();
    return catalog.filter(
      (t) =>
        !selectedKeys.has(t.value.toLowerCase()) &&
        (!ql || t.value.toLowerCase().includes(ql))
    );
  }, [catalog, q, selectedKeys]);

  const hasExact =
    q.length > 0 &&
    (selectedKeys.has(q.toLowerCase()) ||
      catalog.some((t) => t.value.toLowerCase() === q.toLowerCase()));
  const canCreate = q.length > 0 && q.length <= MAX_LEN && !hasExact;

  const options: Option[] = [];
  if (canCreate) options.push({ type: 'create', value: q });
  for (const t of suggestions) options.push({ tag: t, type: 'existing' });

  const activeIdx = options.length ? Math.min(active, options.length - 1) : 0;
  const showList = open && options.length > 0;

  function addTag(next: TagInput) {
    const key = next.value.trim().toLowerCase();
    if (!key || selectedKeys.has(key)) return;
    onChange([...selected, { id: next.id, value: next.value.trim() }]);
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
  }

  function removeAt(i: number) {
    onChange(selected.filter((_, idx) => idx !== i));
  }

  function commit(opt: Option) {
    if (opt.type === 'create') addTag({ value: opt.value });
    else addTag({ id: opt.tag.id, value: opt.tag.value });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        if (options.length) commit(options[activeIdx]);
        break;
      case 'ArrowDown':
        e.preventDefault();
        setOpen(true);
        setActive((a) => Math.min(a + 1, options.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
        break;
      case 'Backspace':
        if (query === '' && selected.length) removeAt(selected.length - 1);
        break;
      case 'Escape':
        setOpen(false);
        break;
    }
  }

  return (
    <div className="relative">
      <div
        className={cn(
          't-body flex flex-wrap items-center gap-1.5 rounded-input border border-line bg-surface px-1 py-0.5 transition-[colors,border] duration-150 focus-within:border-line-strong',
          invalid && 'border-2 border-solid-error'
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {selected.map((t, i) => (
          <Badge
            key={`${t.id ?? 'new'}:${t.value}:${i}`}
            size="md"
            tone="neutral"
            // className="inline-flex items-center gap-1 rounded-pill bg-page py-0.5 pr-1 pl-2 text-xs font-bold text-surface-fg"
          >
            # {t.value}
            <IconButton
              aria-label={`Remove ${t.value}`}
              className="-translate-y-px p-0.5"
              icon="x"
              onClick={(e) => {
                e.stopPropagation();
                removeAt(i);
              }}
              size="xs"
              type="button"
              variant="ghost-hover"
            />
          </Badge>
        ))}
        <input
          aria-invalid={invalid}
          autoComplete="off"
          className="min-w-32 flex-1 border-none bg-transparent px-2 py-2 outline-none placeholder:text-placeholder"
          maxLength={MAX_LEN}
          onBlur={() => {
            blurTimer.current = setTimeout(() => setOpen(false), 120);
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={selected.length ? '' : placeholder}
          ref={inputRef}
          value={query}
        />
      </div>

      {showList && (
        <ul
          className="absolute z-50 mt-1.5 max-h-56 w-full overflow-auto rounded-lg border border-line bg-surface p-1 shadow-lg"
          // Keep focus in the input so a click commits before blur closes the list.
          onMouseDown={(e) => {
            e.preventDefault();
            if (blurTimer.current) clearTimeout(blurTimer.current);
          }}
        >
          {options.map((opt, i) => {
            const isActive = i === activeIdx;
            const key = opt.type === 'create' ? '__create__' : opt.tag.id;
            return (
              <li key={key}>
                <button
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm',
                    isActive
                      ? 'bg-surface-hover-bg'
                      : 'hover:bg-surface-hover-bg'
                  )}
                  onClick={() => commit(opt)}
                  onMouseEnter={() => setActive(i)}
                  type="button"
                >
                  {opt.type === 'create' ? (
                    <>
                      <Icon
                        className="size-4 -translate-y-px text-fg-muted"
                        name="plus"
                      />
                      <span>
                        Create{' '}
                        <span className="font-medium">“{opt.value}”</span>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="-translate-y-px text-fg-muted">#</span>
                      <span className="font-medium">{opt.tag.value}</span>
                    </>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
