import { useState } from 'react';
import { PageHeader, Panel } from '@/components/app/layout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Icon, type IconName } from '@/components/ui/Icon';
import { m } from '@/i18n';

const CHANNELS: {
  icon: IconName;
  tint: string;
  tintFg: string;
  title: () => string;
  body: () => string;
  action: () => string;
}[] = [
  {
    action: m.support_chat_action,
    body: m.support_chat_body,
    icon: 'message',
    tint: 'var(--tint-accent-1-bg)',
    tintFg: 'var(--tint-accent-1-fg)',
    title: m.support_chat_title,
  },
  {
    action: m.support_email_action,
    body: m.support_email_body,
    icon: 'bell',
    tint: 'var(--tint-info-bg)',
    tintFg: 'var(--tint-info-fg)',
    title: m.support_email_title,
  },
  {
    action: m.support_guides_action,
    body: m.support_guides_body,
    icon: 'book',
    tint: 'var(--tint-accent-2-bg)',
    tintFg: 'var(--tint-accent-2-fg)',
    title: m.support_guides_title,
  },
];

const FAQS: { q: () => string; a: () => string }[] = [
  { a: m.support_faq1_a, q: m.support_faq1_q },
  { a: m.support_faq2_a, q: m.support_faq2_q },
  { a: m.support_faq3_a, q: m.support_faq3_q },
  { a: m.support_faq4_a, q: m.support_faq4_q },
  { a: m.support_faq5_a, q: m.support_faq5_q },
];

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-divider border-b last:border-0">
      <button
        className="flex w-full items-center justify-between gap-4 py-4 text-left"
        onClick={() => setOpen((o) => !o)}
        type="button"
      >
        <p className="t-subtitle">{q}</p>
        <Icon
          className="shrink-0 text-fg-muted"
          name={open ? 'chevronDown' : 'chevronRight'}
          size={18}
        />
      </button>
      {open && <p className="pb-4 text-fg-secondary">{a}</p>}
    </div>
  );
}

export default function Support() {
  return (
    <Panel>
      <PageHeader subtitle={m.support_subtitle()} title={m.nav_support()} />
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="mx-auto flex max-w-4xl flex-col gap-8">
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {CHANNELS.map((c) => (
              <Card
                className="flex flex-col p-5.5"
                key={c.icon}
                radius="card-lg"
              >
                <span
                  className="flex h-11 w-11 items-center justify-center rounded-card"
                  style={{ background: c.tint, color: c.tintFg }}
                >
                  <Icon name={c.icon} size={20} />
                </span>
                <p className="t-card-title mt-3">{c.title()}</p>
                <p className="t-label mt-1 flex-1 text-fg-muted">{c.body()}</p>
                <Button
                  className="mt-4 self-start"
                  iconRight="arrowRight"
                  size="sm"
                  variant="outline"
                >
                  {c.action()}
                </Button>
              </Card>
            ))}
          </section>

          <section>
            <p className="t-large-card-title mb-3">{m.support_faq_heading()}</p>
            <div className="rounded-card-lg border border-line bg-surface px-5">
              {FAQS.map((f) => {
                const q = f.q();
                return <FaqItem a={f.a()} key={q} q={q} />;
              })}
            </div>
          </section>

          <section className="flex flex-col items-start gap-3 rounded-card-lg bg-tint-accent-1 px-6 py-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="t-subtitle text-tint-accent-1-fg">
                {m.support_stuck_title()}
              </p>
              <p className="t-meta mt-1 text-tint-accent-1-fg/80">
                {m.support_stuck_body()}
              </p>
            </div>
            <Button iconLeft="message" variant="accent">
              {m.support_contact()}
            </Button>
          </section>
        </div>
      </div>
    </Panel>
  );
}
