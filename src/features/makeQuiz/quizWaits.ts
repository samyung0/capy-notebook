import { useQueries } from '@tanstack/react-query';
import { useEffect } from 'react';
import { create } from 'zustand';
import { filesQuery } from '@/api/hooks';
import { isMissing } from '@/api/queryClient';
import type { SourceFile } from '@/api/types';
import { userToast } from '@/components/ui/userToast';
import {
  type SourceTransfer,
  useSourceTransfers,
} from '@/features/workspace/sourceTransfers';
import { m } from '@/i18n';
import { isReadingFile } from './makeQuiz';
import { quizRunLinks } from './quizRuns';
import { type QuizWait, useQuizWaits, type WaitingFile } from './quizWaitStore';

export function addQuizWait(wait: Omit<QuizWait, 'announced' | 'id'>) {
  useQuizWaits.setState((state) => ({
    waits: [
      ...state.waits,
      { ...wait, announced: false, id: crypto.randomUUID() },
    ],
  }));
}

export const quizWaitKeys = ({ answers, paper }: QuizWait) =>
  [...paper, ...answers].map((row) => row.key);

/** The rows every wait still needs: a closed panel or a finished upload keeps them. */
export const allQuizWaitKeys = () =>
  new Set(useQuizWaits.getState().waits.flatMap(quizWaitKeys));

/** Ends a wait along with its finished upload rows, which would show again otherwise. An
 * upload still sending goes on as an ordinary one. */
export function removeQuizWait(wait: QuizWait) {
  const keys = new Set(quizWaitKeys(wait));
  useSourceTransfers.setState(({ transfers }) => ({
    transfers: transfers.filter(
      ({ key, stage }) =>
        !(keys.has(key) && (stage === 'added' || stage === 'failed'))
    ),
  }));
  useQuizWaits.setState((state) => ({
    waits: state.waits.filter((item) => item.id !== wait.id),
  }));
}

type FileState = 'failed' | 'gone' | 'read' | 'reading';

/** Where a chosen file has got. A failed upload has no file; a file with neither a row
 * nor an id never finished sending (a reload ends that), or was removed. */
export function waitingFileState(
  row: Pick<WaitingFile, 'fileId'>,
  transfer: Pick<SourceTransfer, 'fileId' | 'stage'> | undefined,
  files: Pick<SourceFile, 'id' | 'indexed' | 'status'>[] | undefined
): FileState {
  if (transfer?.stage === 'failed') return 'failed';
  const fileId = row.fileId ?? transfer?.fileId;
  if (!fileId) return transfer ? 'reading' : 'gone';
  const file = files?.find((item) => item.id === fileId);
  if (!file) return transfer || !files ? 'reading' : 'gone';
  return isReadingFile(file) && !file.indexed
    ? 'reading'
    : file.indexed
      ? 'read'
      : 'failed';
}

export type QuizWaitStatus = 'failed' | 'reading' | 'ready';

/** The wait goes on past a failed file (Epo 2026-11-09): once every file is through,
 * the quiz can be made from those read, and only every file failing fails it. */
export function quizWaitStatus(states: FileState[]): QuizWaitStatus {
  if (states.includes('reading')) return 'reading';
  return states.includes('read') ? 'ready' : 'failed';
}

/** The files a wait lost, for the dialog to say so when it opens again
 * (Epo 2026-11-09, "an error banner inside the quiz dialog"). */
export const useQuizNotice = create<{
  failures: { name: string; reason: string }[];
}>(() => ({ failures: [] }));
export const clearQuizNotice = () => useQuizNotice.setState({ failures: [] });

export interface QuizWaitState {
  answers: string[];
  failures: { key: string; name: string; reason: string }[];
  paper: string[];
  status: QuizWaitStatus;
  wait: QuizWait;
}

/** Make quiz: on to the pages, or, with any file lost, back on the files with those
 * still good and a notice naming the lost ones; Try again after every file failed opens
 * the files empty. */
