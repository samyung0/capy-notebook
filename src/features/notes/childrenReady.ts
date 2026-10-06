/** Ids the collaboration service's children pass kept as the open note's own
 * (some just restored from the trash): media nodes waiting on one resolve it
 * again. Quiz and flashcard blocks reload through their queries. */
export interface ReadyChildren {
  assetIds: string[];
  materialIds: string[];
}

const listeners = new Set<(ready: ReadyChildren) => void>();

export function onChildrenReady(listener: (ready: ReadyChildren) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function announceChildrenReady(ready: ReadyChildren) {
  for (const listener of listeners) listener(ready);
}
