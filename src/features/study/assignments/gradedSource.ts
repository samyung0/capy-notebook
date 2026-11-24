import type { AssignmentFormReq } from '@/api/types';

/** What New graded quiz's first step picked (Epo 2026-11-20: the questions
 * before the settings). Settings starts on its name, and its Create sends it
 * with the settings in one request. */
export type GradedSource = {
  /** The button's label while it is sent, where that takes a while. */
  busyLabel?: string;
  /** AI-made, read or blank questions: the graded quiz is made a draft, to be
   * read before it goes out. */
  draft?: boolean;
  /** A file read as the question paper: marked by hand out of the Points
   * typed in Settings and answered by upload. */
  file?: boolean;
  /** The quiz's or file's name, Settings' Title until one is typed. */
  name: string;
  /** An existing quiz copied whole: Settings shows its Points, fixed. */
  quizId?: string;
  /** Sends the pick with the settings; settles once the graded quiz is made,
   * or its run has started. */
  send: (gradedQuiz: AssignmentFormReq) => Promise<unknown>;
};
