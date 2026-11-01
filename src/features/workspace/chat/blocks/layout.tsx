import { type ReactNode, useEffect, useState } from 'react';
import { Tabs } from '@/components/ui/Tabs';

/** Tab strip plus the selected panel. The selection survives streaming: new
 * tabs append without moving it, and a tab that vanished falls back to the
 * first one. */
export function ChatTabs({
  tabs,
}: {
  tabs: { content: ReactNode; label: string }[];
}) {
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    if (selected >= tabs.length) setSelected(0);
  }, [selected, tabs.length]);
  const active = tabs[selected] ?? tabs[0];
  if (!tabs.length) return null;
  return (
    <div>
      <Tabs
        className="mb-4 [&>button]:px-2 [&>button]:py-1.5 [&>button]:text-sm"
        onChange={(value) => setSelected(Number(value))}
        tabs={tabs.map((tab, index) => ({
          label: tab.label,
          value: String(index),
        }))}
        value={String(tabs.indexOf(active))}
      />
      <div className="flex flex-col gap-4">{active.content}</div>
    </div>
  );
}
