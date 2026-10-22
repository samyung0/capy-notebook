/** One source per diagram type the Mermaid worker draws, keyed by the type
 * mermaid detects in it (MERMAID_TYPES in src/features/materials/
 * mermaidTypes.ts holds the same keys). The geometry check draws each in the
 * worker and on the page and compares the two (Epo 2026-10-23). */
export const MERMAID_SOURCES: Record<string, string> = {
  architecture:
    'architecture-beta\n  group api(cloud)[Study API]\n  service db(database)[Database] in api\n  service files(disk)[Files] in api\n  service server(server)[Server] in api\n  db:L -- R:server\n  files:T -- B:server',
  block:
    'block-beta\n  columns 3\n  read["Read notes"] quiz["Take a quiz"] review["Review mistakes"]\n  read --> quiz\n  quiz --> review',
  c4: 'C4Context\n  title Study platform\n  Person(student, "Student", "Reads notes and takes quizzes")\n  System(app, "Capy Notebook", "Notes, quizzes and flashcards")\n  System_Ext(mail, "Mail", "Sends reminders")\n  Rel(student, app, "Studies with")\n  Rel(app, mail, "Sends reminders through")',
  class:
    'classDiagram\n  class Cell {\n    +String nucleus\n    +divide() Cell\n  }\n  class Neuron {\n    +int axonLength\n    +fire()\n  }\n  Cell <|-- Neuron\n  Cell <|-- Muscle',
  classDiagram:
    'classDiagram-v2\n  class Lesson {\n    +String topic\n    +plan() Quiz\n  }\n  class Quiz {\n    +int questions\n  }\n  Lesson --> Quiz',
  cynefin:
    'cynefin-beta\n  title Choosing a study method\n  clear\n    "Flashcards for vocabulary"\n  complicated\n    "Past papers with a mark scheme"\n  complex\n    "Group projects"\n  chaotic\n    "The night before the exam"\n  confusion\n  complex --> complicated : "Practice"',
  er: 'erDiagram\n  STUDENT ||--o{ ENROLMENT : makes\n  COURSE ||--o{ ENROLMENT : has\n  STUDENT {\n    string name\n    int year\n  }',
  eventmodeling:
    'eventmodeling\n  tf 01 ui ReadNotes\n  tf 02 cmd TakeQuiz ->> 01\n  tf 03 evt QuizTaken ->> 02\n  tf 04 rmo Scores ->> 03',
  'flowchart-elk':
    'flowchart-elk TD\n  A[Read notes] --> B[Take a quiz]\n  B --> C[Review mistakes]',
  'flowchart-v2':
    'flowchart TD\n  A[Light reaches the leaf] --> B{Chlorophyll absorbs?}\n  B -->|yes| C[Water is split]\n  B -->|no| D[Light reflected]\n  C --> E[Oxygen released]\n  C --> F[ATP and NADPH made]\n  F --> G[Calvin cycle]\n  G --> H[Glucose]\n  H --> I[Stored as starch]\n  G --> J[CO2 fixed by RuBisCO]\n  J --> G',
  gantt:
    'gantt\n  title Revision plan\n  dateFormat YYYY-MM-DD\n  section Biology\n  Cells :a1, 2026-01-01, 7d\n  Genetics :after a1, 5d',
  gitGraph:
    'gitGraph\n  commit id: "Outline"\n  branch draft\n  checkout draft\n  commit id: "First draft"\n  commit id: "Edits"\n  checkout main\n  merge draft\n  commit id: "Final"',
  info: 'info',
  ishikawa:
    'ishikawa-beta\n  Low quiz scores\n    Methods\n      Rereading only\n      No practice tests\n    Time\n      Late nights\n    Environment\n      Phone nearby',
  journey:
    'journey\n  title Revision day\n  section Morning\n    Read notes: 4: Student\n    Practice quiz: 3: Student\n  section Evening\n    Review mistakes: 2: Student, Teacher',
  kanban:
    'kanban\n  todo[To do]\n    t1[Read chapter 3]\n    t2[Make flashcards]\n  doing[Doing]\n    t3[Practice quiz]\n  done[Done]\n    t4[Summarise notes]',
  mindmap:
    'mindmap\n  root((Cell biology))\n    Organelles\n      Nucleus\n      Mitochondria\n    Membrane\n      Lipid bilayer\n      Proteins',
  packet:
    'packet-beta\n  0-15: "Source port"\n  16-31: "Destination port"\n  32-63: "Sequence number"\n  64-95: "Acknowledgment number"',
  pie: 'pie title Blood composition\n  "Plasma" : 55\n  "Red cells" : 44\n  "White cells and platelets" : 1',
  quadrantChart:
    'quadrantChart\n  title Study methods\n  x-axis Low effort --> High effort\n  y-axis Low recall --> High recall\n  quadrant-1 Do more\n  quadrant-2 Plan\n  quadrant-3 Drop\n  quadrant-4 Share\n  Flashcards: [0.3, 0.8]\n  Rereading: [0.2, 0.3]\n  Past papers: [0.7, 0.85]',
  radar:
    'radar-beta\n  title Skills\n  axis r["Reading"], w["Writing"], m["Maths"], s["Science"]\n  curve t1["Term 1"]{3, 4, 2, 3}\n  curve t2["Term 2"]{4, 3, 4, 5}',
  railroad:
    'railroad-beta\n  title Number\n  number = sequence(optional(terminal("-")), oneOrMore(nonterminal("digit")), optional(sequence(terminal("."), oneOrMore(nonterminal("digit")))));',
  railroadAbnf:
    'railroad-abnf-beta\n  greeting = "hello" SP name ;\n  name = 1*ALPHA ;',
  railroadEbnf:
    'railroad-ebnf-beta\n  number = [ "-" ] , digit , { digit } ;\n  digit = "0" | "1" | "2" ;',
  railroadPeg:
    'railroad-peg-beta\n  number <- "-"? digit+ ("." digit+)? ;\n  digit <- "0" / "1" / "2" ;',
  requirement:
    'requirementDiagram\n  requirement recall {\n    id: 1\n    text: students recall key terms.\n    risk: medium\n    verifymethod: test\n  }\n  element quiz {\n    type: assessment\n  }\n  quiz - verifies -> recall',
  sankey:
    'sankey-beta\nReading,Notes,5\nReading,Quiz,3\nNotes,Quiz,4\nQuiz,Review,6',
  sequence:
    'sequenceDiagram\n  participant S as Student\n  participant T as Teacher\n  S->>T: Hands in the essay\n  T-->>S: Returns comments\n  loop Every draft\n    S->>S: Revises the argument\n  end\n  Note over S,T: Final grade after two drafts',
  stateDiagram:
    'stateDiagram-v2\n  [*] --> Solid\n  Solid --> Liquid: melting\n  Liquid --> Gas: boiling\n  Gas --> Liquid: condensation\n  Liquid --> Solid: freezing\n  Gas --> [*]',
  swimlane:
    'swimlane-beta LR\n  subgraph Student\n    A[Read notes] --> B[Take a quiz]\n  end\n  subgraph Teacher\n    C[Mark the quiz]\n  end\n  B --> C',
  timeline:
    'timeline\n  title Cell theory\n  1665 : Hooke names cells\n  1838 : Schleiden on plants\n  1839 : Schwann on animals\n  1855 : Virchow, cells from cells',
  treemap:
    'treemap-beta\n"Sciences"\n    "Biology": 30\n    "Chemistry": 20\n"Arts"\n    "History": 15\n    "Music": 10',
  treeView:
    'treeView-beta\n  notes\n    biology\n      cells.md\n      genetics.md\n    chemistry\n      bonds.md',
  venn: 'venn-beta\n  title Study habits\n  set A["Reading"]\n  set B["Practice"]\n  union A,B["Both"]',
  wardley:
    'wardley-beta\n  title Study tools\n  anchor Student [0.95, 0.63]\n  component Notes [0.79, 0.61]\n  component Quizzes [0.73, 0.78]\n  component Storage [0.20, 0.90]\n  Student->Notes\n  Student->Quizzes\n  Notes->Storage',
  xychart:
    'xychart-beta\n  title "Quiz scores"\n  x-axis [Jan, Feb, Mar, Apr]\n  y-axis "Score" 0 --> 100\n  bar [52, 70, 81, 88]\n  line [50, 65, 80, 90]',
};
