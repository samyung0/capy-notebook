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

const NO_CHAPTER = '__none__';
const CREATE_CHAPTER = '__create__';

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
 * typed chapter the server creates later. */
export function ChapterSelect({
  chapters,
  value,
  chapterName,
  onChange,
  onCreateRequest,
}: {
  chapters: Chapter[];
  value: string | null;
  chapterName?: string | null;
  onChange: (value: string | null) => void;
  onCreateRequest?: () => void;
}) {
  return (
    <Select
      onValueChange={(value) => {
        if (value === CREATE_CHAPTER) {
          onCreateRequest?.();
          return;
        }
        onChange(value === NO_CHAPTER ? null : value);
      }}
      value={value ?? NO_CHAPTER}
    >
      <RowPickerTrigger>
        {/* Plain text for "No chapter": SelectValue would copy the option's
            muted colour and cancel the trigger's hover colour. */}
        <span className="line-clamp-1 max-w-36">
          {chapterName ?? (value ? <SelectValue /> : m.source_no_chapter())}
        </span>
      </RowPickerTrigger>
      <SelectContent align="end" className="max-w-47">
        <SelectGroup>
          <SelectItem size="sm" value={NO_CHAPTER}>
            <span className="text-fg-muted">{m.source_no_chapter()}</span>
          </SelectItem>
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
  value,
  onChange,
  onConfirm,
  onCancel,
}: {
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center">
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
        size="sm"
        value={value}
        variant="underline"
      />
      <IconButton
        disabled={!value.trim()}
        icon="check"
        label={m.source_create_chapter()}
        onClick={onConfirm}
        size="xs"
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
