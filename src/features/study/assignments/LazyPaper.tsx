import { type ComponentProps, lazy, Suspense } from 'react';
import { SkeletonList } from '@/components/ui/feedback';
import { FileLoading } from '@/features/files/FileStates';

// react-pdf loads with the paper only: assignments without one never fetch it.
const PaperPaneImpl = lazy(() =>
  import('./PaperPane').then((mod) => ({ default: mod.PaperPane }))
);
const PaperPagesImpl = lazy(() =>
  import('./PaperPane').then((mod) => ({ default: mod.PaperPages }))
);
// The file viewer loads with a file's graded quiz only (Epo 2026-11-20).
const QuestionPaperCardImpl = lazy(() =>
  import('./QuestionPaper').then((mod) => ({
    default: mod.QuestionPaperCard,
  }))
);
const QuestionPaperViewImpl = lazy(() =>
  import('./QuestionPaper').then((mod) => ({
    default: mod.QuestionPaperView,
  }))
);

export function PaperPane(props: ComponentProps<typeof PaperPaneImpl>) {
  return (
    <Suspense fallback={<SkeletonList count={3} rowHeight={40} />}>
      <PaperPaneImpl {...props} />
    </Suspense>
  );
}

export function PaperPages(props: ComponentProps<typeof PaperPagesImpl>) {
  return (
    <Suspense fallback={<SkeletonList count={2} rowHeight={40} />}>
      <PaperPagesImpl {...props} />
    </Suspense>
  );
}

export function QuestionPaperCard(
  props: ComponentProps<typeof QuestionPaperCardImpl>
) {
  return (
    <Suspense
      fallback={
        <div className={props.className}>
          <SkeletonList count={2} rowHeight={32} />
        </div>
      }
    >
      <QuestionPaperCardImpl {...props} />
    </Suspense>
  );
}

export function QuestionPaperView(
  props: ComponentProps<typeof QuestionPaperViewImpl>
) {
  return (
    <Suspense fallback={<FileLoading />}>
      <QuestionPaperViewImpl {...props} />
    </Suspense>
  );
}
