import { onExtractionEnd } from '@/api/hooks';
import type { Extraction } from '@/api/types';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { extractionFailure, extractionNotice } from './makeQuiz';

/** The toast when a run ends while its page isn't open: the run's own page
 * follows it and opens the quiz itself. */
export function announceExtractionEnd(
  run: Extraction,
  runOnScreen: string | undefined,
  open: (workspaceId: string, quizId: string) => void
) {
  if (runOnScreen === run.id) return;
  if (run.status === 'done' && run.quizId) {
    const { quizId, workspaceId } = run;
    userToast({
      button: {
        label: m.make_quiz_open(),
        onClick: () => open(workspaceId, quizId),
      },
      description: extractionNotice(run.report) ?? undefined,
      title: m.make_quiz_ready_toast({ title: run.title }),
      variant: run.report?.stopped === 'credits' ? 'error' : 'success',
    });
  } else if (run.status === 'failed')
    userToast({
      description: extractionFailure(run.errorCode),
      title: m.make_quiz_failed_toast({ title: run.title }),
      variant: 'error',
    });
}

/** Set once at the app's start, with the router's reads. */
export function listenForExtractionEnds(
  runOnScreen: () => string | undefined,
  open: (workspaceId: string, quizId: string) => void
) {
  return onExtractionEnd((run) =>
    announceExtractionEnd(run, runOnScreen(), open)
  );
}
