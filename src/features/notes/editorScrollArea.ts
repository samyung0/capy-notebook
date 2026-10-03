import { createContext, useContext } from 'react';

/**
 * The note's scrolling viewport. Block toolbars portal to the body, so they
 * use it as their boundary to hide once their block scrolls out of view
 * instead of floating over the app chrome.
 */
export const EditorScrollAreaContext = createContext<HTMLElement | null>(null);

export function useEditorScrollArea() {
  return useContext(EditorScrollAreaContext);
}
