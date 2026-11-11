import { type ComponentProps, useState } from 'react';
import { useCreateMaterial, useMaterials } from '@/api/hooks';
import { PreviewCard } from '@/components/app/PreviewCard';
import { Button } from '@/components/ui/Button';
import { DialogCancel } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/feedback';
import { Tabs } from '@/components/ui/Tabs';
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

type Tab = 'create' | 'generate' | 'convert';

/** Add practice (Epo 2026-11-11): one dialog with three ways to make a quiz for
 * the workspace. Create quiz picks a template, as Add file's Create tab does;
 * Generate quiz is the generate form; Convert to quiz is Make a quiz from a
 * file, whose dialog this is, so Continue goes on to its pages. */
export function AddPracticeDialog({
  make,
  onOpenQuiz,
}: {
  /** Make a quiz from a file, as the workspace opens it. */
  make: ComponentProps<typeof MakeQuizDialog>;
  onOpenQuiz: (id: string) => void;
}) {
  const { onClose, workspaceId, workspaceName } = make;
  // A link or a reload with files picked is on its way to their pages.
  const [tab, setTab] = useState<Tab>(
    make.initial.paper.length > 0 ? 'convert' : 'create'
  );
  const [template, setTemplate] = useState<QuizTemplateId>('blank');
  const { data: materials } = useMaterials(workspaceId, {
    errorBoundary: false,
  });
  const { isPending: creating, mutate: createMaterial } =
    useCreateMaterial(workspaceId);
  const generate = useMakePractice({
    mixable: false,
    onlyYou: false,
    onMade: onClose,
    workspaceId,
  });

  const create = () =>
    createMaterial(
      {
        content: createMaterialDocument([
          quizNode({ questions: templateQuestions(template) }),
        ]),
        kind: 'quiz',
        // Generate's "{workspace} quiz {n}" names keep titles unique.
        title: nextGenerateTitle(
          'quiz',
          workspaceName,
          (materials ?? []).map((material) => material.title)
        ),
      },
      { onSuccess: (material) => onOpenQuiz(material.id) }
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
              : footer(generate.credits, generate.startButton),
        };
  return (
    <MakeQuizDialog
      {...make}
      tabs={{
        other,
        strip: (
          <Tabs
            className="mb-4"
            onChange={(next) => setTab(next as Tab)}
            tabs={[
              { label: m.practice_tab_create(), value: 'create' },
              { label: m.practice_tab_generate(), value: 'generate' },
              { label: m.practice_tab_convert(), value: 'convert' },
            ]}
            value={tab}
          />
        ),
        title: m.practice_add(),
      }}
    />
  );
}
