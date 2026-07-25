import { type RefObject, useEffect } from 'react';

export function useOutsideClick<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onClose: () => void,
  active = true
) {
  useEffect(() => {
    if (!active) return;
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function key(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handle);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', handle);
      document.removeEventListener('keydown', key);
    };
  }, [ref, onClose, active]);
}
