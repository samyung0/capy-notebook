import { createExtractionBodyTitleMax } from '@/api/gen/validators';
import {
  EXTRACTION_FILES_MAX,
  EXTRACTION_PAGES_MAX,
} from '@/api/limits.generated';
import type {
  CreateExtractionReq,
  ExtractionReport,
  SourceFile,
} from '@/api/types';
import { m } from '@/i18n';

/** What Make a quiz reads pages from today: the gateway refuses anything else
 * as a question paper. Office files and text sections wait on how a run sends
 * them (todo-study-tracking.md §8, Page sources by file type). */
export function isPaperFile(file: Pick<SourceFile, 'kind'>) {
  return file.kind === 'pdf' || file.kind === 'image';
}

/** A mark scheme or answers file: anything with indexed text. */
export function isAnswersFile(file: Pick<SourceFile, 'kind'>) {
  return file.kind !== 'audio' && file.kind !== 'unknown';
}

/** A file the menus offer: read, or still being read. A failed file or one
 * stored without parsing can never be read from. */
export function isOfferable(file: Pick<SourceFile, 'indexed' | 'status'>) {
  if (file.status === 'failed') return false;
  return (
    file.indexed || file.status === 'pending' || file.status === 'processing'
  );
}

/** Past the 10-file cap, mark scheme and answer files included (Epo
 * 2026-11-03), Add a file stops offering more. */
export function hasFileRoom(paperCount: number, answerCount: number) {
  return paperCount + answerCount < EXTRACTION_FILES_MAX;
}

/** Board X1's "6 pages, about 60 credits". */
const CREDITS_PER_PAGE = 10;
export const estimatedCredits = (pages: number) => pages * CREDITS_PER_PAGE;

/** One page of the paper, counted from 1 in its own file. */
export interface PaperPage {
  fileId: string;
  page: number;
}
export const pageKey = ({ fileId, page }: PaperPage) => `${fileId}:${page}`;

/** Clicking a page: selected pages go, others join up to the cap. */
export function togglePage(selected: ReadonlySet<string>, key: string) {
  const next = new Set(selected);
  if (!next.delete(key) && next.size < EXTRACTION_PAGES_MAX) next.add(key);
  return next;
}

/** The run's request: pages grouped by file in their own order, each file
 * once. A file with no page selected stays out. */
export function extractionRequest(
  title: string,
  pages: readonly PaperPage[],
  selected: ReadonlySet<string>,
  answerFileIds: readonly string[]
): CreateExtractionReq {
  const byFile = new Map<string, number[]>();
  for (const page of pages) {
    if (!selected.has(pageKey(page))) continue;
    byFile.set(page.fileId, [...(byFile.get(page.fileId) ?? []), page.page]);
  }
  return {
    answerFileIds: [...answerFileIds],
    paper: [...byFile].map(([fileId, list]) => ({ fileId, pages: list })),
    title,
  };
}

const FILE_EXTENSION = /\.[^.]+$/;

/** The quiz takes the paper's name, as board X2 does; a name in use gets the
 * next number, as the server names a quiz that lost its title at the end. */
export function quizTitleFrom(
  fileName: string,
  takenTitles: readonly string[]
): string {
  const base = [...fileName.replace(FILE_EXTENSION, '').trim()]
    .slice(0, createExtractionBodyTitleMax - 4)
    .join('');
  const taken = new Set(takenTitles.map((title) => title.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`.toLowerCase())) n += 1;
  return `${base} ${n}`;
}

/** What a finished run leaves out, in plain words, or null when nothing is. A
 * saved quiz shows its own problems as normal issues (§8 step 6); these are
 * the ones the quiz can't show, because the question isn't in it. */
export function extractionNotice(
  report:
    | (Pick<ExtractionReport, 'figuresLeftOut' | 'missing' | 'stopped'> & {
        answersMissing?: string[];
      })
    | undefined
): string | null {
  if (!report) return null;
  if (report.stopped === 'credits') return m.make_quiz_stopped_credits();
  if (report.stopped === 'quiz_full') return m.make_quiz_stopped_full();
  if (report.stopped === 'output_limit') return m.make_quiz_stopped_output();
  const lost = [
    report.missing.length > 0 &&
      m.make_quiz_missing({ labels: report.missing.join(', ') }),
    report.answersMissing?.length &&
      m.make_quiz_answers_missing({ labels: report.answersMissing.join(', ') }),
  ].filter(Boolean);
  if (lost.length > 0) return lost.join(' ');
  if (report.figuresLeftOut.length > 0)
    return m.make_quiz_figures_left_out({
      labels: report.figuresLeftOut.join(', '),
    });
  return null;
}
