import '@maily-to/core/style.css';

import type { ReactNode } from 'react';
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from 'react-router';
import { Toaster } from 'sonner';
import type { Route } from './+types/root';
import stylesheet from './app.css?url';

export const links: Route.LinksFunction = () => [
  { href: stylesheet, rel: 'stylesheet' },
  {
    as: 'font',
    crossOrigin: 'anonymous',
    href: '/fonts/inter.woff2',
    rel: 'preload',
    type: 'font/woff2',
  },
  { href: '/brand/icon.svg', rel: 'icon', type: 'image/svg+xml' },
];

export const meta: Route.MetaFunction = () => [
  { title: 'Capy Notebook email editor' },
  {
    content: 'Local Maily editor for Capy Notebook email templates.',
    name: 'description',
  },
  { content: 'noindex, nofollow', name: 'robots' },
];

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta content="width=device-width, initial-scale=1" name="viewport" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
        <Toaster richColors />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = 'Email editor failed';
  let details = 'An unexpected error occurred.';

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? 'Not found' : 'Email editor failed';
    details = error.statusText || details;
  } else if (error instanceof Error) {
    details = error.message;
  }

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="font-semibold text-2xl">{message}</h1>
      <p className="mt-2 text-gray-600">{details}</p>
    </main>
  );
}
