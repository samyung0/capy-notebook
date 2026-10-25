import { useState } from 'react';
import type { Chapter, MaterialRef, SourceFile } from '@/api/types';
import { checkboxVariants } from '@/components/ui/Checkbox';
import { FileIcon } from '@/components/ui/FileIcon';
import { Icon } from '@/components/ui/Icon';
import { InputTitle } from '@/components/ui/Input';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { readingOrder } from './workspaceContent';

type SourceItem = {
  id: string;
  name: string;
  icon: ReturnType<typeof fileIconName>;
};

/** A chapter (id) or the unfiled items (null) with the items it offers. */
export type SourceGroup = {
  id: string | null;
  name: string;
  items: SourceItem[];
};

/** The pickable sources by chapter in reading order: indexed files and notes,
 * the items a generate run can read (the server also accepts other materials
 * but they hold no source text). Chapters with none are left out. */
export function sourceGroups(
  chapters: Chapter[],
  files: SourceFile[],
  materials: MaterialRef[]
): SourceGroup[] {
  const items = readingOrder(
    chapters,
    files.filter((f) => f.indexed),
    materials.filter((mt) => mt.type === 'note')
  );
  const groupOf = (chapterId: string | null) =>
    items
      .filter((it) => it.data.chapterId === chapterId)
      .map(
        (it): SourceItem =>
          it.type === 'file'
            ? { icon: fileIconName(it.data), id: it.id, name: it.data.name }
            : {
                icon: materialIconName(it.data.type),
                id: it.id,
                name: it.data.title,
              }
      );
  return [
    ...[...chapters]
      .sort((a, b) => a.order - b.order)
      .map((ch) => ({ id: ch.id, items: groupOf(ch.id), name: ch.name })),
    { id: null, items: groupOf(null), name: m.nav_section_others() },
  ].filter((g) => g.items.length > 0);
}

/** The generate request's scope for a pick: nothing for the whole workspace,
 * fully ticked chapters by id and every other ticked item by id (the server
 * takes their union). */
export function scopeOf(groups: SourceGroup[], picked: ReadonlySet<string>) {
  const all = groups.flatMap((g) => g.items);
  if (all.every((it) => picked.has(it.id)))
    return { chapters: [], fileIds: [] };
  const chapters: string[] = [];
  const fileIds: string[] = [];
  for (const g of groups) {
    if (g.id && g.items.every((it) => picked.has(it.id))) chapters.push(g.id);
    else for (const it of g.items) if (picked.has(it.id)) fileIds.push(it.id);
  }
  return { chapters, fileIds };
}

/** AI generate's Sources: Whole workspace, each chapter and Others as tick
 * rows, a chapter's items under its chevron. A tick covers the row's items,
 * and a row with only some of them ticked shows a dash. */
export function GenerateSources({
  groups,
  picked,
  onChange,
}: {
  groups: SourceGroup[];
  picked: ReadonlySet<string>;
  onChange: (picked: ReadonlySet<string>) => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string | null>>(() => new Set());
  const total = groups.reduce((n, g) => n + g.items.length, 0);

  const row = (
    ids: string[],
    label: string,
    { icon, className }: { icon?: React.ReactNode; className?: string } = {},
    count?: number
  ) => {
    const ticked = ids.filter((id) => picked.has(id)).length;
    const all = ids.length > 0 && ticked === ids.length;
    const mixed = !all && ticked > 0;
    return (
      <button
        aria-checked={all ? true : mixed ? 'mixed' : false}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2.5 rounded-button px-1.5 py-1.5 text-left hover:bg-surface-hover-bg',
          className
        )}
        onClick={() => {
          const next = new Set(picked);
          for (const id of ids) {
            if (all) next.delete(id);
            else next.add(id);
          }
          onChange(next);
        }}
        role="checkbox"
        type="button"
      >
        <span
          className={cn(
            checkboxVariants({ checked: all || mixed }),
            'size-5 shrink-0'
          )}
        >
          {(all || mixed) && (
            <Icon name={all ? 'check' : 'minus'} size={14} strokeWidth={2.4} />
          )}
        </span>
        {icon}
        <span className="min-w-0 flex-1 translate-y-px truncate">{label}</span>
        {count !== undefined && (
          <span className="t-meta shrink-0 text-fg-muted">{count}</span>
        )}
      </button>
    );
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <InputTitle>{m.generate_sources()}</InputTitle>
        <span className="t-meta text-fg-muted">
          {picked.size === total
            ? m.generate_sources_all({ count: total })
            : m.generate_sources_some({ count: total, picked: picked.size })}
        </span>
      </div>
      <div className="flex max-h-58 flex-col overflow-y-auto border-divider border-y py-1">
        {row(
          groups.flatMap((g) => g.items.map((it) => it.id)),
          m.generate_whole_workspace(),
          { className: 'font-semibold' }
        )}
        {groups.map((g) => {
          const expanded = open.has(g.id);
          return (
            <div className="flex flex-col" key={g.id ?? 'others'}>
              <div className="flex items-center gap-0.5">
                {row(
                  g.items.map((it) => it.id),
                  g.name,
                  {
                    icon: g.id && (
                      <Icon
                        className="shrink-0 text-fg-secondary"
                        name="chapter"
                        size={15}
                      />
                    ),
                  },
                  g.items.length
                )}
                <button
                  aria-expanded={expanded}
                  aria-label={m.generate_show_chapter_items({
                    chapter: g.name,
                  })}
                  className="grid size-7 shrink-0 place-items-center rounded-button text-fg-muted hover:bg-surface-hover-bg"
                  onClick={() => {
                    const next = new Set(open);
                    if (expanded) next.delete(g.id);
                    else next.add(g.id);
                    setOpen(next);
                  }}
                  type="button"
                >
                  <Icon name={expanded ? 'chevronDown' : 'chevronRight'} />
                </button>
              </div>
              {expanded &&
                g.items.map((it) => (
                  <div className="flex pr-7.5" key={it.id}>
                    {row([it.id], it.name, {
                      className: 'pl-8.5 font-normal',
                      icon: (
                        <FileIcon
                          className="size-3.75 shrink-0"
                          name={it.icon}
                        />
                      ),
                    })}
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
