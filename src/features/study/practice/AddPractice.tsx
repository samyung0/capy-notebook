import { type ComponentProps, type ReactNode, useState } from 'react';
import { useCreateMaterial, useMaterials } from '@/api/hooks';
import type { AssignmentFormReq } from '@/api/types';
import { PreviewCard } from '@/components/app/PreviewCard';
import { Button } from '@/components/ui/Button';
import { DialogCancel } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/feedback';
import { Tile } from '@/components/ui/Tile';
import { userToast } from '@/components/ui/userToast';
import { useBankPicker } from '@/features/itemBanks/BankPicker';
import {
  MakeQuizDialog,
  type MakeQuizSteps,
} from '@/features/makeQuiz/MakeQuizDialog';
import {
  createMaterialDocument,
  quizNode,
} from '@/features/materials/document';
import { useExistingQuizPicker } from '@/features/study/assignments/ExistingQuizPicker';
import type { GradedSource } from '@/features/study/assignments/gradedSource';
import { nextGenerateTitle } from '@/features/workspace/generateTitle';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { materialIconName } from '@/lib/fileIcons';
import { useMakePractice } from './MakePractice';
import { type QuizWay, QuizWayArt } from './QuizWayArt';
import {
  QUIZ_TEMPLATES,
  type QuizTemplateId,
  templateLabel,
  templatePreview,
  templateQuestions,
} from './quizTemplates';

// Each way's card: its name, and what it does in a line.
const WAYS: Record<
  QuizWay,
  { description: () => string; label: () => string }
> = {
  bank: { description: m.practice_way_bank, label: m.practice_tab_bank },
  convert: {
    description: m.practice_way_convert,
    label: m.practice_tab_convert,
  },
  create: { description: m.practice_way_create, label: m.practice_tab_create },
  existing: {
    description: m.practice_way_existing,
    label: m.assignment_tab_existing,
  },
  generate: {
    description: m.practice_way_generate,
    label: m.practice_tab_generate,
  },
};

/** New quiz (Epo 2026-11-11, renamed 2026-11-14 and 2026-11-20): one dialog
 * with four ways to make a quiz for the workspace, from Study's Add practice
 * and the Dashboard's Make a quiz. It opens on the ways as cards, each with a drawing and a line on
 * what it does (Epo 2026-11-20, board B, in place of a tab row); picking one
 * opens it under its name, Back returning to the cards. Extract from file
 * (Epo 2026-11-20, was Convert to quiz) comes first: Make a quiz from a file,
 * whose dialog this is, so Continue goes on to its pages, and a link or reload
 * with files picked opens on it. Generate quiz is the generate form; From
 * question bank (Epo 2026-11-20, was From the bank) copies picked item bank
 * questions; Create blank, last (Epo 2026-11-16), picks a template, as Add
 * file's Create tab does. Made, the dialog closes and a Quiz created toast
 * opens it. */
