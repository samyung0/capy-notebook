import type { Connect, Plugin } from 'vite';

const HF_HOSTS = new Set(['huggingface.co', 'cdn-lfs.huggingface.co']);

function isolateRuntime(
  url: string,
  res: {
    setHeader(name: string, value: string): void;
  }
) {
  const path = url.split('?')[0] ?? '';
  if (path !== '/llm-runtime.html' && !path.startsWith('/src/llm-runtime')) {
    return;
  }
  const ancestors = [
    "'self'",
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    process.env.VITE_APP_URL,
  ]
    .filter(Boolean)
    .join(' ');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  // Chrome 137+: isolate this frame without requiring the parent to be
  // isolated. COOP/COEP alone cannot do that.
  res.setHeader('Document-Isolation-Policy', 'isolate-and-credentialless');
  res.setHeader('Content-Security-Policy', `frame-ancestors ${ancestors}`);
}

function isolationMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    isolateRuntime(req.url ?? '', res);
    next();
  };
}

/** Isolation headers only on the judge iframe document. DIP (Chrome 137+)
 * isolates that frame without isolating the SPA. */
export function llmRuntimePlugin(): Plugin {
  return {
    configurePreviewServer(server) {
      server.middlewares.use(isolationMiddleware());
    },
    configureServer(server) {
      server.middlewares.use(isolationMiddleware());
    },
    name: 'llm-runtime-isolation',
  };
}

export function isAllowedModelHost(hostname: string): boolean {
  return HF_HOSTS.has(hostname);
}
