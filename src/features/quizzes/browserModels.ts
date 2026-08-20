export const BROWSER_MODEL_PREFIX = 'browser:';

export type BrowserQuizModel = {
  bytes: number;
  description: string;
  displayName: string;
  gpuLayers: number;
  id: string;
  url: string;
};

/** In-tab Bonsai GGUFs. Q1_0 has WebGPU kernels and does not need isolation.
 * Q2_0 ternary is CPU-only; extra threads need Document-Isolation-Policy
 * (Chrome 137+). */
export const BROWSER_QUIZ_MODELS: BrowserQuizModel[] = [
  {
    bytes: 248_302_272,
    description:
      '1-bit 1.7B. Uses the GPU when the browser has WebGPU. Fastest in-tab option if this browser cannot isolate the marking page.',
    displayName: 'Bonsai 1.7B 1-bit (browser GPU)',
    gpuLayers: 999,
    id: 'browser:q1-1.7b',
    url: 'https://huggingface.co/prism-ml/Bonsai-1.7B-gguf/resolve/main/Bonsai-1.7B-Q1_0.gguf',
  },
  {
    bytes: 572_270_624,
    description:
      '1-bit 4B. Uses the GPU when available. Heavier than 1.7B 1-bit, still much faster than ternary without extra CPU threads.',
    displayName: 'Bonsai 4B 1-bit (browser GPU)',
    gpuLayers: 999,
    id: 'browser:q1-4b',
    url: 'https://huggingface.co/prism-ml/Bonsai-4B-gguf/resolve/main/Bonsai-4B-Q1_0.gguf',
  },
  {
    bytes: 489_000_000,
    description:
      'Ternary 1.7B. CPU only. In Chrome 137+ a short grade is tens of seconds. Other browsers stay on one thread and can take minutes.',
    displayName: 'Bonsai 1.7B ternary (browser CPU)',
    gpuLayers: 0,
    id: 'browser:ternary-1.7b',
    url: 'https://huggingface.co/prism-ml/Ternary-Bonsai-1.7B-gguf/resolve/main/Ternary-Bonsai-1.7B-Q2_0_g64.gguf',
  },
  {
    bytes: 1_150_000_000,
    description:
      'Ternary 4B. CPU only. Better marking than 1.7B when you have extra threads. Slow without isolation.',
    displayName: 'Bonsai 4B ternary (browser CPU)',
    gpuLayers: 0,
    id: 'browser:ternary-4b',
    url: 'https://huggingface.co/prism-ml/Ternary-Bonsai-4B-gguf/resolve/main/Ternary-Bonsai-4B-Q2_0_g64.gguf',
  },
];

export function isBrowserQuizModel(key: string | undefined): boolean {
  return !!key && key.startsWith(BROWSER_MODEL_PREFIX);
}

export function usesWebgpu(model: BrowserQuizModel): boolean {
  return model.gpuLayers > 0;
}

/** Why this in-tab model will crawl on the current browser, or null. */
export function browserModelWarn(
  model: BrowserQuizModel,
  caps: { isolated: boolean | null; webgpu: boolean | null }
): 'isolation' | 'webgpu' | null {
  if (usesWebgpu(model)) {
    return caps.webgpu === false ? 'webgpu' : null;
  }
  return caps.isolated === false ? 'isolation' : null;
}

export function browserQuizModel(
  key: string | undefined
): BrowserQuizModel | undefined {
  return BROWSER_QUIZ_MODELS.find((model) => model.id === key);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}
