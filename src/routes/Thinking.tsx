import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { createCanvasBodyNameMax } from '@/api/gen/validators';
import { useCanvases, useCreateCanvas } from '@/api/hooks';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Card } from '@/components/ui/Card';
import { SkeletonCardGrid } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { NameFormDialog } from '@/components/ui/NameFormDialog';
import { getLocale, m } from '@/i18n';

export default function Thinking() {
  const { data, fetchStatus, isLoading } = useCanvases();
  const { mutateAsync: createCanvas } = useCreateCanvas();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <PanelWithInvertedRadius>
      <PageHeader
        actions={
          <IconButton
            icon="plus"
            label={m.thinking_new_canvas()}
            onClick={() => setCreateOpen(true)}
            variant="dark"
          />
        }
        title={m.nav_thinking()}
      />
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {fetchStatus === 'paused' ? (
          <QueryPausedState />
        ) : isLoading ? (
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
                      {m.thinking_updated({
                        date: new Date(c.updatedAt).toLocaleDateString(
                          getLocale()
                        ),
                      })}
                    </p>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
      {createOpen && (
        <NameFormDialog
          fieldLabel={m.common_name()}
          maxLength={createCanvasBodyNameMax}
          onClose={() => setCreateOpen(false)}
          onSubmit={(name) => createCanvas(name)}
          open
          submitLabel={m.action_create()}
          title={m.thinking_new_canvas()}
        />
      )}
    </PanelWithInvertedRadius>
  );
}
