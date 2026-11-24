import { type DragEvent, useEffect, useRef, useState } from 'react';
import { m } from '@/i18n';

/** A drag that carries files, not text or a link. */
export function hasDraggedFiles(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types).includes('Files');
}

/**
 * Drop handlers for a box that takes files, `over` while they are dragged onto
 * it. Without `onFiles` it refuses them, so a stray drop never opens the file
 * in the tab; a box inside one that takes them handles its own drops first.
 */
export function useFileDrop(onFiles: ((files: File[]) => void) | undefined) {
  const [over, setOver] = useState(false);
  return {
    dropHandlers: {
      onDragLeave: (event: DragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          setOver(false);
      },
      onDragOver: (event: DragEvent) => {
        if (event.defaultPrevented || !hasDraggedFiles(event.dataTransfer))
          return;
        event.preventDefault();
        event.dataTransfer.dropEffect = onFiles ? 'copy' : 'none';
        setOver(!!onFiles);
      },
      onDrop: (event: DragEvent) => {
        if (event.defaultPrevented || !hasDraggedFiles(event.dataTransfer))
          return;
        event.preventDefault();
        setOver(false);
        const files = Array.from(event.dataTransfer.files);
        if (files.length > 0) onFiles?.(files);
      },
    },
    over,
  };
}

// What browsers name a copied image or a screenshot.
const COPIED_IMAGE = /^image\.(\w+)$/;

/** What a paste brings to upload: its files, a copied image or screenshot
 * named as pasted, or else its text as a text file. */
export function pastedFiles(data: {
  files: ArrayLike<File>;
  getData: (format: string) => string;
}): File[] {
  const files = Array.from(data.files, (file) => {
    const ext = COPIED_IMAGE.exec(file.name)?.[1];
    return ext
      ? new File([file], `${m.file_pasted_image()}.${ext}`, { type: file.type })
      : file;
  });
  if (files.length > 0) return files;
  const text = data.getData('text/plain');
  return text.trim()
    ? [new File([text], `${m.file_pasted_text()}.txt`, { type: 'text/plain' })]
    : [];
}

/** Files and text pasted anywhere on the page but a field, while `onFiles`
 * is set. */
export function usePastedFiles(onFiles: ((files: File[]) => void) | undefined) {
  const latest = useRef(onFiles);
  latest.current = onFiles;
  const on = !!onFiles;
  useEffect(() => {
    if (!on) return;
    const paste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        event.defaultPrevented ||
        !event.clipboardData ||
        target.closest?.('input, textarea, select') ||
        target.isContentEditable
      )
        return;
      const files = pastedFiles(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      latest.current?.(files);
    };
    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
  }, [on]);
}
