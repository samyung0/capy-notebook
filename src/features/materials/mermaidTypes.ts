/**
 * The diagram types the Mermaid worker draws, by mermaid's detected id, each
 * with about the smallest source that draws it. Each type also has a source
 * in the geometry check (e2e/fixtures/mermaid-sources.ts), whose worker
 * drawing matches the page's own; any other type is unsupported and shows
 * an error (Epo 2026-10-23). The worker draws a type's small source once
 * before its first diagram, so the type's code and its layout's download
 * before the time limit starts, where a failed download is told apart from
 * a fault in the source by where it happens (review r3 L1, L5).
 */
export const MERMAID_TYPES: Readonly<Record<string, string>> = {
  architecture: 'architecture-beta\n  service a(server)[A]',
  block: 'block-beta\n  a',
  c4: 'C4Context\n  Person(a, "A")',
  class: 'classDiagram\n  class A',
  classDiagram: 'classDiagram-v2\n  class A',
  cynefin: 'cynefin-beta\n  clear\n    "A"',
  er: 'erDiagram\n  A ||--o{ B : r',
  eventmodeling: 'eventmodeling\n  tf 01 ui A',
  'flowchart-elk': 'flowchart-elk TD\n  A',
  'flowchart-v2': 'flowchart TD\n  A',
  gantt: 'gantt\n  dateFormat YYYY-MM-DD\n  A :a, 2026-01-01, 1d',
  gitGraph: 'gitGraph\n  commit',
  info: 'info',
  ishikawa: 'ishikawa-beta\n  A\n    B',
  journey: 'journey\n  section S\n    A: 1: B',
  kanban: 'kanban\n  a[A]',
  mindmap: 'mindmap\n  A',
  packet: 'packet-beta\n  0-7: "A"',
  pie: 'pie\n  "A" : 1',
  quadrantChart: 'quadrantChart\n  A: [0.5, 0.5]',
  radar: 'radar-beta\n  axis a, b, c\n  curve c{1, 2, 3}',
  railroad: 'railroad-beta\n  a = terminal("a");',
  railroadAbnf: 'railroad-abnf-beta\n  a = "a" ;',
  railroadEbnf: 'railroad-ebnf-beta\n  a = "a" ;',
  railroadPeg: 'railroad-peg-beta\n  a <- "a" ;',
  requirement: 'requirementDiagram\n  requirement a {\n    id: 1\n  }',
  sankey: 'sankey-beta\nA,B,1',
  sequence: 'sequenceDiagram\n  A->>B: m',
  stateDiagram: 'stateDiagram-v2\n  [*] --> A',
  swimlane: 'swimlane-beta LR\n  subgraph L\n    A\n  end',
  timeline: 'timeline\n  2026 : A',
  treemap: 'treemap-beta\n"A": 1',
  treeView: 'treeView-beta\n  a',
  venn: 'venn-beta\n  set A',
  wardley: 'wardley-beta\n  component A [0.5, 0.5]',
  xychart: 'xychart-beta\n  bar [1, 2]',
};