export function openQuizWait({
  answers,
  failures,
  paper,
  wait,
}: QuizWaitState) {
  removeQuizWait(wait);
  useQuizNotice.setState({
    failures: failures.map(({ name, reason }) => ({ name, reason })),
  });
  quizRunLinks()?.pickAgain({
    answers,
    id: wait.id,
    paper,
    step: failures.length > 0 ? 'files' : undefined,
    workspaceId: wait.workspaceId,
  });
}

/** Follows every wait, whichever page is open: the panel draws them, and a toast says
 * when one is ready. */
export function useQuizWaitStates(): QuizWaitState[] {
  const waits = useQuizWaits((state) => state.waits);
  const transfers = useSourceTransfers((state) => state.transfers);
  const workspaces = [...new Set(waits.map((wait) => wait.workspaceId))];
  const lists = useQueries({
    queries: workspaces.map((workspaceId) => ({
      ...filesQuery(workspaceId),
      refetchInterval: 4000,
      // The panel sits over every page: a list it can't read mustn't take it down.
      throwOnError: false,
    })),
  });
  const states = waits.map((wait): QuizWaitState => {
    // A list stored from the last visit may not have the file yet, and one that failed
    // says nothing about it unless the workspace is gone.
    const list = lists[workspaces.indexOf(wait.workspaceId)];
    const files = isMissing(list?.error)
      ? []
      : list?.isFetchedAfterMount && !list.error
        ? list.data
        : undefined;
    const transferOf = (row: WaitingFile) =>
      transfers.find((item) => item.key === row.key);
    const stateOf = (row: WaitingFile) =>
      waitingFileState(row, transferOf(row), files);
    const idsOf = (rows: WaitingFile[]) =>
      rows.flatMap((row) => row.fileId ?? transferOf(row)?.fileId ?? []);
    const all = [...wait.paper, ...wait.answers];
    return {
      answers: idsOf(wait.answers),
      failures: all.flatMap((row) => {
        const { key, name } = row;
        const state = stateOf(row);
        if (state === 'gone')
          return [{ key, name, reason: m.source_transfer_not_added() }];
        return state === 'failed'
          ? [
              {
                key,
                name,
                reason: transferOf(row)?.error ?? m.make_quiz_not_readable(),
              },
            ]
          : [];
      }),
      paper: idsOf(wait.paper),
      status: quizWaitStatus(all.map(stateOf)),
      wait,
    };
  });
  // An id learned now outlives the page, whose upload rows a reload loses.
  useEffect(() => {
    let changed = false;
    const learn = (rows: WaitingFile[]) =>
      rows.map((row) => {
        const fileId = transfers.find((item) => item.key === row.key)?.fileId;
        if (row.fileId || !fileId) return row;
        changed = true;
        return { ...row, fileId };
      });
    const next = useQuizWaits.getState().waits.map((wait) => ({
      ...wait,
      answers: learn(wait.answers),
      paper: learn(wait.paper),
    }));
    if (changed) useQuizWaits.setState({ waits: next });
  }, [transfers]);
  // A wait that ends with every file failed leaves the panel: its toast offers Try
  // again (Epo 2026-11-09); the upload rows show their failure as any upload's.
  useEffect(() => {
    for (const state of states) {
      if (state.status === 'reading' || state.wait.announced) continue;
      useQuizWaits.setState(({ waits: all }) => ({
        waits: all.map((wait) =>
          wait.id === state.wait.id ? { ...wait, announced: true } : wait
        ),
      }));
      if (state.status === 'failed') {
        useQuizWaits.setState(({ waits: all }) => ({
          waits: all.filter((wait) => wait.id !== state.wait.id),
        }));
        userToast({
          button: {
            label: m.make_quiz_try_again(),
            onClick: () => openQuizWait(state),
          },
          description: state.wait.title,
          title: m.make_quiz_no_file_read(),
          variant: 'error',
        });
        continue;
      }
      userToast({
        button: {
          label: m.make_quiz_make_action(),
          onClick: () => openQuizWait(state),
        },
        description:
          state.failures.length > 0
            ? m.make_quiz_some_files_failed({
                names: state.failures.map(({ name }) => name).join(', '),
              })
            : state.wait.title,
        title: m.make_quiz_files_ready(),
        variant: state.failures.length > 0 ? 'warning' : 'success',
      });
    }
  });
  return states;
}
