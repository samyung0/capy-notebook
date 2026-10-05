import { m } from '@/i18n';
import type { ExportLabels } from './content';
import type {
  ExportRequest,
  ExportResult,
  FigureResponse,
  WorkerResponse,
} from './export.worker';

export function exportLabels(): ExportLabels {
  return {
    answer: m.editor_export_answer(),
    answerKey: m.editor_export_answer_key(),
    back: m.editor_card_back(),
    callouts: {
      danger: m.editor_export_danger(),
      info: m.editor_export_info(),
      success: m.editor_export_success(),
      tip: m.editor_export_tip(),
      warning: m.editor_export_warning(),
    },
    card: m.editor_export_card(),
    choices: m.editor_export_choices(),
    column: m.editor_export_column(),
    false: m.question_ui_false(),
    front: m.editor_card_front(),
    hints: m.editor_export_hints(),
    interactive: m.editor_export_interactive(),
    marks: m.editor_export_marks(),
    markscheme: m.editor_export_markscheme(),
    question: m.editor_export_question(),
    solution: m.editor_export_solution(),
    true: m.question_ui_true(),
    video: m.editor_export_video(),
  };
}

export function runExportWorker(
  request: Omit<ExportRequest, 'type' | 'labels'>,
  signal?: AbortSignal
): Promise<ExportResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./export.worker.ts', import.meta.url), {
      type: 'module',
    });
    let settled = false;
    const finish = (error?: Error, result?: ExportResult) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const abort = () =>
      finish(new DOMException('Export cancelled.', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    let figureQueue = Promise.resolve();
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === 'done') finish(undefined, message.result);
      else if (message.type === 'error') finish(new Error(message.message));
      else
        figureQueue = figureQueue.then(async () => {
          if (settled) return;
          try {
            const { renderExportFigure } = await import('./figures');
            const image = await renderExportFigure(message.figure);
            if (!settled)
              worker.postMessage({
                id: message.id,
                image,
                type: 'figure',
              } satisfies FigureResponse);
          } catch (error) {
            if (!settled)
              worker.postMessage({
                error:
                  error instanceof Error
                    ? error.message
                    : 'Figure conversion failed.',
                id: message.id,
                type: 'figure',
              } satisfies FigureResponse);
          }
        });
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(new Error(event.message || m.editor_export_failed()));
    };
    worker.onmessageerror = () => finish(new Error(m.editor_export_failed()));
    try {
      worker.postMessage({
        ...request,
        labels: exportLabels(),
        type: 'export',
      } satisfies ExportRequest);
    } catch (error) {
      finish(
        error instanceof Error ? error : new Error(m.editor_export_failed())
      );
    }
  });
}
