import { Wllama } from '/runtime/wllama.js';

const status = document.querySelector('#status');
const startButton = document.querySelector('#start');
const show = (text) => {
  status.textContent = text;
};
async function timed(operation, milliseconds, label) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(
            `${label} timed out after ${milliseconds / 1000}s`
          );
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
    body: JSON.stringify(data),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(
      `Saving ${path} failed: ${response.status} ${await response.text()}`
    );
  return response.json();
}

startButton.addEventListener('click', async () => {
  startButton.disabled = true;
  try {
    const config = await (
      await fetch('/config', { signal: AbortSignal.timeout(30_000) })
    ).json();
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter)
      throw new Error('No WebGPU adapter; GPU benchmark cannot run.');
    const browser = {
      available_adapter: {
        architecture: adapter.info.architecture,
        description: adapter.info.description,
        device: adapter.info.device,
        vendor: adapter.info.vendor,
      },
      isolated: crossOriginIsolated,
      threads: crossOriginIsolated
        ? Math.min(4, navigator.hardwareConcurrency)
        : 1,
      userAgent: navigator.userAgent,
    };
    await post('/event', { browser, type: 'start' });
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
        const logger = Object.fromEntries(
          ['debug', 'log', 'warn', 'error'].map((level) => [
            level,
            (...args) => {
              const line = args
                .map((value) =>
                  value instanceof Error
                    ? (value.stack ?? String(value))
                    : String(value)
                )
                .join(' ');
              if (
                capturingLoad &&
                /webgpu|adapter|device|offload|buffer size|backend/i.test(line)
              )
                backendLog.push({ level, line });
              if (!capturingLoad) {
                runtimeLog.push({ level, line: line.slice(0, 1000) });
                if (runtimeLog.length > 100) runtimeLog.shift();
              }
              console[level](...args);
            },
          ])
        );
        llm = new Wllama({ default: '/runtime/wllama.wasm' }, { logger });
        if (!llm.isSupportWebGPU())
          throw new Error('wllama WebGPU support unavailable');
        show(`Loading ${model.id}`);
        const loading = performance.now();
        await timed(
          (signal) => {
            loadPromise = llm.loadModelFromUrl(
              location.origin + model.urls[0],
              {
                log_level: 2,
                n_ctx: config.settings.n_ctx,
                n_gpu_layers: 999,
                n_threads: browser.threads,
                progressCallback: ({ loaded, total }) =>
                  show(`Loading ${model.id}: ${loaded}/${total} bytes`),
                signal,
                useCache: false,
              }
            );
            return loadPromise;
          },
          180_000,
          'Model loading'
        );
        modelLoaded = true;
        const load_seconds = (performance.now() - loading) / 1000;
        capturingLoad = false;
        const info = llm.getLoadedContextInfo();
        await post('/event', {
          backend_log: backendLog,
          browser,
          load_seconds,
          model: model.id,
          runtime_context: {
            architecture: info.metadata['general.architecture'],
            n_batch: info.n_batch,
            n_ctx: info.n_ctx,
            n_layer: info.n_layer,
            n_ubatch: info.n_ubatch,
            threads: llm.getNumThreads(),
          },
          type: 'loaded',
        });
        for (let i = 0; i < cases.length; i++) {
          const item = cases[i];
          runtimeLog.length = 0;
          show(`${model.id}: ${i + 1}/${cases.length}`);
          const began = performance.now();
          let response;
          try {
            response = await timed(
              (abortSignal) =>
                llm.createChatCompletion({
                  abortSignal,
                  cache_prompt: false,
                  chat_template_kwargs: config.settings.chat_template_kwargs,
                  max_tokens: config.settings.max_tokens,
                  messages: [
                    { content: config.system, role: 'system' },
                    { content: item.prompt, role: 'user' },
                  ],
                  seed: config.settings.seed,
                  stream: false,
                  temperature: config.settings.temperature,
                }),
              180_000,
              'Grading'
            );
          } catch (error) {
            await post('/result', {
              browser,
              case_id: item.id,
              error: String(error),
              error_stack: error.stack ?? null,
              load_seconds,
              model: model.id,
              raw: '',
              runtime_log: runtimeLog.slice(),
              seconds: (performance.now() - began) / 1000,
            });
            // A rejected runtime call may leave the worker unusable.
            throw error;
          }
          await post('/result', {
            browser,
            case_id: item.id,
            load_seconds,
            model: model.id,
            raw: response.choices[0]?.message.content ?? '',
            response,
            seconds: (performance.now() - began) / 1000,
          });
        }
      } catch (error) {
        modelFailures++;
        await post('/event', {
          browser,
          error: String(error),
          model: model.id,
          type: 'model_failure',
        });
        if (error.name === 'TimeoutError' && !modelLoaded) {
          const cleanup = async () => {
            await llm.exit();
          };
          loadPromise?.then(cleanup, cleanup).catch(async (cleanupError) => {
            console.error(cleanupError);
            try {
              await post('/event', {
                browser,
                error: String(cleanupError),
                model: model.id,
                type: 'model_cleanup_failure',
              });
            } catch (saveError) {
              console.error(saveError);
            }
          });
          throw new Error(
            `${model.id} loading timed out. Reload this page before resuming the comparison.`
          );
        }
      } finally {
        if (llm) {
          try {
            await llm.exit();
          } catch (error) {
            await post('/event', {
              browser,
              error: String(error),
              model: model.id,
              type: 'model_cleanup_failure',
            });
          }
        }
      }
    }
    show(
      modelFailures
        ? `Browser comparison ended with ${modelFailures} model failure(s). Results saved locally.`
        : 'Browser comparison finished. Results saved locally.'
    );
    await post('/event', { model_failures: modelFailures, type: 'finished' });
  } catch (error) {
    show(String(error));
    await post('/event', { error: String(error), type: 'failure' });
  }
});
