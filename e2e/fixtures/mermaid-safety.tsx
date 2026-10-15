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
  // Links stay clickable; nothing loads until someone clicks.
  link: 'flowchart LR\n  A --> B\n  click A href "https://offsite.test/x"\n  click B href "javascript:void(0)"',
  linkStyleFunction: `flowchart LR\n  A --> B\n  linkStyle 0 stroke:#f00,mask-image:url(${REMOTE}/linkstyle.png)`,
  styleFunction: `flowchart LR\n  A --> B\n  style A mask-image:url(${REMOTE}/style.png)`,
  themeCssDirective: `%%{init: {"themeCSS": ".node rect{mask-image:url(${REMOTE}/theme.png)}"}}%%\nflowchart LR\n  A --> B`,
};

function Gallery() {
  const all = { ...ORDINARY, ...REFERENCING };
  const [drawn, setDrawn] = useState(0);
  const total = Object.keys(all).length;
  useEffect(() => {
    if (drawn >= total) document.body.dataset.mermaidDone = 'true';
  }, [drawn, total]);
  return (
    <div>
      {Object.entries(all).map(([name, code]) => (
        <div data-case={name} key={name}>
          <h3>{name}</h3>
          <Mermaid
            code={code}
            onDrawn={() => setDrawn((n) => n + 1)}
            onError={() => setDrawn((n) => n + 1)}
          />
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
