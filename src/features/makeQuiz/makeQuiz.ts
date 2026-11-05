import { isApiError } from '@/api/client';
import { createExtractionBodyTitleMax } from '@/api/gen/validators';
import {
  EXTRACTION_ANSWER_FILES_MAX,
  EXTRACTION_PAGES_MAX,
  EXTRACTION_PAPER_FILES_MAX,
  EXTRACTION_QUESTION_CREDITS,
} from '@/api/limits.generated';
import type {
  CreateExtractionReq,
  Extraction,
  ExtractionFoundQuestion,
  ExtractionReport,
  SourceFile,
} from '@/api/types';
import { fileExt } from '@/features/workspace/sourceUpload';
import { m } from '@/i18n';

/** The Office formats a paper's pages are drawn from in the browser (Epo
 * 2026-11-05). A spreadsheet is no paper. */
export function drawnPaperFormat(file: Pick<SourceFile, 'name'>) {
  const ext = fileExt(file.name);
  return ext === 'docx' || ext === 'pptx' ? ext : null;
}

/** A file Make a quiz can read, as a question paper or for its answers: anything that
 * is indexed, except a spreadsheet (Epo 2026-11-05) and audio. */
export function isQuizFile(file: Pick<SourceFile, 'kind' | 'name'>) {
  if (file.kind === 'audio' || file.kind === 'unknown') return false;
  const ext = fileExt(file.name);
  return ext !== 'xlsx' && ext !== 'xls';
}

/** A file on its way in. */
export function isReadingFile(file: Pick<SourceFile, 'status'>) {
  return file.status === 'pending' || file.status === 'processing';
}

/** Finished with no text to read from: it failed or was stored without parsing. */
export function isUnreadable(file: Pick<SourceFile, 'indexed' | 'status'>) {
  return !(file.indexed || isReadingFile(file));
}

/** A file the menus offer: read, or still being read. A failed file or one
 * stored without parsing can never be read from. */
export function isOfferable(file: Pick<SourceFile, 'indexed' | 'status'>) {
  if (file.status === 'failed') return false;
  return file.indexed || isReadingFile(file);
}

/** Past its cap (Epo 2026-11-05: five question files, three more), Add a file stops
 * offering more. */
export const hasPaperRoom = (paperCount: number) =>
  paperCount < EXTRACTION_PAPER_FILES_MAX;
export const hasAnswerRoom = (answerCount: number) =>
  answerCount < EXTRACTION_ANSWER_FILES_MAX;

/** A file with no pages to pick: the run reads all of it, and it counts for none of the
 * pages (Epo 2026-11-05). */
export function isWholeFile(file: Pick<SourceFile, 'kind' | 'name'>) {
  return (
    file.kind !== 'pdf' && file.kind !== 'image' && !drawnPaperFormat(file)
  );
}

/** One page of a file, counted from 1. */
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

/** Select all on a file: every page up to the cap, or none when all were on. */
export function toggleAllPages(
  selected: ReadonlySet<string>,
  fileId: string,
  count: number
) {
  const keys = Array.from({ length: count }, (_, i) =>
    pageKey({ fileId, page: i + 1 })
  );
  const next = new Set(selected);
  if (keys.every((key) => next.has(key))) {
    for (const key of keys) next.delete(key);
    return next;
  }
  for (const key of keys) {
    if (next.size >= EXTRACTION_PAGES_MAX) break;
    next.add(key);
  }
  return next;
}

/** A file's picked pages, in order. */
export function pickedPages(selected: ReadonlySet<string>, fileId: string) {
  const prefix = `${fileId}:`;
  return [...selected]
    .filter((key) => key.startsWith(prefix))
    .map((key) => Number(key.slice(prefix.length)))
    .sort((a, b) => a - b);
}

function extractionFile(
  fileId: string,
  selected: ReadonlySet<string>,
  drawn: ReadonlyMap<string, string>
) {
  const pages = pickedPages(selected, fileId);
  const images = pages.flatMap(
    (page) => drawn.get(pageKey({ fileId, page })) ?? []
  );
  return { fileId, pages, ...(images.length > 0 ? { images } : {}) };
}

/** The run's request: each file with its picked pages and any page the browser drew. */
export function extractionRequest(
  title: string,
  paperFileIds: readonly string[],
  answerFileIds: readonly string[],
  selected: ReadonlySet<string>,
  /** Each browser-drawn page's base64 JPEG, by its page key. */
  drawn: ReadonlyMap<string, string> = new Map()
): CreateExtractionReq {
  return {
    answers: answerFileIds.map((fileId) =>
      extractionFile(fileId, selected, drawn)
    ),
    paper: paperFileIds.map((fileId) =>
      extractionFile(fileId, selected, drawn)
    ),
    title,
  };
}

/** How many questions the credits left pay for, from the first. */
export function affordableQuestions(total: number, availableCredits: number) {
  return Math.min(
    total,
    Math.floor(availableCredits / EXTRACTION_QUESTION_CREDITS)
  );
}

/** "Page 3 · parts a, b", a question's line in the confirm dialog. */
export function foundPagesLabel({
  first,
  last,
  parts,
}: Pick<ExtractionFoundQuestion, 'first' | 'last' | 'parts'>) {
  return [
    first === last
      ? m.make_quiz_found_page({ page: first })
      : m.make_quiz_found_pages({ first, last }),
    parts.length > 0 && m.make_quiz_found_parts({ parts: parts.join(', ') }),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A running run on the panel's bar: copying takes the first half, answers the rest. */
export function runProgress(
  run: Pick<Extraction, 'answered' | 'confirmed' | 'recorded'>
) {
  const total = run.confirmed ?? 0;
  if (total === 0) return { label: m.make_quiz_panel_starting(), value: 0 };
  const copied = Math.min(run.recorded, total);
  if (copied < total)
    return {
      label: m.make_quiz_panel_copying({ count: copied, total }),
      value: (copied / total) * 50,
    };
  const answered = Math.min(run.answered, total);
  return {
    label: m.make_quiz_panel_answers({ count: answered, total }),
    value: 50 + (answered / total) * 50,
  };
}

/** How many questions a finished run saved. */
export const savedCount = (report: ExtractionReport | undefined) =>
  report?.recorded.length ?? 0;

/** What a refused start says, chosen by the retrieval service's code; null for
 * any other error. */
export function extractionRefusal(error: unknown): string | null {
  if (!isApiError(error)) return null;
  switch (error.code) {
    case 'too_much_text':
      return m.make_quiz_refused_text();
    case 'no_indexed_text':
      return m.make_quiz_refused_no_text();
    default:
      return null;
  }
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

/** Why a run failed, chosen by its code: the run's own text never shows. */
export function extractionFailure(code: string | undefined): string {
  switch (code) {
    case 'provider_busy':
      return m.make_quiz_failed_busy();
    case 'storage_full':
      return m.make_quiz_failed_storage();
    case 'extraction_empty':
      return m.make_quiz_failed_empty();
    case 'interrupted':
      return m.make_quiz_failed_interrupted();
    case 'confirm_expired':
      return m.make_quiz_failed_expired();
    case 'quiz_invalid':
      return m.make_quiz_failed_invalid();
    default:
      return m.make_quiz_failed_fallback();
  }
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
