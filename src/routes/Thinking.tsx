import { Link } from '@tanstack/react-router';
import { useCanvases, useCreateCanvas } from '@/api/hooks';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { Card, Icon, IconButton, SkeletonCardGrid } from '@/components/ui';
import { m } from '@/i18n';

export default function Thinking() {
  const { data, isLoading } = useCanvases();
  const create = useCreateCanvas();

  return (
    <PanelWithInvertedRadius>
      <PageHeader
        actions={
          <IconButton
            icon="plus"
            label="New canvas"
            onClick={() => {
              const n = prompt('Canvas name');
              if (n) create.mutate(n);
            }}
            variant="dark"
          />
        }
        title={m.nav_thinking()}
      />
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {isLoading ? (
          <SkeletonCardGrid cardHeight={172} count={6} />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data?.map((c, i) => (
              <Link
                key={c.id}
                params={{ canvasId: c.id }}
                preload="intent"
                to="/thinking/$canvasId"
              >
                <Card
                  className="overflow-hidden p-0"
                  interactive
                  radius="card-lg"
                >
                  <div
                    className="flex h-28 items-center justify-center"
                    style={{
                      background:
                        i % 2
                          ? 'var(--note-purple-bg)'
                          : 'var(--note-green-bg)',
                      color:
                        i % 2
                          ? 'var(--note-purple-fg)'
                          : 'var(--note-green-fg)',
                    }}
                  >
                    <Icon name="write" size={28} />
                  </div>
                  <div className="p-4">
                    <p className="t-subtitle truncate">{c.name}</p>
                    <p className="t-meta mt-0.5 text-fg-muted">
                      Updated {new Date(c.updatedAt).toLocaleDateString()}
                    </p>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </PanelWithInvertedRadius>
  );
}
