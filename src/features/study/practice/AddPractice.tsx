import { type ComponentProps, type ReactNode, useState } from 'react';
import { useCreateMaterial, useMaterials } from '@/api/hooks';
import type { AssignmentFormReq } from '@/api/types';
import { PreviewCard } from '@/components/app/PreviewCard';
import { Button } from '@/components/ui/Button';
import { DialogCancel } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/feedback';
import { Tabs } from '@/components/ui/Tabs';
import { useBankPicker } from '@/features/itemBanks/BankPicker';
import { MakeQuizDialog } from '@/features/makeQuiz/MakeQuizDialog';
import {
  createMaterialDocument,
  quizNode,
} from '@/features/materials/document';
import { useExistingQuizPicker } from '@/features/study/assignments/ExistingQuizPicker';
import { nextGenerateTitle } from '@/features/workspace/generateTitle';
import { m } from '@/i18n';
import { materialIconName } from '@/lib/fileIcons';
import { useMakePractice } from './MakePractice';
import {
  QUIZ_TEMPLATES,
  type QuizTemplateId,
  templateLabel,
  templatePreview,
  templateQuestions,
} from './quizTemplates';

type Tab = 'existing' | 'create' | 'generate' | 'convert' | 'bank';

/** Add quiz (Epo 2026-11-11, renamed 2026-11-14): one dialog with four ways to
 * make a quiz for the workspace, from Study's Add practice and the Dashboard's
 * Make a quiz. Convert to quiz comes first and opens by default (Epo
 * 2026-11-14): Make a quiz from a file, whose dialog this is, so Continue goes
 * on to its pages. Generate quiz is the generate form; From the bank copies
 * picked item bank questions; Create blank, last (Epo 2026-11-16), picks a
 * template, as Add file's Create tab does. */
/** AI-made, read or blank questions go out as a draft, read first; a task for
 * oneself has no draft and is theirs at once. */
const draftOf = ({ form, own }: { form: AssignmentFormReq; own?: boolean }) =>
  own ? form : { ...form, draft: true };

export function AddPracticeDialog({
  graded,
  make,
  onOpenQuiz,
}: {
  /** New graded quiz's Questions step (Epo 2026-11-16): the settings each
   * way sends with its questions (`own`: a task for oneself, which is never a
   * draft), Back to them, and the graded quiz made.
   * Existing quiz comes first; Convert has no Hide the quiz switch, and its
   * upload and run stay in the dialog. */
  graded?: {
    form: AssignmentFormReq;
    initialTopicId?: string;
    onBack: () => void;
    own?: boolean;
    onMade: (assignmentId: string) => void;
    title: ReactNode;
  };
  /** Make a quiz from a file, as the workspace opens it. */
  make: ComponentProps<typeof MakeQuizDialog>;
  onOpenQuiz?: (id: string) => void;
}) {
  const { onClose, workspaceId, workspaceName } = make;
  const [tab, setTab] = useState<Tab>(graded ? 'existing' : 'convert');
  // A maker's quiz came with its graded quiz.
  const gradedMade = (assignmentId?: string) => {
    if (graded && assignmentId) graded.onMade(assignmentId);
  };
  const [template, setTemplate] = useState<QuizTemplateId>('blank');
  const { data: materials } = useMaterials(workspaceId, {
    errorBoundary: false,
  });
  const { isPending: creating, mutate: createMaterial } =
    useCreateMaterial(workspaceId);
  const generate = useMakePractice({
    // AI-made questions are read before the graded quiz goes out.
    gradedQuiz: graded && draftOf(graded),
    initialTopicId: graded?.initialTopicId,
    mixable: false,
    onlyYou: false,
    onMade: graded ? (_, assignmentId) => gradedMade(assignmentId) : onClose,
    workspaceId,
  });

  // Generate's "{workspace} quiz {n}" names keep titles unique.
  const title = () =>
    nextGenerateTitle(
      'quiz',
      workspaceName,
      (materials ?? []).map((material) => material.title)
    );
  const made = (id: string, assignmentId?: string) =>
    graded ? gradedMade(assignmentId) : onOpenQuiz?.(id);
  const bank = useBankPicker({
    active: tab === 'bank',
    gradedQuiz: graded?.form,
    label: m.action_create(),
    onMade: made,
    title,
    workspaceId,
  });
  const existing = useExistingQuizPicker({
    gradedQuiz: graded?.form,
    onMade: gradedMade,
    workspaceId,
  });
  const create = () => {
    const name = title();
    createMaterial(
      {
        content: createMaterialDocument([
          quizNode({ questions: templateQuestions(template) }),
        ]),
        // A blank or template quiz is written before it goes out, and an
        // untitled graded quiz is named after its quiz.
        ...(graded && {
          gradedQuiz: {
            ...draftOf(graded),
            title: graded.form.title || name,
          },
        }),
        kind: 'quiz',
        title: name,
      },
      {
        onSuccess: (material) => made(material.id, material.assignmentId),
      }
    );
  };

  // Cancel (Back to Settings for a graded quiz) sits beside the action from
  // sm, as on Convert's step.
  const back = graded ? (
    <Button onClick={graded.onBack} size="md" type="button" variant="outline">
      {m.action_back()}
    </Button>
  ) : (
    <DialogCancel />
  );
  const footer = (note: React.ReactNode, action: React.ReactNode) => (
    <>
      {note && (
        <p className="t-meta mr-auto flex min-w-0 items-center gap-1.5 self-center text-fg-muted max-sm:w-full">
          {note}
        </p>
      )}
      <span className="contents max-sm:hidden">{back}</span>
      <span className="max-sm:ml-auto sm:contents">{action}</span>
    </>
  );
  const other =
    tab === 'convert'
      ? undefined
      : {
          // Both stay mounted, so a tab keeps what was picked in it.
          body: (
            <>
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
          footer:
            tab === 'create'
              ? footer(
                  null,
                  <Button disabled={creating} onClick={create} type="button">
                    {creating ? <Spinner /> : m.action_create()}
                  </Button>
                )
              : tab === 'bank'
                ? footer(bank.note, bank.action)
                : tab === 'existing'
                  ? footer(existing.note, existing.action)
                  : footer(generate.credits, generate.startButton),
        };
  return (
    <MakeQuizDialog
      {...make}
      tabs={{
        onBack: graded?.onBack,
        other,
        strip: (
          <Tabs
            className="dialog-tabs-bleed mb-4 w-auto"
            onChange={(next) => setTab(next as Tab)}
            tabs={[
              // A graded quiz may start from one the workspace has, first
              // (Epo 2026-11-16).
              ...(graded
                ? [{ label: m.assignment_tab_existing(), value: 'existing' }]
                : []),
              { label: m.practice_tab_convert(), value: 'convert' },
              { label: m.practice_tab_generate(), value: 'generate' },
              { label: m.practice_tab_bank(), value: 'bank' },
              // Last, as Create blank (Epo 2026-11-16).
              { label: m.practice_tab_create(), value: 'create' },
            ]}
            value={tab}
          />
        ),
        title: graded?.title ?? m.practice_add_quiz(),
      }}
    />
  );
}
