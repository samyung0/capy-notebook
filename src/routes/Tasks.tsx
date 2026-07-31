import { useTasks, useToggleTask } from '@/api/hooks';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { Checkbox, SkeletonList } from '@/components/ui';
import { m } from '@/i18n';

export default function Tasks() {
  const { data, isLoading } = useTasks();
  const toggle = useToggleTask();

  const groups = (data ?? []).reduce<Record<string, typeof data>>((acc, t) => {
    const day = new Date(t.dueDate).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      weekday: 'long',
    });
    const tasksForDay = acc[day];
    if (tasksForDay) {
      tasksForDay.push(t);
    } else {
      acc[day] = [t];
    }
    return acc;
  }, {});

  return (
    <PanelWithInvertedRadius>
      <PageHeader title={m.nav_tasks()} />
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {isLoading ? (
          <div className="mx-auto max-w-2xl">
            <SkeletonList count={6} rowHeight={56} />
          </div>
        ) : data?.length ? (
          <div className="mx-auto flex max-w-2xl flex-col gap-6">
            {Object.entries(groups).map(([day, list]) => (
              <section key={day}>
                <p className="t-label mb-2 block text-fg-muted">{day}</p>
                <div className="flex flex-col gap-1">
                  {list?.map((t) => (
                    <button
                      className="flex items-start gap-3 rounded-card border border-line bg-surface px-4 py-3 text-left hover:bg-surface-hover-bg"
                      key={t.id}
                      onClick={() => toggle.mutate({ done: !t.done, id: t.id })}
                      type="button"
                    >
                      <Checkbox checked={t.done} size={22} tone="purple" />
                      <span className="min-w-0">
                        <span
                          className={
                            t.done
                              ? 'block font-medium text-fg-muted line-through'
                              : 'block font-medium text-fg'
                          }
                        >
                          {t.title}
                        </span>
                        {t.meta && (
                          <span className="block text-fg-muted text-xs">
                            {t.meta}
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <p className="py-8 text-center text-fg-muted">{m.tasks_empty()}</p>
        )}
      </div>
    </PanelWithInvertedRadius>
  );
}
