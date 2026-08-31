import { resolve } from 'node:path';
import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    // The editor is lazy-loaded. Prebundle its UI dependencies so Vite does
    // not invalidate React Router's dependency graph after the first paint.
    include: [
      '@maily-to/core',
      '@maily-to/core/extensions',
      '@radix-ui/react-dialog',
      '@radix-ui/react-slot',
      '@radix-ui/react-tooltip',
      'class-variance-authority',
      'clsx',
      'lowlight',
      'lucide-react',
      'sonner',
      'tailwind-merge',
      'zod',
    ],
  },
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    alias: { '~': resolve(import.meta.dirname, 'app') },
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: '127.0.0.1',
    port: 3000,
    strictPort: true,
  },
  ssr: {
    noExternal: [/^@maily-to\//, /^@radix-ui\//, /^@tiptap\//],
  },
});
