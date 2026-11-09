import { type ComponentProps, useEffect, useRef, useState } from 'react';
import { showErrorToast } from '@/api/queryClient';
import { dismissToast, userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { setConnectResume } from './connectResume';

type Dialog = typeof import('./AddSourceDialog')['AddSourceDialog'];

/** When an open with its code not here yet says it's loading. Before this a press
 * is still the click (a double click). */
const FEEDBACK_MS = 300;
/** When it stops waiting for a stalled import, which would otherwise never end.
 * Its 82 KB gzipped take about 13 s at 50 kbit/s. */
const LOAD_LIMIT_MS = 20_000;

let loaded: Dialog | undefined;
const load = () =>
  import('./AddSourceDialog').then((module) => {
    loaded = module.AddSourceDialog;
    return loaded;
  });

const preload = () => {
  // Offline it would fail, and the browser keeps a failed import until a reload.
  if (navigator.onLine === false) return;
  load().catch(() => undefined);
};

/** For what opens the dialog: hover or focus loads it ahead of the click. */
export const addSourceIntent = { onFocus: preload, onPointerEnter: preload };

/**
 * The dialog holds MSAL and the pickers, so it loads once someone wants it. No
 * Suspense: React holds a boundary's content back about 300 ms after a fallback,
 * and loaded ahead of the click it opens at once.
 *
 * Waiting, it says it's loading from `FEEDBACK_MS`. It opens nothing once the user
 * moved elsewhere: this page unmounted it, or a press or key came with the loading
 * toast up. If its code won't load (offline, a release removed it, or stalled past
 * `LOAD_LIMIT_MS`) the page stays and a toast says which. Either way nothing is
 * left to reopen after a provider's redirect.
 */
export function AddSourceDialog(props: ComponentProps<Dialog>) {
  const [Shown, setShown] = useState(() => loaded);
  const close = useRef(props.onClose);
  close.current = props.onClose;
  useEffect(() => {
    if (Shown) return;
    let toast: ReturnType<typeof userToast> | undefined;
    let done = false;
    const stop = () => {
      done = true;
      clearTimeout(feedback);
      clearTimeout(limit);
      document.removeEventListener('pointerdown', leave, true);
      document.removeEventListener('keydown', leave, true);
      if (toast !== undefined) dismissToast(toast);
    };
    const leave = () => {
      stop();
      setConnectResume(null);
      close.current();
    };
    const fail = (error: unknown) => {
      leave();
      showErrorToast(error);
    };
    const feedback = setTimeout(() => {
      toast = userToast({ title: m.common_loading(), variant: 'loading' });
      document.addEventListener('pointerdown', leave, true);
      document.addEventListener('keydown', leave, true);
    }, FEEDBACK_MS);
    // The connection copy: "An update is ready" would be a guess here.
    const limit = setTimeout(
      () => fail(new Error('Network error: Add file code stalled')),
      LOAD_LIMIT_MS
    );
    load().then(
      (dialog) => {
        if (done) return;
        stop();
        setShown(() => dialog);
      },
      (error: unknown) => {
        if (!done) fail(error);
      }
    );
    return stop;
  }, [Shown]);
  return Shown ? <Shown {...props} /> : null;
}
