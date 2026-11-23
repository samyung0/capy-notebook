import { useEffect, useState } from 'react';
import type { HeldStrip } from '@/features/collaboration/roomProvider';

/**
 * A note's held edits for its `unsynced` strip (`RoomProviderConfig.onHeld`,
 * Epo 2026-11-23): what the shown editor reports, cleared while the editor
 * swaps rooms, as the paused editor reports nothing more, not even that its
 * room let them go (round 4, finding 3: the strip stayed over the next
 * editor, with no way to close it).
 */
export function useHeldEdits(swapping: boolean) {
  const [held, setHeld] = useState<HeldStrip | null>(null);
  useEffect(() => {
    if (swapping) setHeld(null);
  }, [swapping]);
  return [held, setHeld] as const;
}