export function AddPracticeDialog({
  graded,
  make,
  onOpenQuiz,
}: {
  /** New graded quiz's first step (Epo 2026-11-20: the questions before the
   * settings): each way's Next hands its pick to Settings (`settings`, shown
   * in this dialog's place once there), whose Create sends it, and the
   * graded quiz made. Existing file comes first; Extract from file has no
   * Hide the quiz switch, and its upload and run stay in the dialog. */
  graded?: {
    initialTopicId?: string;
    onMade: (assignmentId: string) => void;
    onNext: (source: GradedSource) => void;
    settings?: ComponentProps<typeof MakeQuizDialog>['tabs']['settings'];
    title: ReactNode;
  };
  /** Make a quiz from a file, as the workspace opens it. */
  make: MakeQuizSteps;
  /** The Quiz created toast's Open. */
  onOpenQuiz?: (id: string) => void;
}) {
  const { onClose, workspaceId, workspaceName } = make;
  // The way picked; none on the cards.
  const [tab, setTab] = useState<QuizWay | null>(
    make.step !== 'files' ||
      make.initial.paper.length > 0 ||
      make.initial.answers.length > 0
      ? 'convert'
      : null
  );
  // A graded quiz may start from one the workspace has, first (Epo
  // 2026-11-16).
  const ways: QuizWay[] = [
    ...(graded ? ['existing' as const] : []),
    'convert',
    'generate',
    'bank',
    'create',
  ];
  // A maker's quiz came with its graded quiz.
  const gradedMade = (assignmentId?: string) => {
    if (graded && assignmentId) graded.onMade(assignmentId);
  };
  // Made: the dialog closes on the page behind it, and a toast opens the quiz
  // (Epo 2026-11-20, in place of opening it).
  const made = (id: string, assignmentId?: string) => {
    if (graded) {
      gradedMade(assignmentId);
      return;
    }
    onClose();
    userToast({
      button: onOpenQuiz && {
        label: m.action_open(),
        onClick: () => onOpenQuiz(id),
      },
      title: m.practice_quiz_created(),
      variant: 'success',
    });
  };
  const [template, setTemplate] = useState<QuizTemplateId>('blank');
  const { data: materials } = useMaterials(workspaceId, {
    errorBoundary: false,
  });
  // New graded quiz's Settings says a failure.
  const { isPending: creating, mutateAsync: createMaterial } =
    useCreateMaterial(workspaceId, graded ? { errorToast: false } : undefined);
  const generate = useMakePractice({
    initialTopicId: graded?.initialTopicId,
    mixable: false,
    onlyYou: false,
    onMade: made,
    workspaceId,
  });

  // Generate's "{workspace} quiz {n}" names keep titles unique.
  const title = () =>
    nextGenerateTitle(
      'quiz',
      workspaceName,
      (materials ?? []).map((material) => material.title)
    );
  const bank = useBankPicker({
    active: tab === 'bank',
    graded: !!graded,
    label: m.action_create(),
    onMade: made,
    title,
    workspaceId,
  });
  const existing = useExistingQuizPicker({
    enabled: !!graded,
    onMade: gradedMade,
    workspaceId,
  });
  // Made with its graded quiz when there is one.
  const create = (name: string, gradedQuiz?: AssignmentFormReq) =>
    createMaterial({
      content: createMaterialDocument([
        quizNode({ questions: templateQuestions(template) }),
      ]),
      gradedQuiz,
      kind: 'quiz',
      title: name,
    }).then((material) => made(material.id, material.assignmentId));
  // A blank or template quiz is written before its graded quiz goes out.
  const blank = (): GradedSource => {
    const name = title();
    return {
      draft: true,
      name,
      send: (gradedQuiz) => create(name, gradedQuiz),
    };
  };
  // The way's pick for New graded quiz's Next.
  const source =
    tab === 'existing'
      ? existing.source
      : tab === 'bank'
        ? bank.source
        : tab === 'generate'
          ? generate.source
          : undefined;

  // Back to the ways sits beside the action from sm, as on Extract's step;
  // phones have the header's arrow.
  const footer = (note: ReactNode, action: ReactNode) => (
    <>
      {note && (
        <p className="t-meta mr-auto flex min-w-0 items-center gap-1.5 self-center text-fg-muted max-sm:w-full">
          {note}
        </p>
      )}
      <span className="contents max-sm:hidden">
        <Button
          onClick={() => setTab(null)}
          size="md"
          type="button"
          variant="outline"
        >
          {m.action_back()}
        </Button>
      </span>
      <span className="max-sm:ml-auto sm:contents">
        {graded ? (
          <Button
            disabled={tab === 'create' ? false : !source}
            onClick={() => {
              const next = tab === 'create' ? blank() : source;
              if (next) graded.onNext(next);
            }}
            type="button"
          >
            {m.action_next()}
          </Button>
        ) : (
          action
        )}
      </span>
    </>
  );
  const other =
    tab === 'convert'
      ? undefined
      : {
          // All stay mounted, so a way keeps what was picked in it.
          body: (
            <>
              {/* The ways: a card each, in two rows from sm (three and two,
                  or two and two); phones list them, the drawing beside the
                  words (Epo 2026-11-20, board B, the cards smaller than
                  drawn). */}
              <div
                className={cn(
                  'grid min-h-0 flex-1 content-start gap-2 overflow-y-auto',
                  ways.length === 5 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'
                )}
                hidden={tab !== null}
              >
                {ways.map((way) => (
                  <Tile
                    className="flex-row gap-3 px-2 py-2.5 sm:flex-col sm:gap-2 sm:px-3 sm:pt-3 sm:pb-3.5"
                    description={WAYS[way].description()}
                    icon={
                      <QuizWayArt
                        className="h-[58px] w-24 sm:h-18 sm:w-30"
                        way={way}
                      />
                    }
                    key={way}
                    label={WAYS[way].label()}
                    onClick={() => setTab(way)}
                  />
                ))}
              </div>
              {/* Each fills the dialog's one height, and scrolls in it. */}
              <div
                className="grid min-h-0 flex-1 grid-cols-2 content-start gap-1 overflow-y-auto sm:grid-cols-4"
                hidden={tab !== 'create'}
              >
                {QUIZ_TEMPLATES.map((id) => {
                  const first = templatePreview(id);
                  return (
                    <PreviewCard
                      icon={materialIconName('quiz')}
                      key={id}
                      onClick={() => setTemplate(id)}
                      selected={template === id}
                      thumbnail={{
                        preview: {
                          kind: 'quiz',
                          questionCount: first ? 1 : 0,
                          ...(first ? { first } : {}),
                        },
                      }}
                      title={templateLabel(id)}
                    />
                  );
                })}
              </div>
              <div
                className="min-h-0 flex-1 overflow-y-auto"
                hidden={tab !== 'generate'}
              >
                {generate.body}
              </div>
              <div
                className="flex min-h-0 flex-1 flex-col"
                hidden={tab !== 'bank'}
              >
                {bank.body}
              </div>
              {graded && (
                <div
                  className="flex min-h-0 flex-1 flex-col"
                  hidden={tab !== 'existing'}
                >
                  {existing.body}
                </div>
              )}
            </>
          ),
          // The cards' dialog is only as tall as they are, and as wide as two
          // rows of about 230px cards (Epo 2026-11-20).
          fit:
            tab === null ? { width: ways.length === 5 ? 760 : 520 } : undefined,
          footer:
            tab === null ? (
              <span className="contents max-sm:hidden">
                <DialogCancel size="md" />
              </span>
            ) : tab === 'create' ? (
              footer(
                null,
                <Button
                  disabled={creating}
                  onClick={() => void create(title()).catch(() => undefined)}
                  type="button"
                >
                  {creating ? <Spinner /> : m.action_create()}
                </Button>
              )
            ) : tab === 'bank' ? (
              footer(bank.note, bank.action)
            ) : tab === 'existing' ? (
              footer(existing.note, null)
            ) : (
              footer(generate.credits, generate.startButton)
            ),
        };
  return (
    <MakeQuizDialog
      {...make}
      graded={graded && { onNext: graded.onNext }}
      onDone={made}
      tabs={{
        onBack: tab ? () => setTab(null) : undefined,
        other,
        settings: graded?.settings,
        // A way's step is under its name; the cards and Settings under the
        // dialog's.
        title:
          tab && !graded?.settings
            ? WAYS[tab].label()
            : (graded?.title ?? m.practice_new_quiz()),
      }}
    />
  );
}
