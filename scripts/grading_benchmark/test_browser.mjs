import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (
  await readFile(new URL('./browser.js', import.meta.url), 'utf8')
).replace("import { Wllama } from '/runtime/wllama.js';", '');
const models = ['broken', 'healthy'];
const calls = [];
const posts = [];
const status = {};
let handler;
let instances = 0;
const button = {
  addEventListener: (_, callback) => {
    handler = callback;
  },
};
const config = {
  cases: [
    { id: 'first', prompt: 'First' },
    { id: 'second', prompt: 'Second' },
  ],
  models: models.map((id) => ({ id, urls: [`/${id}.gguf`] })),
  settings: {
    chat_template_kwargs: {},
    max_tokens: 80,
    n_ctx: 1024,
    seed: 1,
    temperature: 0.1,
  },
  system: 'Synthetic test',
};

class FakeWllama {
  constructor(_, { logger }) {
    this.id = models[instances++];
    this.logger = logger;
  }
  isSupportWebGPU() {
    return true;
  }
  async loadModelFromUrl() {}
  getLoadedContextInfo() {
    return { metadata: { 'general.architecture': 'synthetic' } };
  }
  getNumThreads() {
    return 4;
  }
  async createChatCompletion(request) {
    calls.push(`${this.id}:${request.messages[1].content}`);
    if (this.id === 'broken') {
      for (let i = 0; i < 110; i++)
        this.logger.debug(`${i}: ${'x'.repeat(1500)}`);
      this.logger.error('Synthetic native exception');
      throw new Error('Invalid magic number');
    }
    return {
      choices: [{ message: { content: '{"score":1,"reason":"Synthetic"}' } }],
    };
  }
  async exit() {
    calls.push(`${this.id}:exit`);
  }
}

vm.runInNewContext(source, {
  AbortController,
  AbortSignal,
  clearTimeout,
  console: Object.fromEntries(
    ['debug', 'log', 'warn', 'error'].map((level) => [level, () => {}])
  ),
  crossOriginIsolated: true,
  document: {
    querySelector: (selector) => (selector === '#status' ? status : button),
  },
  Error,
  fetch: async (path, options) => {
    if (path === '/config') return { json: async () => config };
    posts.push({ data: JSON.parse(options.body), path });
    return {
      json: async () =>
        path === '/pending'
          ? Object.fromEntries(models.map((id) => [id, ['first', 'second']]))
          : {},
      ok: true,
    };
  },
  location: { origin: 'http://127.0.0.1:18892' },
  navigator: {
    gpu: { requestAdapter: async () => ({ info: {} }) },
    hardwareConcurrency: 4,
    userAgent: 'synthetic',
  },
  performance,
  setTimeout,
  Wllama: FakeWllama,
});
await handler();

assert.deepEqual(calls, [
  'broken:First',
  'broken:exit',
  'healthy:First',
  'healthy:Second',
  'healthy:exit',
]);
const failed = posts.find(
  ({ path, data }) => path === '/result' && data.error
)?.data;
assert.equal(failed.case_id, 'first');
assert.match(failed.error_stack, /Invalid magic number/);
assert.equal(failed.runtime_log.length, 100);
assert.ok(failed.runtime_log.every(({ line }) => line.length <= 1000));
assert.equal(failed.runtime_log.at(-1).line, 'Synthetic native exception');
assert.ok(
  posts.find(
    ({ data }) => data.type === 'model_failure' && data.model === 'broken'
  )
);
assert.equal(posts.at(-1).data.model_failures, 1);
assert.match(status.textContent, /1 model failure/);
console.log(
  'PASS: runtime failure retains bounded logs, stops that model, releases its worker and reports incomplete execution.'
);
