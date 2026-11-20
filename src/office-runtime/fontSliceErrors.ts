import { FontSliceUnavailableError } from '@betteroffice/docx/layout';
import type { OfficeNotice } from '@/features/files/officeProtocol';

/**
 * The DOCX editor's `onError` (Q752 B, Q755 B). A CJK font slice, or a face
 * that never opened (its index, skeleton or the fonts module), failing while
 * the document is edited (offline, say) leaves its characters in the document
 * and the editor running: a failed slice's glyphs are drawn blank, a face that
 * never opened keeps the missing-glyph box until it loads (Q763 A). One notice
 * until the browser is back online, when `online` asks for every failed slice
 * and face again; a server's failure goes to Sentry by its face. Every other
 * error stays fatal, a slice or face failing before the first pages are shown
 * included (it arrives as a plain Error).
 */
export function fontSliceErrors(host: {
  onError: (error: Error) => void;
  onFontError: (family: string, error: Error) => void;
  onNotice: (notice: OfficeNotice) => void;
}) {
  let noticed = false;
  return {
    online(retry: () => void) {
      noticed = false;
      retry();
    },
    report(error: Error) {
      if (!(error instanceof FontSliceUnavailableError)) {
        host.onError(error);
        return;
      }
      // `NotoSansJP-Regular/c093.zst`, or a face's index
      // `NotoSansKR-Regular/slices.json`: the face is the folder.
      if (error.reason === 'server')
        host.onFontError(error.file.split('/')[0] ?? error.file, error);
      if (noticed) return;
      noticed = true;
      host.onNotice('font-slice-unavailable');
    },
  };
}
