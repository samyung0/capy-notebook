import { type ComponentProps, lazy, Suspense } from 'react';
import { SkeletonList } from '@/components/ui/feedback';

// react-pdf loads with the paper only: assignments without one never fetch it.
const PaperPaneImpl = lazy(() =>
  import('./PaperPane').then((mod) => ({ default: mod.PaperPane }))
);
const PaperPagesImpl = lazy(() =>
  import('./PaperPane').then((mod) => ({ default: mod.PaperPages }))
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
