import {
  isRuntimeResponse,
  type RuntimeRequest,
  type RuntimeResponse,
} from '@/llm-runtime/protocol';
import { browserQuizModel } from './browserModels';

export type BrowserLlmProgress = {
  loaded: number;
  phase: 'download' | 'load';
  total: number;
};

const TRAILING_SLASH = /\/$/;

function runtimeOrigin(): string {
  const configured = import.meta.env.VITE_LLM_RUNTIME_ORIGIN as
    | string
    | undefined;
  if (configured) return configured.replace(TRAILING_SLASH, '');
  return window.location.origin;
}

export function quizRuntimeOrigin(): string {
  return runtimeOrigin();
}

function runtimeUrl(): string {
  return `${runtimeOrigin()}/llm-runtime.html`;
}

type Pending = {
  reject: (error: Error) => void;
  resolve: (value: RuntimeResponse & { type: 'ok' }) => void;
  onProgress?: (progress: BrowserLlmProgress) => void;
};

class BrowserLlmHost {
  private frame: HTMLIFrameElement | null = null;
  private origin = '';
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  private readonly onMessage = (event: MessageEvent) => {
    if (event.origin !== this.origin) return;
    if (!isRuntimeResponse(event.data)) return;
    const pending = this.pending.get(event.data.id);
    if (!pending) return;
    if (event.data.type === 'progress') {
      pending.onProgress?.({
        loaded: event.data.loaded,
        phase: event.data.phase,
        total: event.data.total,
      });
      return;
    }
    this.pending.delete(event.data.id);
    if (event.data.type === 'error') {
      pending.reject(new Error(event.data.message));
      return;
    }
    pending.resolve(event.data);
  };

  private ensureFrame(): Promise<void> {
    if (this.ready) return this.ready;
    this.origin = runtimeOrigin();
    this.ready = new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      frame.src = runtimeUrl();
      frame.title = 'Quiz judge runtime';
      frame.allow = 'cross-origin-isolated';
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText =
        'position:absolute;width:0;height:0;border:0;visibility:hidden';
      frame.addEventListener('load', () => resolve(), { once: true });
      frame.addEventListener(
        'error',
        () => reject(new Error('Quiz judge runtime failed to load')),
        { once: true }
      );
      window.addEventListener('message', this.onMessage);
      document.body.appendChild(frame);
      this.frame = frame;
    });
    return this.ready;
  }

  private send(
    body:
      | { type: 'probe' }
      | { modelId: string; type: 'download'; url: string }
      | {
          gpuLayers?: number;
          modelId: string;
          nPredict?: number;
          prompt: string;
          type: 'complete';
          url: string;
        },
    onProgress?: (progress: BrowserLlmProgress) => void
  ): Promise<RuntimeResponse & { type: 'ok' }> {
    return this.ensureFrame().then(
      () =>
        new Promise((resolve, reject) => {
          const id = `llm_${++this.seq}`;
          const target = this.frame?.contentWindow;
          if (!target) {
            reject(new Error('Quiz judge runtime is not ready'));
            return;
          }
          this.pending.set(id, { onProgress, reject, resolve });
          const msg = { ...body, id } as RuntimeRequest;
          target.postMessage(msg, this.origin);
        })
    );
  }

  probe() {
    return this.send({ type: 'probe' });
  }

  async probeRuntime(): Promise<{ isolated: boolean; webgpu: boolean }> {
    const result = await this.probe();
    return {
      isolated: Boolean(result.isolated),
      webgpu: Boolean(result.webgpu),
    };
  }

  async download(
    modelId: string,
    onProgress?: (progress: BrowserLlmProgress) => void
  ) {
    const model = browserQuizModel(modelId);
    if (!model) throw new Error('Unknown browser quiz model');
    return this.send(
      { modelId: model.id, type: 'download', url: model.url },
      onProgress
    );
  }

  async complete(
    modelId: string,
    prompt: string,
    onProgress?: (progress: BrowserLlmProgress) => void
  ): Promise<string> {
    const model = browserQuizModel(modelId);
    if (!model) throw new Error('Unknown browser quiz model');
    const result = await this.send(
      {
        gpuLayers: model.gpuLayers,
        modelId: model.id,
        nPredict: 80,
        prompt,
        type: 'complete',
        url: model.url,
      },
      onProgress
    );
    return result.text ?? '';
  }
}

let host: BrowserLlmHost | null = null;

export function browserLlmHost(): BrowserLlmHost {
  if (!host) host = new BrowserLlmHost();
  return host;
}
