import type { OfficeFormat } from '@/features/files/officeProtocol';

type WorkerResponse =
  | { bytes: ArrayBuffer; id: number; type: 'exported' }
  | { id: number; message: string; type: 'error' };

/** Base plus saved checkpoint, exported in a worker that is gone afterwards so
 * the editor engines are absent during ordinary reading. */
export function exportCheckpoint(
  format: OfficeFormat,
  base: ArrayBuffer,
  checkpoint: ArrayBuffer
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('./exportCheckpoint.worker.ts', import.meta.url),
      { type: 'module' }
    );
    const id = 1;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.id !== id) return;
      worker.terminate();
      if (event.data.type === 'error') reject(new Error(event.data.message));
      else resolve(new Uint8Array(event.data.bytes));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage({ base, checkpoint, format, id }, [base, checkpoint]);
  });
}
