import { Wllama } from '@wllama/wllama';
import wasmUrl from '@wllama/wllama/esm/wasm/wllama.wasm?url';
import { GRADE_SYSTEM } from '@/features/quizzes/judge';
import {
  isRuntimeRequest,
  type RuntimeRequest,
  type RuntimeResponse,
} from './protocol';

const parentOrigin = document.referrer ? new URL(document.referrer).origin : '';

let wllama: Wllama | null = null;
let loadedModelId = '';

function reply(target: MessageEvent['source'], msg: RuntimeResponse) {
  if (!target || !('postMessage' in target) || !parentOrigin) return;
  (target as Window).postMessage(msg, parentOrigin);
}

function threads(): number {
  if (!crossOriginIsolated) return 1;
  const n = navigator.hardwareConcurrency || 2;
  return Math.min(4, Math.max(2, n));
}

async function engine(): Promise<Wllama> {
  if (wllama) return wllama;
  const next = new Wllama({ default: wasmUrl });
  wllama = next;
  return next;
}

async function hasWebgpu(): Promise<boolean> {
  if (!navigator.gpu) return false;
  try {
    return Boolean(await navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function ensureModel(
  source: MessageEvent['source'],
  id: string,
  modelId: string,
  url: string,
  gpuLayers: number
) {
  const llm = await engine();
  if (loadedModelId === modelId && llm.isModelLoaded()) return llm;
  const offload =
    gpuLayers > 0 && llm.isSupportWebGPU() && (await hasWebgpu())
      ? gpuLayers
      : 0;
  await llm.loadModelFromUrl(url, {
    n_ctx: 1024,
    n_gpu_layers: offload,
    n_threads: threads(),
    progressCallback: ({ loaded, total }) => {
      reply(source, {
        id,
        loaded,
        phase: 'download',
        total: total || loaded,
        type: 'progress',
      });
    },
    useCache: true,
  });
  loadedModelId = modelId;
  return llm;
}

async function handle(event: MessageEvent, req: RuntimeRequest) {
  const source = event.source;
  try {
    if (req.type === 'probe') {
      reply(source, {
        id: req.id,
        isolated: crossOriginIsolated,
        threads: threads(),
        type: 'ok',
        webgpu: await hasWebgpu(),
      });
      return;
    }
    if (req.type === 'download') {
      const llm = await engine();
      await llm.cacheManager.download(req.url, {
        progressCallback: ({ loaded, total }) => {
          reply(source, {
            id: req.id,
            loaded,
            phase: 'download',
            total: total || loaded,
            type: 'progress',
          });
        },
      });
      reply(source, { id: req.id, type: 'ok' });
      return;
    }
    const llm = await ensureModel(
      source,
      req.id,
      req.modelId,
      req.url,
      req.gpuLayers ?? 0
    );
    reply(source, {
      id: req.id,
      loaded: 1,
      phase: 'load',
      total: 1,
      type: 'progress',
    });
    const completion = await llm.createChatCompletion({
      max_tokens: req.nPredict ?? 80,
      messages: [
        { content: GRADE_SYSTEM, role: 'system' },
        { content: req.prompt, role: 'user' },
      ],
      stream: false,
      temperature: 0.1,
    });
    const text = completion.choices[0]?.message.content ?? '';
    reply(source, { id: req.id, text, type: 'ok' });
  } catch (err) {
    reply(source, {
      id: req.id,
      message: err instanceof Error ? err.message : String(err),
      type: 'error',
    });
  }
}

window.addEventListener('message', (event) => {
  if (event.origin !== parentOrigin) return;
  if (!isRuntimeRequest(event.data)) return;
  void handle(event, event.data);
});
