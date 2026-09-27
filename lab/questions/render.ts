/** Render real question components locally; export graph SVGs without uploading. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createServer } from 'vite';
import type { Question } from '../../src/features/questions/types';

const root = path.resolve(import.meta.dirname, '../..');
console.info('Starting local question renderer.');
if (!process.argv[2])
  throw new Error('Pass a topic directory under data/question-bank.');
const topic = path.resolve(process.argv[2]);
const relative = path.relative(
  path.join(root, 'data/question-bank'),
  topic,
);
if (relative.startsWith('..') || path.isAbsolute(relative))
  throw new Error('Topic must be under data/question-bank.');
let assetBase = process.env.BANK_ASSETS_URL;
if (!assetBase) {
  const env = await readFile(path.join(root, '.env.local'), 'utf8');
  assetBase = env
    .split(/\r?\n/)
    .find((line) => line.startsWith('BANK_ASSETS_URL='))
    ?.slice('BANK_ASSETS_URL='.length)
    .trim()
    .replace(/^["']|["']$/g, '');
}
const files = (await readdir(path.join(topic, 'questions')))
  .filter((name) => name.endsWith('.json'))
  .sort();
if (!files.length) throw new Error('No questions to render.');
await mkdir(path.join(topic, 'render'), { recursive: true });
await mkdir(path.join(topic, 'assets'), { recursive: true });
const server = await createServer({
  root,
  cacheDir: path.join(root, 'node_modules/.vite-question-render'),
  configFile: false,
  logLevel: 'error',
  resolve: {
    alias: {
      '@': path.join(root, 'src'),
      '@paraglide': path.join(root, 'src/i18n/paraglide'),
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'bank-render',
      configureServer(instance) {
        instance.middlewares.use((req, res, next) => {
          if (req.url !== '/bank-render') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(
            '<!doctype html><html lang="en" data-style="classroom" data-theme="latte"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/lab/questions/render-client.tsx"></script></body></html>',
          );
        });
      },
    },
  ],
  optimizeDeps: {
    noDiscovery: true,
    include: ['react', 'react-dom/client', 'react/jsx-runtime'],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
await server.listen();
console.info('Local renderer listening.');
const address = server.httpServer?.address();
if (!address || typeof address === 'string')
  throw new Error('Renderer did not bind.');
const browser = await chromium.launch({ headless: true });
console.info('Headless browser ready.');
const manifest: Record<string, string> = {};
const learnerManifest: Record<
  string,
  { question_sha256: string; image_sha256: string }
> = {};
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 900 },
    deviceScaleFactor: 1,
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/bank-render`);
  await page.waitForFunction(
    () => typeof window.renderBankQuestion === 'function',
  );
  if (errors.length) throw new Error(errors.join('\n'));
  for (const [index, name] of files.entries()) {
    errors.length = 0;
    const file = path.join(topic, 'questions', name);
    const question: Question = JSON.parse(await readFile(file, 'utf8'));
    const rendered = await page.evaluate(
      (q) => window.renderBankQuestion(q),
      question,
    );
    if (errors.length) throw new Error(errors.join('\n'));
    await page.screenshot({
      path: path.join(topic, 'render', `${question.id}.png`),
      fullPage: true,
    });
    await page.evaluate(
      (q) => window.renderBankLearner(q),
      rendered.question,
    );
    if (errors.length) throw new Error(errors.join('\n'));
    const learnerPng = await page.screenshot({
      path: path.join(topic, 'render', `${question.id}.learner.png`),
      fullPage: true,
    });
    for (const [key, svg] of Object.entries(rendered.assets))
      await writeFile(path.join(topic, 'assets', key), svg);
    for (const blocks of [
      rendered.question.stem,
      ...rendered.question.parts.flatMap((part) => [
        part.blocks,
        part.solution,
      ]),
    ]) {
      for (const block of blocks) {
        if (block.type !== 'graph' || !('svg' in block.image)) continue;
        if (!assetBase || new URL(assetBase).protocol !== 'https:')
          throw new Error('Graph export requires BANK_ASSETS_URL.');
        const key = `${createHash('sha256').update(block.image.svg).digest('hex')}.svg`;
        block.image = { url: `${assetBase.replace(/\/$/, '')}/${key}` };
      }
    }
    const original = await readFile(file, 'utf8');
    const content =
      JSON.stringify(rendered.question) === JSON.stringify(question)
        ? original
        : `${JSON.stringify(rendered.question, null, 2)}\n`;
    if (content !== original) await writeFile(file, content);
    manifest[question.id] = createHash('sha256')
      .update(content)
      .digest('hex');
    learnerManifest[question.id] = {
      question_sha256: manifest[question.id],
      image_sha256: createHash('sha256').update(learnerPng).digest('hex'),
    };
    if ((index + 1) % 10 === 0 || index + 1 === files.length)
      console.info(`Rendered ${index + 1}/${files.length} questions.`);
  }
  await writeFile(
    path.join(topic, 'render/manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(
    path.join(topic, 'render/learner-manifest.json'),
    `${JSON.stringify(learnerManifest, null, 2)}\n`,
  );
  console.info(
    `Completed ${files.length} questions and both render manifests.`,
  );
} finally {
  await browser.close();
  await server.close();
}
