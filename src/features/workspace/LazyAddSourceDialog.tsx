import { type ComponentProps, useEffect, useRef, useState } from 'react';
import { showErrorToast } from '@/api/queryClient';

type Dialog = typeof import('./AddSourceDialog')['AddSourceDialog'];

let loaded: Dialog | undefined;
const load = () =>
  import('./AddSourceDialog').then((module) => {
    loaded = module.AddSourceDialog;
    return loaded;
  });

const preload = () => {
  load().catch(() => undefined);
};

/** For what opens the dialog: hover or focus loads it ahead of the click. */
export const addSourceIntent = { onFocus: preload, onPointerEnter: preload };

/**
 * The dialog holds MSAL and the pickers, so it loads once someone wants it. No
 * Suspense: React holds a boundary's content back about 300 ms after a fallback,
 * and loaded ahead of the click it opens at once. If its code won't load
 * (offline, or a release removed it) the page stays, a toast says which, with
 * Reload for a release, and nothing opens.
 */
export function AddSourceDialog(props: ComponentProps<Dialog>) {
  const [Shown, setShown] = useState(() => loaded);
  const close = useRef(props.onClose);
  close.current = props.onClose;
  useEffect(() => {
    if (Shown) return;
    let gone = false;
    load().then(
      (dialog) => {
        if (!gone) setShown(() => dialog);
      },
      (error: unknown) => {
        if (gone) return;
        showErrorToast(error);
        close.current();
      }
    );
    return () => {
      gone = true;
    };
  }, [Shown]);
  return Shown ? <Shown {...props} /> : null;
}
