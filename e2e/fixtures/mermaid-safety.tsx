import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Mermaid } from '@/features/materials/Mermaid';
import '@/styles/tailwind.css';

/*
 * Renders diagrams that reference an outside resource, so a headless test can
 * confirm none of them loads anything from off-origin. The resources live on
 * REMOTE, which the test intercepts. A diagram that needed a dropped part
 * still draws, minus that part, so the ordinary diagrams below render their
 * text unchanged. Ordinary (safe) diagrams are listed first so the gallery
 * doubles as a render-parity check.
 */

const REMOTE = 'https://mermaid-remote.test';

/** `?worker=hostile`: the worker answers this SVG for every diagram, to show
 * the page sanitizes what the worker draws before inserting it: a label's
 * stylesheet (review H1) and a sign-in form (review L6) included. */
const HOSTILE_SVG = `<svg id="mmd-hostile" onload="window.pwned=1" viewBox="0 0 100 40"><script>window.pwned=1</script><image href="${REMOTE}/hostile-image.png"/><foreignObject width="100" height="40"><div xmlns="http://www.w3.org/1999/xhtml"><style>@import '${REMOTE}/hostile-label.css'; body{outline:9px solid red}</style><img src="${REMOTE}/hostile-label.png" onerror="window.pwned=1"/><span onmouseover="window.pwned=1">hostile</span><form action="https://offsite.test/sign-in"><input name="password"/><textarea name="note"></textarea><select name="who"><option>me</option></select><button>Sign in again</button></form></div></foreignObject><a href="javascript:window.pwned=1"><text>script link</text></a><a href="https://offsite.test/hostile"><text>outside link</text></a></svg>`;
const HOSTILE =
  new URLSearchParams(location.search).get('worker') === 'hostile';
if (HOSTILE)
  window.Worker = class {
    onerror = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    /** Stands in for a module worker, reading `type` as a browser with them
     * does (the page checks it). */
    constructor(_url: string, options?: WorkerOptions) {
      if (options?.type !== 'module') throw new TypeError('module only');
    }
    postMessage({ id }: { id: number }) {
      queueMicrotask(() =>
        this.onmessage?.({ data: { background: '#fff', id, svg: HOSTILE_SVG } })
      );
    }
    terminate() {
      // Nothing runs.
    }
  } as unknown as typeof Worker;

/** Diagrams that draw the same with or without the safety pass. */
const ORDINARY: Record<string, string> = {
  class: 'classDiagram\n  class Animal\n  Animal : +name\n  Animal <|-- Dog',
  er: 'erDiagram\n  CUSTOMER ||--o{ ORDER : places',
  flowchart: 'flowchart LR\n  A[Start] --> B{Choice}\n  B -->|yes| C[Done]',
  gantt:
    'gantt\n  dateFormat YYYY-MM-DD\n  section Work\n  Task :a, 2020-01-01, 30d',
  mindmap: 'mindmap\n  root((Topic))\n    Branch A\n    Branch B',
  sequence: 'sequenceDiagram\n  Alice->>Bob: Question\n  Bob-->>Alice: Answer',
  state: 'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy\n  Busy --> Idle',
  styled:
    'flowchart LR\n  A:::hot --> B\n  classDef hot fill:#f96,color:#fff\n  style B stroke:#333,stroke-width:4px\n  linkStyle 0 stroke:#ff3',
};

/** Each references an outside resource one way; the pass must stop every
 * one from loading while the diagram still draws. */
const REFERENCING: Record<string, string> = {
  actorIcon: `sequenceDiagram\n  participant A\n  properties A: {"icon": "${REMOTE}/icon.png"}\n  A->>A: hi`,
  classDefFunction: `flowchart LR\n  A:::c --> B\n  classDef c mask-image:url(${REMOTE}/classdef.png)`,
  fontFamilyDirective: `%%{init: {"fontFamily": "x; mask-image:url(${REMOTE}/font.png)"}}%%\nflowchart LR\n  A --> B`,
  imageNode: `flowchart LR\n  A@{ img: "${REMOTE}/node.png", label: "Cat" } --> B`,
  labelImage: `flowchart LR\n  A["<img src='${REMOTE}/label.png'> node"] --> B`,
  // A label's stylesheet would style the whole page and import from outside
  // (review H1).
  labelStyleImport: `flowchart LR\n  A["<style>@import '${REMOTE}/label-import.css'; body{outline:9px solid red}</style>hi"] --> B`,
  // Links stay clickable; nothing loads until someone clicks.
  link: 'flowchart LR\n  A --> B\n  click A href "https://offsite.test/x"\n  click B href "javascript:void(0)"',
  linkStyleFunction: `flowchart LR\n  A --> B\n  linkStyle 0 stroke:#f00,mask-image:url(${REMOTE}/linkstyle.png)`,
  styleFunction: `flowchart LR\n  A --> B\n  style A mask-image:url(${REMOTE}/style.png)`,
  themeCssDirective: `%%{init: {"themeCSS": ".node rect{mask-image:url(${REMOTE}/theme.png)}"}}%%\nflowchart LR\n  A --> B`,
};

function Gallery() {
  const all = HOSTILE
    ? { hostile: 'flowchart LR\n  A --> B' }
    : { ...ORDINARY, ...REFERENCING };
  // The cases that drew or failed (each draws once it comes near the screen).
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set());
  const total = Object.keys(all).length;
  useEffect(() => {
    if (settled.size >= total) document.body.dataset.mermaidDone = 'true';
  }, [settled, total]);
  const settle = (name: string) => () =>
    setSettled((names) => new Set(names).add(name));
  return (
    <div>
      {Object.entries(all).map(([name, code]) => (
        <div data-case={name} key={name}>
          <h3>{name}</h3>
          <Mermaid code={code} onDrawn={settle(name)} onError={settle(name)} />
        </div>
      ))}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>
);
