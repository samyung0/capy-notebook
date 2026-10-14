import { type ReactNode, useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Tabs } from '@/components/ui/Tabs';
import type {
  AccordionItemProps,
  CardProps,
  FactProps,
  TabProps,
} from '../schema';
import { elements } from './Cite';
import { Prose } from './text';

type Render = (value: unknown) => ReactNode;

/** Tab strip plus the selected panel. The selection survives streaming: new
 * tabs append without moving it, and a tab that vanished falls back to the
 * first one. */
export function ChatTabs({
  props,
  renderNode,
}: {
  props: { items: unknown[] };
  renderNode: Render;
}) {
  const tabs = elements<TabProps>(props.items);
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    if (selected >= tabs.length) setSelected(0);
  }, [selected, tabs.length]);
  const active = tabs[selected] ?? tabs[0];
  if (!tabs.length) return null;
  return (
    <div>
      <Tabs
        className="mb-3 [&>button]:px-2 [&>button]:py-1.5 [&>button]:text-sm"
        onChange={(value) => setSelected(Number(value))}
        tabs={tabs.map((tab, index) => ({
          label: tab.props.label,
          value: String(index),
        }))}
        value={String(tabs.indexOf(active))}
      />
      <div className="flex flex-col gap-3">
        {renderNode(active.props.children)}
      </div>
    </div>
  );
}

export function Accordion({
  props,
  renderNode,
}: {
  props: { items: unknown[] };
  renderNode: Render;
}) {
  return (
    <div className="flex flex-col">
      {elements<AccordionItemProps>(props.items).map((item, index) => (
        <details
          className="group border-divider border-t py-2.5 last:border-b"
          key={index}
        >
          <summary className="flex cursor-pointer list-none items-center gap-1.5 font-semibold text-sm [&::-webkit-details-marker]:hidden">
            <Icon
              className="text-fg-muted transition-transform group-open:rotate-90"
              name="chevronRight"
              size={12}
            />
            {item.props.title}
          </summary>
          <div className="mt-3 flex flex-col gap-3 pl-3">
            {renderNode(item.props.children)}
          </div>
        </details>
      ))}
    </div>
  );
}

export function Facts({ props }: { props: { items: unknown[] } }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {elements<FactProps>(props.items).map((fact, index) => (
        <div className="contents" key={index}>
          <dt className="text-fg-muted">{fact.props.label}</dt>
          <dd className="text-right">{fact.props.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Cards({ props }: { props: { items: unknown[] } }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {elements<CardProps>(props.items).map((card, index) => (
        <div className="rounded-lg border border-line px-3 py-2.5" key={index}>
          <p className="text-fg-muted text-xs">{card.props.title}</p>
          {card.props.value ? (
            <p className="font-semibold text-xl tracking-tight">
              {card.props.value}
            </p>
          ) : null}
          <Prose
            className="text-sm"
            muted={!!card.props.value}
            passages={card.props.passages}
            text={card.props.text}
          />
        </div>
      ))}
    </div>
  );
}
