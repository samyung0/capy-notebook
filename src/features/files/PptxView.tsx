import { ReactPptxViewer, setWasmSource } from '@extend-ai/react-pptx';
import wasmUrl from '@extend-ai/react-pptx/pptx_wasm_bg.wasm?url';
import '@extend-ai/react-pptx/styles.css';
import { Skeleton } from '@/components/ui/feedback';
import { m } from '@/i18n';

setWasmSource(wasmUrl);

/** PowerPoint (.ppt / .pptx) viewer. Parsing runs in Wasm in the browser. */
export default function PptxView({ url }: { url: string }) {
  return (
    <div className="h-full min-h-[60vh]">
      <ReactPptxViewer
        className="h-full min-h-[60vh]"
        renderError={() => (
          <p className="py-8 text-center text-tint-error-fg">
            {m.files_pptx_failed()}
          </p>
        )}
        renderLoading={() => <Skeleton className="h-[60vh] w-full" />}
        showThumbnails
        showToolbar
        source={url}
      />
    </div>
  );
}
