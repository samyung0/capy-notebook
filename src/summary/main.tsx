import { Component, type ReactNode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import fileIcons from '@/assets/catppuccin.svg?no-inline';
import { AppAuthProvider } from '@/components/app/AuthProvider';
import {
  PublicAccountNav,
  PublicAccountSkeleton,
  PublicSignedOutNav,
} from '@/components/app/PublicHeader';
import { track } from '@/lib/observability';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { SummaryFailure } from './SummaryFailure';

const authRoot = document.getElementById('summary-auth');
const errorRoot = document.getElementById('summary-error');
const workspaceId = authRoot?.dataset.workspaceId;
const locale = (authRoot ?? errorRoot)?.dataset.locale === 'zh' ? 'zh' : 'en';
const returnTo = workspaceId ? `/workspaces/${workspaceId}` : '/';

// biome-ignore lint/style/useReactFunctionComponents: React error boundaries require a class.
class IslandBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <PublicSignedOutNav locale={locale} returnTo={returnTo} />
    ) : (
      this.props.children
    );
  }
}

if (authRoot) {
  if (workspaceId) track('summary_viewed', { workspaceId });
  createRoot(authRoot).render(
    <ThemeProvider>
      <IslandBoundary>
        <AppAuthProvider pending={<PublicAccountSkeleton locale={locale} />}>
          <PublicAccountNav locale={locale} returnTo={returnTo} />
        </AppAuthProvider>
      </IslandBoundary>
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
