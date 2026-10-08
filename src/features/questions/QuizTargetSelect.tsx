import { useInfiniteQuery } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { ownedMaterialsQuery } from '@/api/hooks';
import type { MaterialListItem } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/Popover';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

export type QuizTarget =
  | { kind: 'existing'; quiz: MaterialListItem }
  | { kind: 'new'; name: string };

type Option =
  | { type: 'create'; name: string }
  | { type: 'existing'; quiz: MaterialListItem };

export const quizTargetName = (target: QuizTarget) =>
  target.kind === 'new' ? target.name : target.quiz.title;

/**
 * One quiz of a workspace, picked like TagSelect but single-valued: the pick's
 * name sits in the input. Typing renames a new quiz, or else clears the pick
 * and filters the quizzes;
 * Enter on "New quiz: …" names a quiz the copy creates. The list loads on first
 * open.
 */
export function QuizTargetSelect({
  disabled,
  invalid,
  onChange,
  value,
  workspaceId,
}: {
  disabled?: boolean;
  invalid?: boolean;
  onChange: (next: QuizTarget | null) => void;
  value: QuizTarget | null;
  workspaceId: string;
}) {
  const [query, setQuery] = useState(value ? quizTargetName(value) : '');
  // Typed text filters the list; a pick keeps it until the list reopens, so
  // the closing list doesn't redraw.
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const [active, setActive] = useState(0);
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  // The Create page's list carries each quiz's chapter name and question count.
  const {
    data: quizPages,
    isPending,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    ...ownedMaterialsQuery({
      kinds: ['quiz'],
      locations: ['workspace'],
      scope: 'member',
      workspaceIds: [workspaceId],
    }),
    enabled: opened && !!workspaceId,
  });
  const quizzes = quizPages?.pages.flatMap((page) => page.items) ?? [];

  const q = filter.trim();
  const ql = q.toLowerCase();
  const options: Option[] = [];
  if (q && !quizzes.some((quiz) => quiz.title.toLowerCase() === ql))
    options.push({ name: q, type: 'create' });
  for (const quiz of quizzes)
    if (!ql || quiz.title.toLowerCase().includes(ql))
      options.push({ quiz, type: 'existing' });

  const activeIdx = options.length ? Math.min(active, options.length - 1) : 0;
  const showList = open && (isPending || options.length > 0);

  function show() {
    // Reopened on a pick: list every quiz again.
    if (!open && value) setFilter('');
    setOpen(true);
    setOpened(true);
  }

  function clear() {
    setQuery('');
    setFilter('');
    onChange(null);
    inputRef.current?.focus();
    show();
  }

  function commit(option: Option) {
    const next: QuizTarget =
      option.type === 'create'
        ? { kind: 'new', name: option.name }
        : { kind: 'existing', quiz: option.quiz };
    onChange(next);
    setQuery(quizTargetName(next));
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'Enter':
        // Inside the form dialog, Enter picks, never submits.
        event.preventDefault();
        if (showList && options.length) commit(options[activeIdx]);
        break;
      case 'ArrowDown':
        event.preventDefault();
        show();
        setActive((a) =>
          open ? Math.max(0, Math.min(a + 1, options.length - 1)) : 0
        );
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
        break;
      case 'Escape':
        if (showList) {
          event.preventDefault();
          event.stopPropagation();
        }
        setOpen(false);
        break;
    }
  }

  return (
    <Popover onOpenChange={setOpen} open={showList}>
      <PopoverAnchor asChild>
        <div
          className={cn(
            'flex items-center gap-2 rounded-input border border-line bg-field pr-2 pl-3.5 transition-colors duration-150 focus-within:border-action-accent',
            invalid && 'motion-error-shake border-solid-error',
            disabled && 'pointer-events-none bg-field-disabled'
          )}
          onClick={() => {
            inputRef.current?.focus();
            show();
          }}
          ref={setAnchor}
        >
          {value?.kind === 'new' && (
            <Icon
              className="size-4.5 shrink-0 -translate-y-px text-fg-muted"
              name="plus"
            />
          )}
          <input
            aria-activedescendant={
              showList && options.length ? `${listId}-${activeIdx}` : undefined
            }
            aria-autocomplete="list"
            aria-controls={showList ? listId : undefined}
            aria-expanded={showList}
            aria-invalid={invalid}
            aria-label={m.question_ui_quiz_name()}
            autoComplete="off"
            className="min-w-0 flex-1 border-none bg-transparent py-2.5 outline-none placeholder:text-placeholder"
            disabled={disabled}
            onBlur={() => setOpen(false)}
            onChange={(event) => {
              const text = event.target.value;
              setQuery(text);
              // Editing a new quiz's name renames it; anything else searches.
              if (value?.kind === 'new' && text.trim()) {
                onChange({ kind: 'new', name: text });
                setOpen(false);
                return;
              }
              setFilter(text);
              if (value) onChange(null);
              show();
              setActive(0);
            }}
            onFocus={show}
            onKeyDown={onKeyDown}
            placeholder={m.question_ui_quiz_search()}
            ref={inputRef}
            role="combobox"
            value={query}
          />
          {query && !disabled && (
            <IconButton
              className="shrink-0 text-fg-muted"
              icon="x"
              label={m.question_ui_clear_quiz()}
              onClick={(event) => {
                event.stopPropagation();
                clear();
              }}
              size="sm"
              variant="ghost-hover"
            />
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        alignWidthToTrigger
        aria-hidden={!showList || undefined}
        aria-label={m.question_ui_quiz()}
        className="max-h-(--tag-dropdown-height) gap-0 overflow-auto rounded-xl p-1 shadow-lg!"
        // Keep the list inside the modal's allowed scroll area.
        container={anchor?.closest('[data-slot="dialog-content"]')}
        id={listId}
        inert={!showList}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (event.target instanceof Node && anchor?.contains(event.target))
            event.preventDefault();
        }}
        onOpenAutoFocus={(event) => event.preventDefault()}
        role="listbox"
        sideOffset={6}
      >
        {isPending ? (
          <SkeletonList className="gap-1.5 p-1.5" count={3} rowHeight={32} />
        ) : (
          <ul
            // Keep focus in the input so a click commits before blur closes the list.
            onMouseDown={(event) => event.preventDefault()}
            role="presentation"
          >
            {options.map((option, i) => {
              const picked =
                option.type === 'existing' &&
                value?.kind === 'existing' &&
                value.quiz.id === option.quiz.id;
              return (
                <li
                  key={option.type === 'create' ? '__create__' : option.quiz.id}
                  role="presentation"
                >
                  <button
                    aria-selected={i === activeIdx}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm',
                      option.type === 'create' ? 'h-8' : 'h-9',
                      i === activeIdx
                        ? 'bg-surface-hover-bg'
                        : 'hover:bg-surface-hover-bg'
                    )}
                    id={`${listId}-${i}`}
                    onClick={() => commit(option)}
                    onMouseEnter={() => setActive(i)}
                    role="option"
                    tabIndex={-1}
                    type="button"
                  >
                    {option.type === 'create' ? (
                      <>
                        <Icon
                          className="size-3.5 shrink-0 -translate-y-px text-fg-muted"
                          name="plus"
                        />
                        <span className="t-meta min-w-0 truncate text-fg-muted">
                          {m.question_ui_create_quiz({ name: option.name })}
                        </span>
                      </>
                    ) : (
                      <>
                        <span
                          className={cn(
                            'min-w-0 truncate font-medium',
                            picked && 'font-bold'
                          )}
                        >
                          {option.quiz.title}
                        </span>
                        {option.quiz.chapterName && (
                          <span className="t-meta max-w-40 shrink-0 truncate text-fg-muted">
                            {option.quiz.chapterName}
                          </span>
                        )}
                        <span className="t-meta ml-auto shrink-0 text-fg-muted">
                          {option.quiz.questionCount === 1
                            ? m.question_ui_one_question()
                            : m.question_ui_question_count({
                                count: option.quiz.questionCount ?? 0,
                              })}
                        </span>
                        {picked && (
                          <Icon className="size-3.75 shrink-0" name="check" />
                        )}
                      </>
                    )}
                  </button>
                </li>
              );
            })}
            {hasNextPage && (
              <li className="flex justify-center" role="presentation">
                <Button
                  disabled={isFetchingNextPage}
                  onClick={() => fetchNextPage()}
                  size="sm"
                  variant="ghost-hover"
                >
                  {m.list_load_more()}
                </Button>
              </li>
            )}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
