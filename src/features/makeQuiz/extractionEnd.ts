import { onExtractionEnd } from '@/api/hooks';
import type { Extraction } from '@/api/types';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { extractionFailure, extractionNotice } from './makeQuiz';
import { isPanelRun, type QuizRunLinks, setQuizRunLinks } from './quizRuns';

/** The toast when a run pauses or ends while its page isn't open and the panel doesn't
 * follow it: the run's own page and the panel show it themselves. */
export function announceExtractionEnd(
  run: Extraction,
  runOnScreen: string | undefined,
  links: QuizRunLinks
) {
  if (runOnScreen === run.id || isPanelRun(run.id)) return;
  if (run.status === 'confirming') {
    const { id, workspaceId } = run;
    userToast({
      button: {
        label: m.make_quiz_review(),
        onClick: () => links.review(workspaceId, id),
      },
      title: m.make_quiz_found_toast({
        count: run.found?.questions.length ?? 0,
        title: run.title,
      }),
      variant: 'success',
    });
  } else if (run.status === 'done' && run.quizId) {
    const { quizId, workspaceId } = run;
    userToast({
      button: {
        label: m.make_quiz_open(),
        onClick: () => links.openQuiz(workspaceId, quizId),
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
  links: QuizRunLinks
) {
  setQuizRunLinks(links);
  return onExtractionEnd((run) =>
    announceExtractionEnd(run, runOnScreen(), links)
  );
}
