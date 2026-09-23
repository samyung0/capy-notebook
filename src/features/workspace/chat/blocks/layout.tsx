import { type ReactNode, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Tabs } from '@/components/ui/Tabs';
import type {
  AccordionItemProps,
  CardProps,
  FactProps,
  TabProps,
  TagsProps,
} from '../schema';
import { Cites, elements } from './Cite';
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
    <div className="my-3">
      <Tabs
        className="mb-2 [&>button]:px-2 [&>button]:py-1.5 [&>button]:text-xs"
        onChange={(value) => setSelected(Number(value))}
        tabs={tabs.map((tab, index) => ({
          label: tab.props.label,
          value: String(index),
        }))}
        value={String(tabs.indexOf(active))}
      />
      <div>{renderNode(active.props.children)}</div>
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
    <div className="my-3 flex flex-col">
      {elements<AccordionItemProps>(props.items).map((item, index) => (
        <details
          className="border-divider border-t py-2 last:border-b"
          key={index}
        >
          <summary className="cursor-pointer font-semibold text-xs">
            {item.props.title}
          </summary>
          <div className="mt-1.5">{renderNode(item.props.children)}</div>
        </details>
      ))}
    </div>
  );
}

export function Tags({ props }: { props: TagsProps }) {
  return (
    <div className="my-2 flex flex-wrap gap-1">
      {(props.tags ?? []).map((tag, index) => (
        <Badge key={`${index}-${tag}`} size="sm" tone="page">
          {tag}
        </Badge>
      ))}
    </div>
  );
}

export function Facts({ props }: { props: { items: unknown[] } }) {
  return (
    <dl className="my-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
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
    <div className="my-3 grid grid-cols-2 gap-2">
      {elements<CardProps>(props.items).map((card, index) => (
        <div
          className="rounded-card border border-divider px-3 py-2.5"
          key={index}
        >
          <p className="text-[11px] text-fg-muted">{card.props.title}</p>
          {card.props.value ? (
            <p className="font-semibold text-xl tracking-tight">
              {card.props.value}
            </p>
          ) : null}
          <Prose
            className="text-[12px] [&_p]:my-0.5"
            muted={!!card.props.value}
            text={card.props.text}
          />
          <Cites passages={card.props.passages} />
        </div>
      ))}
    </div>
  );
}
