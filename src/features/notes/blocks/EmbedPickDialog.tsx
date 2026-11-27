import { useEffect, useState } from 'react';
import { useOwnedFiles, useOwnedMaterials } from '@/api/hooks';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { SearchInput } from '@/components/ui/SearchInput';
import {
  PickList,
  type PickRow,
  paperFileRows,
} from '@/features/study/assignments/ExistingQuizPicker';
import { sizeLabel } from '@/features/study/practice/practiceText';
import { m } from '@/i18n';
import { materialIconName } from '@/lib/fileIcons';

/** What a note's pick dialog lists: the quizzes, flashcard sets or films. */
export type EmbedPickKind = 'quiz' | 'flashcards' | 'film';

const TITLE = {
  film: () => m.editor_film(),
  flashcards: () => m.editor_flashcards(),
  quiz: () => m.editor_quiz(),
};
const SEARCH = {
  film: () => m.embed_pick_search_films(),
  flashcards: () => m.embed_pick_search_flashcards(),
  quiz: () => m.embed_pick_search_quizzes(),
};

/** Where a note sits: its workspace's items, or the person's own items in no
 * workspace for a note in none (Epo 2026-11-27). */
const scopeOf = (workspaceId: string) =>
  workspaceId
    ? { scope: 'member' as const, workspaceIds: [workspaceId] }
    : { locations: ['standalone' as const], scope: 'member' as const };

/** Every page of a list, read on until its end: a pick list searches all. */
function useAllPages<T>(query: {
  data?: { pages: { items: T[] }[] };
  error: unknown;
  fetchNextPage: () => unknown;
  hasNextPage: boolean;
  isError: boolean;
  isFetchingNextPage: boolean;
  refetch: () => unknown;
}) {
  const { data, fetchNextPage, hasNextPage, isError, isFetchingNextPage } =
    query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isError, isFetchingNextPage]);
  return data && !hasNextPage
    ? data.pages.flatMap((page) => page.items)
    : undefined;
}

function useMaterialRows(kind: 'quiz' | 'flashcards', workspaceId: string) {
  const list = useOwnedMaterials({ kinds: [kind], ...scopeOf(workspaceId) });
  const items = useAllPages(list);
  const rows: PickRow[] | undefined = items
    ?.filter((item) => !item.lostAccess)
    .map((item) => ({
      icon: materialIconName(kind),
      id: item.id,
      meta: item.hidden
        ? m.assignment_paper_hidden()
        : sizeLabel(
            kind,
            (kind === 'quiz' ? item.questionCount : item.cardCount) ?? 0
          ),
      name: item.title,
    }));
  return { list, rows };
}

function useFilmRows(workspaceId: string) {
  const list = useOwnedFiles({ kinds: ['film'], ...scopeOf(workspaceId) });
  const items = useAllPages(list);
  return { list, rows: items && paperFileRows(items) };
}

type PickProps = {
  onClose: () => void;
  onCreate?: () => void;
  onInsert: (id: string) => Promise<void> | void;
  /** The note's workspace, '' for a note in none. */
  workspaceId: string;
};

/** A note's Quiz, Flashcards or Film (Epo 2026-11-27, mock A): the Existing
 * file dialog's search and pick list over what the note's workspace holds.
 * Insert hands on the one picked; a quiz or set may instead be made new
 * (`onCreate`), as the one-click insert does when the workspace holds none. */
export function EmbedPickDialog({
  kind,
  ...props
}: PickProps & { kind: EmbedPickKind }) {
  return kind === 'film' ? (
    <FilmPick {...props} />
  ) : (
    <MaterialPick kind={kind} {...props} />
  );
}

function FilmPick(props: PickProps) {
  const { list, rows } = useFilmRows(props.workspaceId);
  return <PickDialog kind="film" list={list} rows={rows} {...props} />;
}

function MaterialPick({
  kind,
  ...props
}: PickProps & { kind: 'quiz' | 'flashcards' }) {
  const { list, rows } = useMaterialRows(kind, props.workspaceId);
  return <PickDialog kind={kind} list={list} rows={rows} {...props} />;
}

function PickDialog({
  kind,
  list,
  onClose,
  onCreate,
  onInsert,
  rows,
}: PickProps & {
  kind: EmbedPickKind;
  list: { error: unknown; isError: boolean; refetch: () => unknown };
  /** Undefined while loading. */
  rows: PickRow[] | undefined;
}) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string>();
  const [inserting, setInserting] = useState(false);
  const insert = () => {
    if (!picked) return;
    setInserting(true);
    // A refusal is said by the mutation's own toast; the dialog stays.
    Promise.resolve(onInsert(picked))
      .then(onClose, () => undefined)
      .finally(() => setInserting(false));
  };
  return (
    <SimpleDialog
      action={
        <Button
          disabled={!picked || inserting}
          onClick={insert}
          size="md"
          type="button"
        >
          {inserting ? <Spinner /> : m.action_insert()}
        </Button>
      }
      compactFooter
      onClose={onClose}
      open
      pending={inserting}
      title={TITLE[kind]()}
      width={600}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <SearchInput
          aria-label={SEARCH[kind]()}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={SEARCH[kind]()}
          value={query}
          wrapperClassName="h-8 min-w-0"
        />
        <div className="mt-2 min-h-60 flex-1 overflow-y-auto">
          <PickList
            empty={kind === 'film' ? m.film_none() : undefined}
            failed={
              list.isError
                ? { error: list.error, retry: () => void list.refetch() }
                : undefined
            }
            label={TITLE[kind]()}
            onPick={setPicked}
            picked={picked}
            query={query}
            rows={rows}
          />
          {/* Right under the last row (Epo 2026-11-27). */}
          {onCreate && (
            <Button
              className="mt-2"
              disabled={inserting}
              onClick={() => {
                onCreate();
                onClose();
              }}
              size="md"
              type="button"
              variant="outline"
            >
              <Icon name="plus" />
              {m.embed_pick_create_new()}
            </Button>
          )}
        </div>
      </div>
    </SimpleDialog>
  );
}
