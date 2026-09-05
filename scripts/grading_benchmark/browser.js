import { Wllama } from '/runtime/wllama.js';

const status = document.querySelector('#status');
const startButton = document.querySelector('#start');
const show = (text) => { status.textContent = text; };
async function timed(operation, milliseconds, label) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${label} timed out after ${milliseconds / 1000}s`);
          error.name = 'TimeoutError';
          reject(error);
          controller.abort();
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function post(path, data) {
  const response = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Saving ${path} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

startButton.addEventListener('click', async () => {
  startButton.disabled = true;
  try {
    const config = await (await fetch('/config', { signal: AbortSignal.timeout(30000) })).json();
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter; GPU benchmark cannot run.');
    const browser = {
      userAgent: navigator.userAgent, isolated: crossOriginIsolated,
      threads: crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency) : 1,
      available_adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
        device: adapter.info.device, description: adapter.info.description },
    };
    await post('/event', { type: 'start', browser });
    const pending = await post('/pending', { browser });
    let modelFailures = 0;
    for (const model of config.models) {
      const ids = new Set(pending[model.id]);
      const cases = config.cases.filter((item) => ids.has(item.id));
      if (!cases.length) continue;
      let llm;
      let loadPromise;
      let modelLoaded = false;
      try {
        const backendLog = [];
        const runtimeLog = [];
        let capturingLoad = true;
        const logger = Object.fromEntries(['debug', 'log', 'warn', 'error'].map((level) => [level, (...args) => {
          const line = args.map((value) => value instanceof Error ? (value.stack ?? String(value)) : String(value)).join(' ');
          if (capturingLoad && /webgpu|adapter|device|offload|buffer size|backend/i.test(line)) backendLog.push({ level, line });
          if (!capturingLoad) {
            runtimeLog.push({ level, line: line.slice(0, 1000) });
            if (runtimeLog.length > 100) runtimeLog.shift();
          }
          console[level](...args);
        }]));
        llm = new Wllama({ default: '/runtime/wllama.wasm' }, { logger });
        if (!llm.isSupportWebGPU()) throw new Error('wllama WebGPU support unavailable');
        show(`Loading ${model.id}`);
        const loading = performance.now();
        await timed((signal) => {
          loadPromise = llm.loadModelFromUrl(location.origin + model.urls[0], {
            n_ctx: config.settings.n_ctx, n_gpu_layers: 999, n_threads: browser.threads,
            useCache: false, signal, log_level: 2,
            progressCallback: ({ loaded, total }) => show(`Loading ${model.id}: ${loaded}/${total} bytes`),
          });
          return loadPromise;
        }, 180000, 'Model loading');
        modelLoaded = true;
        const load_seconds = (performance.now() - loading) / 1000;
        capturingLoad = false;
        const info = llm.getLoadedContextInfo();
        await post('/event', { type: 'loaded', model: model.id, load_seconds, browser,
          runtime_context: { n_ctx: info.n_ctx, n_layer: info.n_layer, n_batch: info.n_batch,
            n_ubatch: info.n_ubatch, threads: llm.getNumThreads(), architecture: info.metadata['general.architecture'] },
          backend_log: backendLog });
        for (let i = 0; i < cases.length; i++) {
          const item = cases[i];
          runtimeLog.length = 0;
          show(`${model.id}: ${i + 1}/${cases.length}`);
          const began = performance.now();
          let response;
          try {
            response = await timed((abortSignal) => llm.createChatCompletion({
              max_tokens: config.settings.max_tokens, temperature: config.settings.temperature,
              seed: config.settings.seed, chat_template_kwargs: config.settings.chat_template_kwargs,
              cache_prompt: false,
              messages: [{ role: 'system', content: config.system }, { role: 'user', content: item.prompt }],
              stream: false,
              abortSignal,
            }), 180000, 'Grading');
          } catch (error) {
            await post('/result', {
              model: model.id, case_id: item.id, raw: '', error: String(error),
              error_stack: error.stack ?? null, runtime_log: runtimeLog.slice(),
              seconds: (performance.now() - began) / 1000, load_seconds, browser,
            });
            // A rejected runtime call may leave the worker unusable.
            throw error;
          }
          await post('/result', {
            model: model.id, case_id: item.id, raw: response.choices[0]?.message.content ?? '',
            response, seconds: (performance.now() - began) / 1000, load_seconds, browser,
          });
        }
      } catch (error) {
        modelFailures++;
        await post('/event', { type: 'model_failure', model: model.id, browser, error: String(error) });
        if (error.name === 'TimeoutError' && !modelLoaded) {
          const cleanup = async () => { await llm.exit(); };
          loadPromise?.then(cleanup, cleanup).catch(async (cleanupError) => {
            console.error(cleanupError);
            try {
              await post('/event', { type: 'model_cleanup_failure', model: model.id, browser, error: String(cleanupError) });
            } catch (saveError) { console.error(saveError); }
          });
          throw new Error(`${model.id} loading timed out. Reload this page before resuming the comparison.`);
        }
      } finally {
        if (llm) {
          try { await llm.exit(); }
          catch (error) {
            await post('/event', { type: 'model_cleanup_failure', model: model.id, browser, error: String(error) });
          }
        }
      }
    }
    show(modelFailures ? `Browser comparison ended with ${modelFailures} model failure(s). Results saved locally.`
      : 'Browser comparison finished. Results saved locally.');
    await post('/event', { type: 'finished', model_failures: modelFailures });
  } catch (error) {
    show(String(error));
    await post('/event', { type: 'failure', error: String(error) });
  }
});
