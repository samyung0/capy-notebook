import { type ComponentProps, type ReactNode, useState } from 'react';
import { useCreateMaterial, useMaterials } from '@/api/hooks';
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

type Tab = 'create' | 'generate' | 'convert' | 'bank';

/** Add quiz (Epo 2026-11-11, renamed 2026-11-14): one dialog with four ways to
 * make a quiz for the workspace, from Study's Add practice and the Dashboard's
 * Make a quiz. Convert to quiz comes first and opens by default (Epo
 * 2026-11-14): Make a quiz from a file, whose dialog this is, so Continue goes
 * on to its pages. Create quiz picks a template, as Add file's Create tab
 * does; Generate quiz is the generate form; From the bank copies picked item
 * bank questions. */
export function AddPracticeDialog({
  graded,
  make,
  onOpenQuiz,
}: {
  /** New graded quiz's Questions step (Epo 2026-11-14): its title, and what
   * takes the quiz made, which starts hidden. Convert has no Hide the quiz
   * switch, and its upload and run stay in the dialog. */
  graded?: {
    initialTopicId?: string;
    onMade: (quizId: string) => void;
    title: ReactNode;
  };
  /** Make a quiz from a file, as the workspace opens it. */
  make: ComponentProps<typeof MakeQuizDialog>;
  onOpenQuiz?: (id: string) => void;
}) {
  const { onClose, workspaceId, workspaceName } = make;
  const [tab, setTab] = useState<Tab>('convert');
  const [template, setTemplate] = useState<QuizTemplateId>('blank');
  const { data: materials } = useMaterials(workspaceId, {
    errorBoundary: false,
  });
  const { isPending: creating, mutate: createMaterial } =
    useCreateMaterial(workspaceId);
  const generate = useMakePractice({
    gradedQuiz: !!graded,
    initialTopicId: graded?.initialTopicId,
    mixable: false,
    onlyYou: false,
    onMade: graded ? graded.onMade : onClose,
    workspaceId,
  });

  // Generate's "{workspace} quiz {n}" names keep titles unique.
  const title = () =>
    nextGenerateTitle(
      'quiz',
      workspaceName,
      (materials ?? []).map((material) => material.title)
    );
  const made = (id: string) => (graded?.onMade ?? onOpenQuiz)?.(id);
  const bank = useBankPicker({
    active: tab === 'bank',
    gradedQuiz: !!graded,
    label: graded ? m.action_continue() : m.action_create(),
    onMade: made,
    title,
    workspaceId,
  });
  const create = () =>
    createMaterial(
      {
        content: createMaterialDocument([
          quizNode({ questions: templateQuestions(template) }),
        ]),
        gradedQuiz: !!graded,
        kind: 'quiz',
        title: title(),
      },
      { onSuccess: (material) => made(material.id) }
    );

  // Cancel sits beside the action from sm, as on Convert's step.
  const footer = (note: React.ReactNode, action: React.ReactNode) => (
    <>
      {note && (
        <p className="t-meta mr-auto flex min-w-0 items-center gap-1.5 self-center text-fg-muted max-sm:w-full">
          {note}
        </p>
      )}
      <span className="contents max-sm:hidden">
        <DialogCancel />
      </span>
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
              <div
                className="grid grid-cols-2 gap-1 sm:grid-cols-4"
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
              <div hidden={tab !== 'generate'}>{generate.body}</div>
              <div hidden={tab !== 'bank'}>{bank.body}</div>
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
                : footer(generate.credits, generate.startButton),
        };
  return (
    <MakeQuizDialog
      {...make}
      graded={!!graded}
      tabs={{
        other,
        strip: (
          <Tabs
            className="dialog-tabs-bleed mb-4 w-auto"
            onChange={(next) => setTab(next as Tab)}
            tabs={[
              { label: m.practice_tab_convert(), value: 'convert' },
              { label: m.practice_tab_create(), value: 'create' },
              { label: m.practice_tab_generate(), value: 'generate' },
              { label: m.practice_tab_bank(), value: 'bank' },
            ]}
            value={tab}
          />
        ),
        title: graded?.title ?? m.practice_add_quiz(),
      }}
    />
  );
}
