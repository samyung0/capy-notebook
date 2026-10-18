import { lazy, Suspense, useState } from 'react';

const SearchDialog = lazy(() =>
  import('./SearchDialog').then((module) => ({
    default: module.SearchDialog,
  }))
);

/** The search dialog, loaded at its first open so the entry carries none of
 * its results' previews; mounted from then on, so it closes as before. */
export function LazySearchDialog({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  if (!opened) return null;
  return (
    <Suspense fallback={null}>
      <SearchDialog open={open} setOpen={setOpen} />
    </Suspense>
  );
}
