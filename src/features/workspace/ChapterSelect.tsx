import type { ReactNode } from 'react';
import type { Chapter } from '@/api/types';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

const NO_CHAPTER = '__none__';
const CREATE_CHAPTER = '__create__';
const TYPED_CHAPTER = '__typed__';

// Row pickers copy the code block language trigger: ghost, muted, no chevron.
export function RowPickerTrigger({ children }: { children: ReactNode }) {
  return (
    <SelectTrigger
      className="h-6.5 w-auto translate-y-px bg-transparent px-1.5 py-0 font-semibold text-fg-muted hover:text-fg"
      showDownIcon={false}
      size="sm"
      variant="ghost"
    >
      {children}
    </SelectTrigger>
  );
}

/** A row's chapter: an existing one, none, or (with onCreateRequest) New
 * chapter, which the caller swaps for NewChapterInput. chapterName shows a
 * typed chapter the server creates later. `field` draws a form dropdown
 * instead of the ghost row picker. */
export function ChapterSelect({
  chapters,
  value,
  chapterName,
  disabled,
  field,
  onChange,
  onCreateRequest,
}: {
  chapters: Chapter[];
  value: string | null;
  chapterName?: string | null;
  disabled?: boolean;
  field?: boolean;
  onChange: (value: string | null) => void;
  onCreateRequest?: () => void;
}) {
  const label = (
    // Plain text for "No chapter": SelectValue would copy the option's muted
    // colour and cancel the trigger's hover colour.
    <span className="line-clamp-1 max-w-36">
      {chapterName ?? (value ? <SelectValue /> : m.source_no_chapter())}
    </span>
  );
  return (
    <Select
      disabled={disabled}
      onValueChange={(value) => {
        if (value === CREATE_CHAPTER) {
          onCreateRequest?.();
          return;
        }
        if (value === TYPED_CHAPTER) return;
        onChange(value === NO_CHAPTER ? null : value);
      }}
      // A typed chapter has no id yet; it gets its own item so the list
      // points at it rather than at No chapter.
      value={chapterName ? TYPED_CHAPTER : (value ?? NO_CHAPTER)}
    >
      {field ? (
        <SelectTrigger className="sm:w-56">{label}</SelectTrigger>
      ) : (
        <RowPickerTrigger>{label}</RowPickerTrigger>
      )}
      <SelectContent align="end" className={field ? undefined : 'max-w-47'}>
        <SelectGroup>
          <SelectItem size="sm" value={NO_CHAPTER}>
            <span className="text-fg-muted">{m.source_no_chapter()}</span>
          </SelectItem>
          {chapterName && (
            <SelectItem size="sm" value={TYPED_CHAPTER}>
              <span className="line-clamp-1 translate-y-px">{chapterName}</span>
            </SelectItem>
          )}
          {chapters.map((chapter) => (
            <SelectItem key={chapter.id} size="sm" value={chapter.id}>
              <span className="line-clamp-1 translate-y-px">
                {chapter.name}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
        {onCreateRequest && (
          <>
            <SelectSeparator />
            <SelectGroup className="scroll-my-0">
              <SelectItem size="sm" value={CREATE_CHAPTER}>
                <span className="flex items-center gap-1.5">
                  <Icon className="-translate-y-px" name="plus" size={12} />
                  {m.source_new_chapter()}
                </span>
              </SelectItem>
            </SelectGroup>
          </>
        )}
      </SelectContent>
    </Select>
  );
}

/** The name field New chapter opens: Enter or the check confirms a non-blank
 * name, Escape cancels. */
export function NewChapterInput({
  field,
  value,
  onChange,
  onConfirm,
  onCancel,
}: {
  /** Full-size input matching ChapterSelect's `field` dropdown. */
  field?: boolean;
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className={cn('flex items-center', field && 'gap-1 sm:w-56')}>
      <Input
        autoFocus
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            // Inside a form dialog, Enter names the chapter, not submits.
            event.preventDefault();
            onConfirm();
          }
          if (event.key === 'Escape') onCancel();
        }}
        placeholder={m.source_new_chapter_name()}
        size={field ? 'md' : 'sm'}
        value={value}
        variant={field ? 'light' : 'underline'}
        wrapperClassName={field ? 'min-w-0 flex-1' : undefined}
      />
      <IconButton
        disabled={!value.trim()}
        icon="check"
        label={m.source_create_chapter()}
        onClick={onConfirm}
        size={field ? 'sm' : 'xs'}
        variant="ghost-hover"
      />
    </div>
  );
}

/** A typed chapter name as the server files it: an existing chapter of that
 * name in any case, else a new one created with the item. */
export function chapterByName(chapters: Chapter[] | undefined, name: string) {
  const existing = chapters?.find(
    (chapter) => chapter.name.toLowerCase() === name.toLowerCase()
  );
  return {
    chapterId: existing?.id ?? null,
    chapterName: existing ? null : name,
  };
}
