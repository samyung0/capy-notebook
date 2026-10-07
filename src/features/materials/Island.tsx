import { createContext, type ReactNode } from 'react';

/* Server-rendered shared notes are plain HTML; only the parts that need the
   browser (images' preview, embedded quizzes and sets, diagrams, interactive
   blocks) take React there. An island marks such a part: the share page
   hydrates `children` again from `name` and `props` (src/share/islands.tsx),
   so `children` must be exactly what that island renders from them. In the
   app the wrapper is inert. */

export type IslandName = 'embed' | 'html' | 'media' | 'mermaid';

export function Island({
  children,
  name,
  props,
}: {
  children: ReactNode;
  name: IslandName;
  props: object;
}) {
  return (
    <div
      className="contents"
      data-island={name}
      data-island-props={JSON.stringify(props)}
    >
      {children}
    </div>
  );
}

/** Set on the server: equations render to MathLive's static markup, so a
 * shared note loads no math script, only its fonts and stylesheet. */
export const StaticMathContext = createContext<
  ((tex: string, displayMode: boolean) => string) | null
>(null);
