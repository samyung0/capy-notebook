import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import type { TagInput, Topic } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { userToast } from '@/components/ui/userToast';
import {
  BankTagsField,
  bankTagsSchema,
} from '@/features/itemBanks/BankTagsField';
import { m } from '@/i18n';
import { errorCopy } from '@/lib/errors';
import type { UploadQuestionAsset } from './BlockEditor';
import { issueMessages, questionIssues } from './issues';
import { QuestionCard } from './QuestionCard';
import { TopicField, withTopics } from './TopicField';
import { type Question, withoutBlanks } from './types';
import { questionSchema, validateQuestion } from './validation';

export interface QuestionDialogProps {
  bankAssetsUrl?: string;
  context?: string;
  onClose: () => void;
  onReload?: () => Promise<Question>;
  /** Staged editing (the bank): the dialog's Save, with the Tags when the
   * dialog has them. */
  onSave?: (question: Question, tags: string[]) => void | Promise<void>;
  open: boolean;
  policy?: 'quiz' | 'bank';
  question: Question;
  questionNumber?: number;
  /** An item bank's question (Epo 2026-11-15): its Tags under Topic, saved
   * with it, offering the bank's tags. */
  tags?: { catalog: string[]; initial: string[] };
  /** A class bank's topics: the question's Topic under the card. */
  topics?: Topic[];
  uploadAsset?: UploadQuestionAsset;
}

const draftResolver = zodResolver(
  z.object({ draft: questionSchema, tags: bankTagsSchema })
);

export function QuestionDialog(props: QuestionDialogProps) {
  return props.open ? (
    <QuestionDialogSession {...props} key={props.question.id} />
  ) : null;
}

/**
 * The question card in a dialog (Epo 2026-11-15, board Dialog): Edit question
 * with its close, the same card the quiz page edits in place, the Topic row
 * under it and a bank question's Tags, then Cancel and Save: it edits a draft
 * Save checks and hands over (the bank, Make a quiz's list). A quiz's
 * questions edit in place instead, on its page and in a note.
 */
function QuestionDialogSession({
  open,
  onClose,
  question,
  onSave,
  onReload,
  context,
  questionNumber,
  policy = 'quiz',
  bankAssetsUrl,
  topics,
  tags,
  uploadAsset,
}: QuestionDialogProps) {
  const {
    control,
    getValues,
    setValue,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<{ draft: Question; tags: TagInput[] }>({
    defaultValues: {
      draft: structuredClone(question),
      tags: (tags?.initial ?? []).map((value) => ({ value })),
    },
    // Blanks (empty text, a blank unit or accepted answer, a blank
    // description, short table rows or chart series) are dropped or filled on
    // Save, so they never hold it up.
    resolver: (values, context, options) =>
      draftResolver(
        { ...values, draft: withoutBlanks(values.draft) },
        context,
        options
      ),
  });
  const draft = useWatch({ control, name: 'draft' });
  const setDraft = (next: Question) =>
    setValue('draft', next, { shouldDirty: true });
  const [error, setError] = useState('');
  const [reloading, setReloading] = useState(false);
  // Reload starts the card over on the latest version.
  const [session, setSession] = useState(0);
  const pending = isSubmitting || reloading;
  const bank = policy === 'bank';

  const saveQuestion = handleSubmit(
    async ({ draft: value, tags: tagged }) => {
      setError('');
      // The inline message keeps the conflict reload next to it.
      const fail = (message: string) => {
        setError(message);
        userToast({
          description: message,
          title: m.question_ui_could_not_save_question(),
          variant: 'error',
        });
      };
      let saved: Question;
      try {
        saved = validateQuestion(value, { bank, bankAssetsUrl });
      } catch (failure) {
        // validateQuestion's own checks carry copy; a schema failure does not.
        fail(errorCopy(failure, m.question_ui_could_not_save_question()));
        return;
      }
      try {
        await onSave?.(
          saved,
          tagged.map((tag) => tag.value.trim())
        );
        onClose();
      } catch (failure) {
        fail(errorCopy(failure, m.question_ui_could_not_save_question()));
      }
    },
    (errors) => {
      const messages: string[] = [];
      const visit = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        if ('message' in value && typeof value.message === 'string')
          messages.push(value.message);
        for (const [key, inner] of Object.entries(value))
          if (key !== 'ref' && key !== 'message') visit(inner);
      };
      visit(errors);
      setError(
        messages.slice(0, 3).join(' · ') ||
          m.question_ui_complete_the_question_answer_and_marking_scheme_before_saving()
      );
    }
  );
  return (
    <SimpleDialog
      action={
        <Button
          disabled={pending}
          onClick={() => void saveQuestion()}
          rounded="large"
          size="md"
          type="button"
          variant="dark"
        >
          {m.question_ui_save()}
        </Button>
      }
      onClose={() => {
        if (!pending) onClose();
      }}
      open={open}
      pending={pending}
      title={
        <div>
          <span>
            {questionNumber == null
              ? m.question_ui_edit_question()
              : m.question_ui_edit_question_number({ number: questionNumber })}
          </span>
          {context && (
            <p className="mt-1 font-normal text-fg-muted text-sm">{context}</p>
          )}
        </div>
      }
      width={840}
    >
      {error && (
        <div className="mb-3 space-y-2 text-sm" role="alert">
          <p className="text-solid-error">{error}</p>
          {onReload && (
            <Button
              disabled={pending}
              onClick={async () => {
                setReloading(true);
                try {
                  const latest = await onReload();
                  reset({
                    draft: structuredClone(latest),
                    tags: getValues('tags'),
                  });
                  setSession((current) => current + 1);
                  setError('');
                } catch (failure) {
                  setError(
                    errorCopy(failure, m.question_ui_could_not_save_question())
                  );
                } finally {
                  setReloading(false);
                }
              }}
              type="button"
              variant="ghost"
            >
              {m.question_ui_conflict_reload()}
            </Button>
          )}
        </div>
      )}
      <QuestionCard
        addPartInFooter
        issues={issueMessages(questionIssues(draft, { bank, bankAssetsUrl }))}
        key={session}
        // The dialog has no closed card to keep in place: its first part opens.
        openPart={draft.parts[0]?.id}
        policy={policy}
        question={draft}
        uploadAsset={uploadAsset}
        write={setDraft}
      />
      {topics && topics.length > 0 && (
        <div className="mt-3.5">
          <TopicField
            empty={m.bank_no_topic()}
            onChange={(topicIds) => setDraft(withTopics(draft, topicIds))}
            topicIds={draft.topicIds}
            topics={topics}
          />
        </div>
      )}
      {tags && (
        <div className="mt-3.5">
          <Controller
            control={control}
            name="tags"
            render={({ field, fieldState: { error, invalid } }) => (
              <BankTagsField
                catalog={tags.catalog}
                error={error}
                invalid={invalid}
                onChange={field.onChange}
                value={field.value}
              />
            )}
          />
        </div>
      )}
    </SimpleDialog>
  );
}
