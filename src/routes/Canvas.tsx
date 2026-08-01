import { Link, useParams } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { useCanvas, useSaveCanvas } from '@/api/hooks';
import { PanelWithInvertedRadius } from '@/components/app/layout';
import { Skeleton } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';

const CanvasEditor = lazy(() => import('@/features/thinking/CanvasEditor'));

export default function Canvas() {
  const params = useParams({ strict: false });
  const canvasId = (params as { canvasId: string }).canvasId;
  const { data: canvas, isLoading } = useCanvas(canvasId);
  const save = useSaveCanvas(canvasId);

  return (
    <PanelWithInvertedRadius>
      <div className="flex items-center gap-3 border-divider border-b px-5 py-3">
        <Link
          className="text-fg-muted hover:text-fg"
          preload="intent"
          to="/thinking"
        >
          <Icon name="chevronLeft" size={20} />
        </Link>
        <p className="t-subtitle flex-1">{canvas?.name ?? 'Canvas'}</p>
        {save.isPending && <p className="t-meta text-fg-muted">Saving…</p>}
      </div>
      <div className="min-h-0 flex-1">
        {isLoading ? (
          <Skeleton className="h-full w-full rounded-none" />
        ) : (
          <Suspense
            fallback={<Skeleton className="h-full w-full rounded-none" />}
          >
            <CanvasEditor
              initialScene={canvas?.scene}
              onChange={(scene) => save.mutate({ scene })}
            />
          </Suspense>
        )}
      </div>
    </PanelWithInvertedRadius>
  );
}
