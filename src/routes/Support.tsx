import { useState } from 'react';
import { PageHeader, Panel } from '@/components/app/layout';
import { Button, Card, Icon, type IconName } from "@/components/ui";
import { m } from "@/i18n";

const CHANNELS: {
  icon: IconName;
  tint: string;
  tintFg: string;
  title: string;
  body: string;
  action: string;
}[] = [
  {
    action: "Start a chat",
    body: "Questions about a workspace, an import, or a quiz? Send a message and the team replies within a day.",
    icon: "message",
    tint: "var(--tint-accent-1-bg)",
    tintFg: "var(--tint-accent-1-fg)",
    title: "Chat with us",
  },
  {
    action: "Send an email",
    body: "Prefer email? Reach us at hello@evonotes.app and we’ll pick it up from there.",
    icon: "bell",
    tint: "var(--tint-info-bg)",
    tintFg: "var(--tint-info-fg)",
    title: "Email support",
  },
  {
    action: "Browse guides",
    body: "Step-by-step walkthroughs for building workspaces, generating study sets, and tracking progress.",
    icon: "book",
    tint: "var(--tint-accent-2-bg)",
    tintFg: "var(--tint-accent-2-fg)",
    title: "Guides & docs",
  },
];

const FAQS: { q: string; a: string }[] = [
  {
    a: "When you add a source, it’s processed into a knowledge base scoped to that workspace. Chat answers and generated summaries, flashcards, and quizzes are grounded only in your own materials.",
    q: "How are my files turned into summaries and quizzes?",
  },
  {
    a: "Workspaces are private by default. You can switch one to public or share it with a link from the workspace’s edit menu. Nothing is shared until you choose to.",
    q: "Who can see my workspaces?",
  },
  {
    a: "Yes — open a workspace, choose Add source, and pick a drive. Drive import activates once the backend connection is set up; uploading from your computer works today.",
    q: "Can I import from Google Drive or OneDrive?",
  },
  {
    a: "Multiple choice, multi-select, true/false, fill-in-the-blank, short answer, matching, and ordering — across easy, medium, and hard difficulty. Pick the mix when you generate.",
    q: "What kinds of quiz questions can I generate?",
  },
  {
    a: "Open Evo Notes on consecutive days to grow your streak, shown at the top of the dashboard. Miss a day and it resets — no penalty beyond starting again.",
    q: "How does the login streak work?",
  },
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
          name={open ? "chevronDown" : "chevronRight"}
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
      <PageHeader
        subtitle="Find an answer or reach the team — we’re happy to help."
        title={m.nav_support()}
      />
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="mx-auto flex max-w-4xl flex-col gap-8">
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {CHANNELS.map((c) => (
              <Card
                className="flex flex-col p-5.5"
                key={c.title}
                radius="card-lg"
              >
                <span
                  className="flex h-11 w-11 items-center justify-center rounded-card"
                  style={{ background: c.tint, color: c.tintFg }}
                >
                  <Icon name={c.icon} size={20} />
                </span>
                <p className="mt-3 t-card-title">{c.title}</p>
                <p className="mt-1 flex-1 text-fg-muted t-label">{c.body}</p>
                <Button
                  className="mt-4 self-start"
                  iconRight="arrowRight"
                  size="sm"
                  variant="outline"
                >
                  {c.action}
                </Button>
              </Card>
            ))}
          </section>

          <section>
            <p className="mb-3 t-large-card-title">Frequently asked</p>
            <div className="rounded-card-lg border border-line bg-surface px-5">
              {FAQS.map((f) => (
                <FaqItem a={f.a} key={f.q} q={f.q} />
              ))}
            </div>
          </section>

          <section className="flex flex-col items-start gap-3 rounded-card-lg bg-tint-accent-1 px-6 py-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-tint-accent-1-fg t-subtitle">Still stuck?</p>
              <p className="mt-1 text-tint-accent-1-fg/80 t-meta">
                Send the team a note and we’ll get you unblocked.
              </p>
            </div>
            <Button iconLeft="message" variant="accent">
              Contact support
            </Button>
          </section>
        </div>
      </div>
    </Panel>
  );
}
