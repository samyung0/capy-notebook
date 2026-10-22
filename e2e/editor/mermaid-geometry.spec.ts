import { expect, test } from '@playwright/test';

// Mermaid draws in a Web Worker on a DOM shim (Epo 2026-10-22). For every
// type the worker draws (WORKER_TYPES in mermaid.worker.ts), its drawing must
// match the page's own mermaid.js, element by element: positions, sizes,
// path points, transforms and the viewBox. A mermaid upgrade or a shim change
// that moves anything fails here; a type that cannot pass draws on the page
// behind "Draw diagram" instead.

/** px. The timeline title's 4ex size is about 1 px off: canvas exposes no
 * x-height, so the shim measures the glyph. */
const TOLERANCE = 1.5;

const SOURCES = {
  class:
    'classDiagram\n  class Cell {\n    +String nucleus\n    +divide() Cell\n  }\n  class Neuron {\n    +int axonLength\n    +fire()\n  }\n  Cell <|-- Neuron\n  Cell <|-- Muscle',
  er: 'erDiagram\n  STUDENT ||--o{ ENROLMENT : makes\n  COURSE ||--o{ ENROLMENT : has\n  STUDENT {\n    string name\n    int year\n  }',
  flowchart:
    'flowchart TD\n  A[Light reaches the leaf] --> B{Chlorophyll absorbs?}\n  B -->|yes| C[Water is split]\n  B -->|no| D[Light reflected]\n  C --> E[Oxygen released]\n  C --> F[ATP and NADPH made]\n  F --> G[Calvin cycle]\n  G --> H[Glucose]\n  H --> I[Stored as starch]\n  G --> J[CO2 fixed by RuBisCO]\n  J --> G',
  gantt:
    'gantt\n  title Revision plan\n  dateFormat YYYY-MM-DD\n  section Biology\n  Cells :a1, 2026-01-01, 7d\n  Genetics :after a1, 5d',
  mindmap:
    'mindmap\n  root((Cell biology))\n    Organelles\n      Nucleus\n      Mitochondria\n    Membrane\n      Lipid bilayer\n      Proteins',
  pie: 'pie title Blood composition\n  "Plasma" : 55\n  "Red cells" : 44\n  "White cells and platelets" : 1',
  sequence:
    'sequenceDiagram\n  participant S as Student\n  participant T as Teacher\n  S->>T: Hands in the essay\n  T-->>S: Returns comments\n  loop Every draft\n    S->>S: Revises the argument\n  end\n  Note over S,T: Final grade after two drafts',
  state:
    'stateDiagram-v2\n  [*] --> Solid\n  Solid --> Liquid: melting\n  Liquid --> Gas: boiling\n  Gas --> Liquid: condensation\n  Liquid --> Solid: freezing\n  Gas --> [*]',
  timeline:
    'timeline\n  title Cell theory\n  1665 : Hooke names cells\n  1838 : Schleiden on plants\n  1839 : Schwann on animals\n  1855 : Virchow, cells from cells',
};
type Kind = keyof typeof SOURCES;

/** Every type in the default theme; Hand Drawn and Kawaii load their fonts
 * into the worker and style labels their own way. */
const CASES: [string, Kind[]][] = [
  ['linearLight', Object.keys(SOURCES) as Kind[]],
  ['handDrawn', ['flowchart', 'sequence', 'er', 'mindmap']],
  ['kawaii', ['class', 'mindmap', 'pie']],
];

interface Report {
  first: string;
  maxDiff: number;
  structure: string | null;
  worst: string;
}

for (const [theme, kinds] of CASES)
  test(`the worker draws each type as the page does (${theme})`, async ({
    page,
  }) => {
    await page.goto('/e2e/fixtures/mermaid-geometry.html');
    await expect
      .poll(() => page.evaluate(() => document.body.dataset.ready), {
        timeout: 60_000,
      })
      .toBe('true');
    for (const kind of kinds) {
      const report = await page.evaluate(
        ([code, name]) =>
          (
            window as unknown as {
              mermaidGeometry: (
                source: string,
                theme: string,
                width: number
              ) => Promise<Report>;
            }
          ).mermaidGeometry(code, name, 760),
        [SOURCES[kind], theme] as const
      );
      expect.soft(report.structure, `${kind}: same elements`).toBeNull();
      expect
        .soft(
          report.maxDiff,
          `${kind}: ${report.worst}; first: ${report.first}`
        )
        .toBeLessThanOrEqual(TOLERANCE);
    }
  });
