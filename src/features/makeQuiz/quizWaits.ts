import { useQueries } from '@tanstack/react-query';
import { useEffect } from 'react';
import { create } from 'zustand';
import { filesQuery } from '@/api/hooks';
import type { SourceFile } from '@/api/types';
import { userToast } from '@/components/ui/userToast';
import {
  type SourceTransfer,
  useSourceTransfers,
} from '@/features/workspace/sourceTransfers';
import { m } from '@/i18n';
import { isReadingFile } from './makeQuiz';
import { quizRunLinks } from './quizRuns';

/** A chosen file, by its upload's row until it has an id. */
export interface WaitingFile {
  fileId?: string;
  key: string;
}

/** Files still reading when Continue was pressed (Epo 2026-11-05, "upload might take a
 * while"): the dialog has closed, and the panel follows them until the pages can open. */
export interface QuizWait {
  announced: boolean;
  answers: WaitingFile[];
  id: string;
  paper: WaitingFile[];
  title: string;
  workspaceId: string;
}

export const useQuizWaits = create<{ waits: QuizWait[] }>(() => ({
  waits: [],
}));

export function addQuizWait(wait: Omit<QuizWait, 'announced' | 'id'>) {
  useQuizWaits.setState((state) => ({
    waits: [
      ...state.waits,
      { ...wait, announced: false, id: crypto.randomUUID() },
    ],
  }));
}

function removeQuizWait(id: string) {
  useQuizWaits.setState((state) => ({
    waits: state.waits.filter((wait) => wait.id !== id),
  }));
}

type FileState = 'failed' | 'gone' | 'read' | 'reading';

/** Where a chosen file has got. A failed upload has no file; a file that ended without
 * text is read as far as it will be, and the pages say so. */
export function waitingFileState(
  row: WaitingFile,
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

export interface QuizWaitState {
  answers: string[];
  paper: string[];
  reading: boolean;
  wait: QuizWait;
}

export function openQuizWait({ answers, paper, wait }: QuizWaitState) {
  removeQuizWait(wait.id);
  quizRunLinks()?.pickAgain({
    answers,
    id: wait.id,
    paper,
    workspaceId: wait.workspaceId,
  });
}

/** Follows every wait, whichever page is open: the panel draws them, a toast says when
 * one is ready, and a wait with no question file left ends with an error. */
export function useQuizWaitStates(): QuizWaitState[] {
  const waits = useQuizWaits((state) => state.waits);
  const transfers = useSourceTransfers((state) => state.transfers);
  const workspaces = [...new Set(waits.map((wait) => wait.workspaceId))];
  const lists = useQueries({
    queries: workspaces.map((workspaceId) => ({
      ...filesQuery(workspaceId),
      refetchInterval: 4000,
    })),
  });
  const states = waits.map((wait): QuizWaitState & { lost: boolean } => {
    const files = lists[workspaces.indexOf(wait.workspaceId)]?.data;
    const stateOf = (row: WaitingFile) =>
      waitingFileState(
        row,
        transfers.find((item) => item.key === row.key),
        files
      );
    const idOf = (row: WaitingFile) =>
      row.fileId ?? transfers.find((item) => item.key === row.key)?.fileId;
    const all = [...wait.paper, ...wait.answers];
    return {
      // A failed answer file still goes: the pages and the dialog name it.
      answers: wait.answers
        .filter((row) => ['failed', 'read'].includes(stateOf(row)))
        .flatMap((row) => idOf(row) ?? []),
      lost: all.every((row) => stateOf(row) !== 'reading')
        ? !wait.paper.some((row) => stateOf(row) === 'read')
        : false,
      paper: wait.paper
        .filter((row) => stateOf(row) === 'read')
        .flatMap((row) => idOf(row) ?? []),
      reading: all.some((row) => stateOf(row) === 'reading'),
      wait,
    };
  });
  // An id learned now outlives its transfer's row, which the panel may let go.
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
  useEffect(() => {
    for (const state of states) {
      if (state.reading) continue;
      if (state.lost) {
        removeQuizWait(state.wait.id);
        userToast({
          description: state.wait.title,
          title: m.make_quiz_cannot_extract(),
          variant: 'error',
        });
      } else if (!state.wait.announced) {
        useQuizWaits.setState(({ waits: all }) => ({
          waits: all.map((wait) =>
            wait.id === state.wait.id ? { ...wait, announced: true } : wait
          ),
        }));
        userToast({
          button: {
            label: m.make_quiz_choose_pages_action(),
            onClick: () => openQuizWait(state),
          },
          description: state.wait.title,
          title: m.make_quiz_files_ready(),
          variant: 'success',
        });
      }
    }
  });
  return states;
}
