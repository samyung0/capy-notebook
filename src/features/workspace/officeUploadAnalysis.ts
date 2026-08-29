import type { OfficeAnalysis } from '@/features/files/officeProtocol';
import { fileExt } from './sourceUpload';

/** Parse modern Office files with the same read-only engines used by the
 * viewer. Editor code and editor WASM are never imported during upload. */
export async function analyzeOfficeUpload(
  file: File
): Promise<OfficeAnalysis | null> {
  const ext = fileExt(file.name);
  if (ext === 'xlsx') {
    const { analyzeWorkbook, initWasm } = await import(
      '@betteroffice/xlsx/viewer'
    );
    await initWasm();
    return analyzeWorkbook(new Uint8Array(await file.arrayBuffer()));
  }
  if (ext === 'pptx') {
    const { analyzePresentation, initWasm } = await import(
      '@betteroffice/pptx/viewer'
    );
    await initWasm();
    return analyzePresentation(new Uint8Array(await file.arrayBuffer()));
  }
  return null;
}
