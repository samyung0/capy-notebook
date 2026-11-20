import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { SetAssignmentGradeBody } from '@/api/gen/validators';
import { useSetAssignmentGrade } from '@/api/hooks';
import type { Assignment, AssignmentMemberRow } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { InputError } from '@/components/ui/Input';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';
import { MarkField } from './MarkField';

/** A member's grade on a graded Assignment (Epo 2026-11-14), entered by staff
 * on the Grading tab: 0 to its points with one decimal place at most, saved
 * on Enter or Save, never on leaving the field, as a graded quiz's marks wait
 * for Save (Epo 2026-11-19). Emptied, the grade is cleared. Shows the grade as given; the late badge
 * says what the penalty takes off. */
export function GradeField({
  assignment,
  className,
  member,
}: {
  assignment: Assignment & { points: number };
  className?: string;
  member: AssignmentMemberRow;
}) {
  const { points } = assignment;
  const saved = member.correct;
  const text = saved === undefined ? '' : String(saved);
  const { mutate, isPending } = useSetAssignmentGrade(
    assignment.workspaceId,
    assignment.id
  );
  // Typed as text, so "7." can become 7.5; empty clears the grade. The
  // field refuses keys past the points (`typedMark`), so no message says so.
  const schema = useMemo(
    () =>
      z.object({
        points: z
          .string()
          .trim()
          .transform((value) => (value === '' ? undefined : Number(value)))
          .pipe(SetAssignmentGradeBody.shape.points),
      }),
    []
  );
  const {
    control,
    formState: { errors, isDirty },
    handleSubmit,
    reset,
  } = useForm({
    defaultValues: { points: text },
    mode: 'onSubmit',
    resolver: zodResolver(schema),
  });
  // A grade saved here or elsewhere: the field follows.
  useEffect(() => reset({ points: text }), [reset, text]);
  const save = handleSubmit(({ points: next }) => {
    if (next === saved) return;
    mutate(
      { points: next, userId: member.userId },
      {
        onError: (error) => {
          reset({ points: text });
          userToast({
            title: errorCopy(error, m.assignment_grade_failed()),
            variant: 'error',
          });
        },
        // Saved: not dirty, so Save waits for the next change.
        onSuccess: () =>
          reset({ points: next === undefined ? '' : String(next) }),
      }
    );
  });
  const label = m.assignment_grade_of({ name: member.name });
  return (
    <form
      className={cn('flex flex-col gap-1', className)}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Controller
          control={control}
          name="points"
          // The graded quiz's mark field (Epo 2026-11-19): it refuses keys
          // that would not make a grade, as marks do.
          render={({ field }) => (
            <MarkField
              className="shrink-0"
              label={label}
              marks={points}
              onChange={(next) =>
                field.onChange(next === null ? '' : String(next))
              }
              value={field.value === '' ? null : Number(field.value)}
            />
          )}
        />
        {/* At the mark field's 32px. */}
        <Button
          className="h-8"
          disabled={isPending || !isDirty}
          size="sm"
          type="submit"
          variant="outline"
        >
          {m.action_save()}
        </Button>
      </div>
      {errors.points?.message && (
        <InputError>{errors.points.message}</InputError>
      )}
    </form>
  );
}
