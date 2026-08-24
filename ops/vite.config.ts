import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
    server: {
      host: true,
      port: Number.parseInt(env.VITE_OPS_PORT, 10) || 5174,
      proxy: {
        '/api': {
          changeOrigin: true,
          target: env.VITE_OPS_API_URL || 'http://localhost:8082',
        },
      },
    },
  };
});
