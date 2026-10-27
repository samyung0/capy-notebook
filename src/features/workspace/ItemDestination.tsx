import { useState } from 'react';
import { useChapters, useWorkspaces } from '@/api/hooks';
import { SettingRow } from '@/components/app/tabPanel';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { iconUrl } from '@/lib/icon-catalog';
import {
  ChapterSelect,
  chapterByName,
  FIELD_WIDTH,
  NewChapterInput,
} from './ChapterSelect';

const STANDALONE = '__standalone__';

type ChapterPick = { chapterId: string | null; chapterName: string | null };

/**
 * Where Clone to… and Move to… put an item: a workspace the user edits (or,
 * with `standalone`, No workspace) and a chapter there. The item's own
 * workspace is picked when the user edits it, and in it the item's chapter;
 * else the first workspace they edit (a standalone clone stays standalone).
 */
export function useItemDestination({
  chapterId,
  standalone,
  workspaceId: source,
}: {
  /** The item's chapter, preselected while its workspace is picked. */
  chapterId?: string | null;
  /** Offers No workspace (Clone to…). */
  standalone: boolean;
  /** The item's workspace; empty for a standalone item. */
  workspaceId: string;
}) {
  const { data: workspaces, isPending } = useWorkspaces();
  const editable = (workspaces ?? []).filter((ws) => ws.capabilities.canEdit);
  const [picked, setPicked] = useState('');
  const fallback = standalone && !source ? STANDALONE : (editable[0]?.id ?? '');
  const destination =
    picked ||
    (editable.some((ws) => ws.id === source)
      ? source
      : fallback || (standalone ? STANDALONE : ''));
  const workspaceId = destination === STANDALONE ? '' : destination;
  const { data: chapters } = useChapters(workspaceId);
  // A chapter the user chose, for the workspace it belongs to.
  const [chosen, setChosen] = useState<
    (ChapterPick & { workspaceId: string }) | null
  >(null);
  const [newChapter, setNewChapter] = useState<string | null>(null);
  const chapter: ChapterPick =
    chosen?.workspaceId === workspaceId
      ? chosen
      : {
          chapterId: workspaceId === source ? (chapterId ?? null) : null,
          chapterName: null,
        };

  return {
    chapter,
    chapters,
    destination,
    editable,
    newChapter,
    pending: isPending,
    /** Picks a workspace (or STANDALONE): its chapter starts over. */
    pick(id: string) {
      setPicked(id);
      setNewChapter(null);
    },
    /** The chosen chapter, a name still being typed included. */
    resolve(): ChapterPick {
      const typed = newChapter?.trim();
      return typed ? chapterByName(chapters, typed) : chapter;
    },
    setChapter: (next: ChapterPick) => setChosen({ ...next, workspaceId }),
    setNewChapter,
    source,
    sourceChapterId: chapterId ?? null,
    standalone,
    workspaceId,
  };
}

export type ItemDestination = ReturnType<typeof useItemDestination>;

/** The workspace and chapter dropdowns. `markCurrent` (Move to…) tags the
 * item's own workspace and chapter "Current". */
export function DestinationFields({
  dest,
  disabled,
  markCurrent = false,
  onPick,
}: {
  dest: ItemDestination;
  disabled: boolean;
  markCurrent?: boolean;
  /** After the user picks a workspace. */
  onPick?: () => void;
}) {
  const { workspaceId } = dest;
  const current = m.destination_current();
  return (
    <>
      <SettingRow title={m.question_ui_workspace()}>
        <Select
          onValueChange={(id) => {
            // The form's hidden native select reports '' while options load.
            if (!id) return;
            dest.pick(id);
            onPick?.();
          }}
          value={dest.destination}
        >
          <SelectTrigger
            aria-label={m.question_ui_workspace()}
            className={FIELD_WIDTH}
            disabled={dest.pending || disabled}
            layout="row"
            loading={dest.pending}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {dest.standalone && (
              <SelectItem value={STANDALONE}>
                <span className="text-fg-muted">{m.clone_no_workspace()}</span>
              </SelectItem>
            )}
            {dest.editable.map((ws) => (
              <SelectItem
                hint={markCurrent && ws.id === dest.source ? current : null}
                key={ws.id}
                value={ws.id}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <img
                    alt=""
                    className="size-5 shrink-0 -translate-y-px rounded-md"
                    src={iconUrl(ws.iconId)}
                  />
                  <span className="truncate">{ws.name}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      {/* Hidden, not removed, without a workspace: no layout shift. */}
      <div
        aria-hidden={!workspaceId}
        className={cn(!workspaceId && 'invisible')}
      >
        <SettingRow title={m.question_ui_chapter()}>
          {dest.newChapter === null ? (
            <ChapterSelect
              chapterName={dest.chapter.chapterName}
              chapters={dest.chapters ?? []}
              current={
                markCurrent && workspaceId === dest.source
                  ? dest.sourceChapterId
                  : undefined
              }
              disabled={!workspaceId || disabled}
              field
              onChange={(chapterId) =>
                dest.setChapter({ chapterId, chapterName: null })
              }
              onCreateRequest={() => dest.setNewChapter('')}
              value={dest.chapter.chapterId}
            />
          ) : (
            <NewChapterInput
              field
              onCancel={() => dest.setNewChapter(null)}
              onChange={dest.setNewChapter}
              onConfirm={() => {
                const name = dest.newChapter?.trim();
                if (!name) return;
                dest.setChapter(chapterByName(dest.chapters, name));
                dest.setNewChapter(null);
              }}
              value={dest.newChapter}
            />
          )}
        </SettingRow>
      </div>
    </>
  );
}
