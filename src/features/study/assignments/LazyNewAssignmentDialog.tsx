import { type ComponentProps, lazy, Suspense } from 'react';

const Dialog = lazy(() =>
  import('./NewAssignmentDialog').then((module) => ({
    default: module.NewAssignmentDialog,
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
