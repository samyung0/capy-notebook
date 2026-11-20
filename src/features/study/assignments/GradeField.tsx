import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { SetAssignmentGradeBody } from '@/api/gen/validators';
import { useSetAssignmentGrade } from '@/api/hooks';
import type { Assignment, AssignmentMemberRow } from '@/api/types';
import { Input, InputError } from '@/components/ui/Input';
import { userToast } from '@/components/ui/userToast';
import { formatPoints } from '@/features/quizzes/grade';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';
import { typedMark } from './assignmentText';

/** A member's grade on a graded Assignment (Epo 2026-11-14), entered by staff
 * on the member's row: 0 to its points with one decimal place at most, saved on Enter or on
 * leaving the field; emptied, the grade is cleared. Shows the grade as given;
 * the row's late badge says what the penalty takes off. */
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
    formState: { errors },
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
      }
    );
  });
  const label = m.assignment_grade_of({ name: member.name });
  return (
    <form
      className={cn('flex w-28 flex-col gap-1', className)}
      noValidate
      // Inside a row that opens something: typing and clicking stay here.
      onClick={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Controller
        control={control}
        name="points"
        render={({ field, fieldState }) => (
          <Input
            aria-invalid={fieldState.invalid}
            aria-label={label}
            autoComplete="off"
            disabled={isPending}
            endText={`/ ${formatPoints(points)}`}
            inputMode="decimal"
            name={field.name}
            onBlur={() => {
              field.onBlur();
              void save();
            }}
            // Keys that would not make a grade are refused, as in a mark
            // field (Epo 2026-11-18).
            onChange={(event) => {
              const next = typedMark(event.target.value, points);
              if (next !== undefined) field.onChange(next);
            }}
            ref={field.ref}
            type="text"
            value={field.value}
            wrapperClassName="h-8 px-2.5"
          />
        )}
      />
      {errors.points?.message && (
        <InputError>{errors.points.message}</InputError>
      )}
    </form>
  );
}
