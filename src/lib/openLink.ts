import { createContext, useContext, useRef, useState } from 'react';

/** A page whose full-screen views are named in its URL (`open`, Epo 2026-11-13):
 * opening one is a step in the browser's history, so Back closes it and the
 * page's link opens it again. */
export type OpenLink = {
  /** The view the URL names, if any. */
  opened: string | null;
  open: (key: string) => void;
  /** Back when the page opened it, else the name taken out of the URL. */
  close: () => void;
  /** The URL names something no longer there: says so and takes it out. */
  gone: () => void;
};

export const OpenLinkContext = createContext<OpenLink | null>(null);

/** The page's link for `opened`, written by `write` (a new history step, or the
 * current one replaced). `onGone` says what was named is no longer there. */
export function useOpenLink(
  opened: string | undefined,
  write: (open: string | undefined, replace: boolean) => void,
  onGone: () => void
): OpenLink {
  // The view this page put in the history itself: closing it goes Back, so the
  // step leaves with it. One the page opened at (a reload, a link) is replaced.
  const pushed = useRef<string | null>(null);
  return {
    close: () => {
      if (!opened) return;
      if (pushed.current === opened) {
        pushed.current = null;
        window.history.back();
      } else write(undefined, true);
    },
    gone: () => {
      onGone();
      pushed.current = null;
      write(undefined, true);
    },
    open: (key) => {
      if (opened === key) return;
      pushed.current = key;
      write(key, false);
    },
    opened: opened ?? null,
  };
}

/** The link under a prefix (a canvas card's id), for the views inside one part of
 * the page: none when the page keeps no link. */
export function scopedOpenLink(
  link: OpenLink | null,
  prefix: string
): OpenLink | null {
  if (!link) return null;
  const head = `${prefix}~`;
  return {
    close: () => {
      if (link.opened?.startsWith(head)) link.close();
    },
    gone: () => {
      if (link.opened?.startsWith(head)) link.gone();
    },
    open: (key) => link.open(head + key),
    opened: link.opened?.startsWith(head)
      ? link.opened.slice(head.length)
      : null,
  };
}

/** Whether a full-screen view is open: in the page's URL where it keeps one,
 * else on the page alone. */
export function useOpenView(key: string): [boolean, (open: boolean) => void] {
  const link = useContext(OpenLinkContext);
  const [local, setLocal] = useState(false);
  if (!link) return [local, setLocal];
  return [
    link.opened === key,
    (open) => (open ? link.open(key) : link.close()),
  ];
}
