import { type ComponentProps, lazy, Suspense } from 'react';

const Dialog = lazy(() =>
  import('./NewAssignmentDialog').then((module) => ({
    default: module.NewAssignmentDialog,
  }))
);

const Graded = lazy(() =>
  import('./GradedQuizDialog').then((module) => ({
    default: module.GradedQuizDialog,
  }))
);

/** The form is heavy and only loads once someone opens it. */
export function NewAssignmentDialog(props: ComponentProps<typeof Dialog>) {
  return (
    <Suspense fallback={null}>
      <Dialog {...props} />
    </Suspense>
  );
}

/** New graded quiz, with Add quiz's tabs: loaded as it opens. */
export function GradedQuizDialog(props: ComponentProps<typeof Graded>) {
  return (
    <Suspense fallback={null}>
      <Graded {...props} />
    </Suspense>
  );
}
