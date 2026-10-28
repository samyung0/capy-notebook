import { useEffect, useRef } from 'react';
import { mountPageEditor } from '@/features/blocksuite/pageEditor';

/** Spike page (todo-blocksuite-spike.md, piece 1): BlockSuite's page editor
 * on an in-memory note. Not linked from anywhere. */
export default function DevBlockSuite() {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    return mountPageEditor(container.current);
  }, []);
  return <div className="mx-auto max-w-3xl p-4" ref={container} />;
}
