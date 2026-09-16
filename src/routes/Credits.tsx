import { Link } from '@tanstack/react-router';
import { PageHeader, Panel } from '@/components/app/layout';
import { FileIcon } from '@/components/ui/FileIcon';
import { m } from '@/i18n';
import { iconUrl } from '@/lib/icon-catalog';
import credits from '@/lib/icon-credits.json';

export default function Credits() {
  return (
    <Panel>
      <PageHeader subtitle={m.credits_hint()} title={m.credits_title()} />
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="mx-auto max-w-3xl">
          <Link
            className="mb-5 inline-block text-link hover:underline"
            to="/help-and-legal"
          >
            {m.nav_help_legal()}
          </Link>
          <div className="divide-y divide-divider rounded-card-lg border border-line bg-surface px-5">
            {credits.map((credit) => (
              <section className="flex items-start gap-4 py-5" key={credit.id}>
                {credit.id === 'catppuccin' ? (
                  <span className="flex size-14 shrink-0 items-center justify-center rounded-card bg-surface-hover-bg">
                    <FileIcon name="markdown" size={28} />
                  </span>
                ) : (
                  <img
                    alt=""
                    className="size-14 shrink-0 rounded-card"
                    height={56}
                    src={iconUrl(`${credit.id}-01`)}
                    width={56}
                  />
                )}
                <div className="min-w-0">
                  <h2 className="t-subtitle">
                    {credit.name}{' '}
                    <span className="font-normal text-fg-muted">
                      {m.credits_by({ author: credit.author })}
                    </span>
                  </h2>
                  <p className="t-meta mt-1 text-fg-muted">
                    {credit.id === 'catppuccin'
                      ? m.credits_adapted_theme()
                      : credit.id === 'slice' || credit.id === 'avataaars'
                        ? m.credits_adapted_colors()
                        : m.credits_adapted()}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-link text-sm">
                    <a href={credit.source} rel="noreferrer" target="_blank">
                      {m.credits_source()}
                    </a>
                    <a
                      href={credit.license.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {credit.id === 'avataaars'
                        ? m.credits_free_license()
                        : credit.license.name}
                    </a>
                  </div>
                </div>
              </section>
            ))}
          </div>
          <section className="mt-6 text-fg-muted text-sm">
            <h2 className="t-subtitle text-fg">DiceBear</h2>
            <p className="mt-1">{m.credits_generator()}</p>
            <div className="mt-2 flex flex-wrap gap-4 text-link">
              <a
                href="https://www.dicebear.com/"
                rel="noreferrer"
                target="_blank"
              >
                {m.credits_source()}
              </a>
              <a
                href="/icons/LICENSE-dicebear-core.txt"
                rel="noreferrer"
                target="_blank"
              >
                {m.credits_mit_notice()}
              </a>
              <a href="/icons/CREDITS.md" rel="noreferrer" target="_blank">
                {m.credits_notices()}
              </a>
            </div>
          </section>
        </div>
      </div>
    </Panel>
  );
}
