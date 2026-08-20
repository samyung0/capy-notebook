export type RuntimeRequest =
  | { id: string; type: 'probe' }
  | { id: string; type: 'download'; modelId: string; url: string }
  | {
      id: string;
      gpuLayers?: number;
      modelId: string;
      nPredict?: number;
      prompt: string;
      type: 'complete';
      url: string;
    };

export type RuntimeResponse =
  | {
      id: string;
      isolated?: boolean;
      text?: string;
      threads?: number;
      type: 'ok';
      webgpu?: boolean;
    }
  | {
      id: string;
      loaded: number;
      phase: 'download' | 'load';
      total: number;
      type: 'progress';
    }
  | { id: string; message: string; type: 'error' };

export function isRuntimeRequest(value: unknown): value is RuntimeRequest {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as { id?: unknown; type?: unknown };
  return (
    typeof rec.id === 'string' &&
    (rec.type === 'probe' || rec.type === 'download' || rec.type === 'complete')
  );
}

export function isRuntimeResponse(value: unknown): value is RuntimeResponse {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as { id?: unknown; type?: unknown };
  return (
    typeof rec.id === 'string' &&
    (rec.type === 'ok' || rec.type === 'progress' || rec.type === 'error')
  );
}
