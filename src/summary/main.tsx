import { createRoot, hydrateRoot } from 'react-dom/client';
import fileIcons from '@/assets/catppuccin.svg?no-inline';
import { PublicActionMenu } from '@/components/app/PublicActionMenu';
import { PublicNav } from '@/components/app/PublicHeader';
import { track } from '@/lib/observability';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { SummaryFailure } from './SummaryFailure';

const navRoot = document.getElementById('summary-nav');
const actionsRoot = document.getElementById('summary-actions');
const errorRoot = document.getElementById('summary-error');
const workspaceId = actionsRoot?.dataset.workspaceId;
const locale = (navRoot ?? errorRoot)?.dataset.locale === 'zh' ? 'zh' : 'en';

if (workspaceId) track('summary_viewed', { workspaceId });

// The Worker renders both islands; rendering them again (not hydrating) lets
// the theme toggle show this browser's theme without a hydration mismatch.
// Neither reads auth, so nothing shifts.
if (navRoot) {
  createRoot(navRoot).render(
    <ThemeProvider>
      <PublicNav locale={locale} />
    </ThemeProvider>
  );
}

if (actionsRoot && workspaceId) {
  createRoot(actionsRoot).render(
    <ThemeProvider>
      <PublicActionMenu id={workspaceId} kind="workspace" locale={locale} />
    </ThemeProvider>
  );
}

if (errorRoot) {
  hydrateRoot(
    errorRoot,
    <ThemeProvider>
      <SummaryFailure
        locale={locale}
        status={Number(errorRoot.dataset.status)}
      />
    </ThemeProvider>
  );
}

// The summary and file panel reference the same Vite-hashed sprite.
for (const icon of document.querySelectorAll<SVGUseElement>(
  'use[data-file-icon]'
)) {
  icon.setAttribute('href', `${fileIcons}#${icon.dataset.fileIcon}`);
}
