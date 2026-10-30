import type { Citation, SourceFile } from '@/api/types';
import { EDITOR_NOTE } from './editorSeed';

/** One tool call of a fixture's turn and the files or materials it changed.
 * `undo` defaults to available; `none` is an edit no loaded room took, whose
 * receipt shows without Undo. `cut` is an Office edit the engine cut at a
 * per-call limit: its row stays in progress until the next edit of its file,
 * or the turn's end (Epo 2026-10-23, Q171). */
export interface FixtureEdit {
  changes: readonly {
    id: string;
    operation: 'created' | 'edited';
    undo?: 'none';
  }[];
  cut?: { applied: number; total: number };
  tool: string;
}

export interface ChatFixture {
  closeEarly?: boolean;
  content: string;
  /** Replaces the default turn's quiz and note edits. */
  edits?: readonly FixtureEdit[];
  errorCode?: 'invalid_answer' | 'response_flagged';
  hint: string;
  id: string;
  label: string;
  /** Cited sources: a place among the indexed files, or a file and quote. */
  passages?: readonly (
    | number
    | { fileId: string; snippet: string }
    | { materialId: string; name: string; snippet: string }
  )[];
  prompt: string;
  slow?: boolean;
}

const FENCE = '```';
const fenced = (info: string, ...lines: string[]) =>
  [`${FENCE}${info}`, ...lines, FENCE].join('\n');

const overview = [
  'A **cell** is the smallest unit of life. Its parts work together to keep it alive. [#1]',
  '',
  '- **Membrane**: Controls what enters and leaves the cell. [#1]',
  '- **Nucleus**: Stores the instructions used to make proteins. [#2]',
  '- **Mitochondria**: Transfer energy from food into ATP. [#2]',
  '',
  '> [!TIP] Remember the jobs',
  '> Boundary, instructions, energy. Connect each organelle to its job. [#1,2]',
].join('\n');

const edited =
  'I updated the membrane wording in your notes and diagrams so they match the textbook. [#1,2]';
const created =
  'Your study pack is ready: a quiz, a mindmap and a diagram, and the cheatsheet now links them. [#1,2]';
const officeEdited = 'I filled in the weekly plan of the course guide. [#1]';

export const chatFixtures = [
  {
    content: 'Your note closes on its third paragraph. [#1]',
    hint: 'A source that opens a note at the cited passage.',
    id: 'chat-answer-note-citation',
    label: 'Answer: note citation',
    passages: [
      {
        materialId: EDITOR_NOTE.id,
        name: EDITOR_NOTE.title,
        snippet: EDITOR_NOTE.thirdParagraph,
      },
    ],
    prompt: 'What does my note end on?',
  },
  {
    content: overview,
    hint: 'A list, prose, a callout and clickable source markers.',
    id: 'chat-answer-overview',
    label: 'Answer: overview + citations',
    passages: [1, 2],
    prompt: 'Give me a quick overview of the parts of a cell.',
  },
  {
    content: [
      '## Active recall',
      '',
      'Explain the idea **without looking**, then check your notes.',
      '',
      '- Name the concept.',
      '- Give one example.',
      '- Correct the missing detail.',
      '',
      '> Small, repeated checks beat rereading.',
      '',
      fenced(
        'python',
        'def recall(correct, total):',
        '    return correct / total * 100',
        '',
        'print(recall(8, 10))'
      ),
      '',
      'Accuracy is $a = c/n$.',
      '',
      '$$P(A \\mid B) = \\frac{P(B \\mid A)P(A)}{P(B)}$$',
      '',
      '**中文**：先回忆，再核对。',
      '',
      '**日本語**：思い出してから、ノートで確かめる。',
    ].join('\n'),
    hint: 'Headings, lists, quotes, code, inline/display math and CJK text.',
    id: 'chat-answer-prose',
    label: 'Answer: prose, code + math',
    prompt: 'Show an active-recall example with code and a formula.',
  },
  {
    content: [
      'A loan of $1,200 at 5% a year grows as $A = P(1 + r)^t$, so after 2 years it is worth',
      '',
      '$$A = 1200 \\times 1.05^2 = 1323$$',
      '',
      'A $5-$10 fee is not part of the formula.',
      '',
      '> [!NOTE] Quadratic formula',
      '> The roots of $ax^2 + bx + c = 0$ are $x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$.',
      '',
      '1. **Substitute**: With $a = 1$, $b = -3$, $c = 2$: $\\Delta = 9 - 8 = 1$.',
      '2. **Solve**: $x = \\frac{3 \\pm 1}{2} \\in \\{1, 2\\}$',
      '',
      '- **Mean**: $\\bar{x} = \\frac{1}{n}\\sum_{i=1}^{n} x_i$',
      '- **Variance**: $\\sigma^2 = \\frac{1}{n}\\sum (x_i - \\bar{x})^2$',
      '',
      '<details><summary>Check the second root</summary>',
      '$2^2 - 3 \\cdot 2 + 2 = 0$, and a $3 coffee is still $3.',
      '</details>',
    ].join('\n'),
    hint: 'Inline and display math in prose, a callout, lists and a reveal, beside dollar prices that stay text.',
    id: 'chat-answer-math',
    label: 'Answer: math',
    prompt: 'Explain compound interest and the quadratic formula.',
  },
  {
    content: [
      'Compare how substances cross the cell membrane. [#1]',
      '',
      ':::tabs',
      '::tab[Passive transport]',
      '1. **Concentration difference**: More particles start on one side of the membrane. [#1]',
      '2. **Net movement**: Particles move down their concentration gradient. [#1]',
      '::tab[Active transport]',
      '> [!NOTE] Energy required',
      '> A membrane protein uses energy to move particles against their gradient. [#2]',
      ':::',
      '',
      '<details><summary>An everyday example</summary>',
      'Oxygen diffuses into a respiring cell. [#1]',
      '</details>',
      '',
      '<details><summary>Does movement stop at equilibrium?</summary>',
      'Particles still move in both directions. There is no **net** movement. [#2]',
      '</details>',
      '',
      '<details><summary>Reveal a memory aid</summary>',
      'Passive follows the gradient; active can go against it.',
      '</details>',
    ].join('\n'),
    hint: 'Switch tabs and open the reveals.',
    id: 'chat-answer-layouts',
    label: 'Answer: tabs + reveals',
    passages: [1, 2],
    prompt: 'Compare passive and active transport step by step.',
  },
  {
    content: [
      '> [!NOTE] Definition',
      '> Diffusion is net movement down a concentration gradient.',
      '',
      '> [!TIP] Try this',
      '> Draw the particles before writing your explanation.',
      '',
      '> [!WARNING] Common mix-up',
      '> Osmosis describes the movement of water.',
      '',
      '> [!SUCCESS] Checkpoint',
      '> You can explain why net movement slows down.',
      '',
      '> [!DANGER] Incorrect claim',
      '> Equilibrium does not mean that particles stop moving.',
    ].join('\n'),
    hint: 'All five callout styles.',
    id: 'chat-answer-callouts',
    label: 'Answer: callouts',
    prompt: 'Make a revision card for membrane transport.',
  },
  {
    content: [
      'Compare the mechanisms and their energy requirements.',
      '',
      '| Mechanism | Direction | Energy | Example |',
      '|---|---|---|---|',
      '| Simple diffusion | Down the concentration gradient | No ATP | Oxygen moving through the phospholipid bilayer [#1] |',
      '| Facilitated diffusion | Down the concentration gradient | No ATP | Glucose moving through a specific carrier protein [#2] |',
      '| Active transport / 主动运输 | Against the concentration gradient | Energy required | Mineral ions entering plant root hair cells [#2] |',
      '',
      'The same kind of check with inline code:',
      '',
      '| Tool | Check performed | Result |',
      '|---|---|---|',
      '| `list_sources` | Listed the workspace files | ✅ |',
      '| `search_library` | Searched general biology | ✅ |',
    ].join('\n'),
    hint: 'Four columns, long cells, CJK text and row-level citations, then a table with inline code.',
    id: 'chat-answer-table',
    label: 'Answer: comparison table',
    passages: [1, 2],
    prompt: 'Compare membrane transport mechanisms in a table.',
  },
  ...(
    [
      ['bar', 'Bar chart'],
      ['hbar', 'Horizontal bar chart'],
      ['line', 'Line chart'],
      ['area', 'Area chart'],
      ['pie', 'Pie chart'],
      ['stacked', 'Stacked bar'],
    ] as const
  ).map(([kind, title]) => ({
    content: [
      'These example measurements are illustrative.',
      '',
      fenced(
        'chart',
        JSON.stringify({
          illustrative: true,
          kind,
          labels: ['Biology', 'Chemistry', 'Mathematics'],
          series: [
            { name: 'This week', values: [25, 35, 40] },
            ...(kind === 'pie' || kind === 'stacked'
              ? []
              : [{ name: 'Last week', values: [20, 45, 30] }]),
          ],
          title: `${title}: revision time (min)`,
          ...(kind === 'pie' || kind === 'stacked'
            ? {}
            : { xTitle: 'Subject', yTitle: 'Minutes' }),
        })
      ),
    ].join('\n'),
    hint: 'Illustrative data with labels and units. Resize the chat panel to check fit.',
    id: `chat-answer-${kind}` as const,
    label: `Answer: ${title.toLowerCase()}`,
    prompt: `Show revision time as a ${title.toLowerCase()}.`,
  })),
  {
    content: fenced(
      'plot',
      JSON.stringify({
        illustrative: true,
        kind: 'scatter',
        marks: [{ label: 'Session 4', x: 20, y: 65 }],
        series: [
          {
            name: 'Sessions',
            points: [
              [5, 40],
              [10, 55],
              [15, 70],
              [20, 65],
              [25, 85],
            ],
          },
        ],
        title: 'Practice and recall',
        xTitle: 'Practice minutes',
        yTitle: 'Recall score (%)',
      })
    ),
    hint: 'A scatter plot with a labelled point, axis titles with units and illustrative data.',
    id: 'chat-answer-scatter',
    label: 'Answer: scatter chart',
    prompt: 'Plot practice time against recall score.',
  },
  {
    content: [
      'Once the membrane reaches threshold, voltage-gated channels open in turn and the spike runs by itself. [#1]',
      '',
      fenced(
        'plot',
        JSON.stringify({
          illustrative: true,
          kind: 'line',
          lines: [{ axis: 'y', label: 'threshold −55 mV', value: -55 }],
          marks: [
            { label: 'Na⁺ floods in', x: 1.2, y: -20 },
            { label: 'K⁺ flows out', x: 2.2, y: -50 },
            { label: 'undershoot', x: 2.6, y: -80 },
          ],
          series: [
            {
              name: 'Membrane potential',
              points: [
                [0, -70],
                [0.5, -70],
                [0.8, -62],
                [1, -55],
                [1.2, -20],
                [1.5, 30],
                [1.8, 0],
                [2.2, -50],
                [2.6, -80],
                [3.2, -75],
                [4, -70],
                [5, -70],
              ],
            },
          ],
          title: 'An action potential',
          xTitle: 'Time (ms)',
          yTitle: 'Membrane potential (mV)',
        })
      ),
      '',
      'Notice the dashed line: below −55 mV nothing happens; once it is crossed, the whole spike follows.',
    ].join('\n'),
    hint: 'An illustrative voltage trace with a dashed threshold line, labelled points and the values table.',
    id: 'chat-answer-plot',
    label: 'Answer: plot',
    passages: [1],
    prompt: 'Plot an action potential and label what happens.',
  },
  {
    content: [
      'Enzymes speed up as they warm, until heat starts to unfold them. [#1]',
      '',
      fenced(
        'html-embed title="Enzyme activity and temperature" passages=1',
        '<style>.w{display:grid;gap:8px}.track{height:14px;border-radius:7px;background:color-mix(in srgb,var(--muted) 25%,transparent)}.bar{height:100%;border-radius:7px;background:var(--accent)}small{color:var(--muted)}</style>',
        '<div class="w"><label>Temperature: <b id="t"></b> °C</label><input id="r" type="range" min="0" max="70" value="37"><div class="track"><div id="b" class="bar"></div></div><small>Activity, relative to the best temperature</small></div>',
        "<script>const r=document.getElementById('r'),b=document.getElementById('b'),t=document.getElementById('t');function draw(){const x=+r.value;const a=x<=37?x/37:Math.max(0,1-(x-37)/15);t.textContent=x;b.style.width=a*100+'%';}r.oninput=draw;draw();</script>"
      ),
      '',
      'Drag past 40 °C: activity falls fast because the active site loses its shape.',
    ].join('\n'),
    hint: 'A sandboxed html-embed frame with a slider, its caption and a cited source.',
    id: 'chat-answer-interactive',
    label: 'Answer: interactive',
    passages: [1],
    prompt: 'Let me play with how temperature changes enzyme activity.',
  },
  {
    content: [
      'I need a few details before building your revision plan.',
      '',
      fenced(
        'ask',
        '{"question": "Which subject is the plan for?", "choices": ["Biology", "Chemistry", "Mathematics"]}',
        '{"question": "How much time do you have?", "choices": ["15 minutes", "30 minutes", "One hour"]}',
        '{"question": "What should the plan prepare you for?", "choices": []}'
      ),
    ].join('\n'),
    hint: 'Three docked questions. Try choices, free text, skip, collapse and Send. Older turns show the questions inline.',
    id: 'chat-answer-questions',
    label: 'Answer: questions to the user',
    prompt: 'Create a revision plan for me.',
  },
  {
    content: `This paragraph arrived, but the chart after it never closed.\n\n${FENCE}chart\n{"kind": "bar", "title": "Lost"`,
    hint: 'A finished answer whose last figure never closed keeps the readable text and shows the incomplete-answer notice.',
    id: 'chat-answer-partial',
    label: 'Answer failure: unfinished figure',
    prompt: 'Preview an answer with a missing section.',
  },
  {
    content: [
      'The valid chart draws. The mismatched one shows as code.',
      '',
      fenced(
        'chart',
        '{"illustrative": true, "kind": "bar", "labels": ["A", "B"], "series": [{"name": "Score", "values": [10, 20]}], "title": "Valid measurements (points)"}'
      ),
      '',
      fenced(
        'chart',
        '{"illustrative": true, "kind": "bar", "labels": ["A", "B", "C"], "series": [{"name": "Score", "values": [10]}], "title": "Mismatched measurements (points)"}'
      ),
    ].join('\n'),
    hint: 'One valid chart and one mismatched series, which shows as code.',
    id: 'chat-answer-invalid-chart',
    label: 'Answer failure: invalid chart',
    prompt: 'Preview a malformed chart beside a valid one.',
  },
  {
    content: `${FENCE}chart\n{"kind": "bar"`,
    hint: 'No readable content arrived. Shows the inline error.',
    id: 'chat-answer-unusable',
    label: 'Answer failure: nothing readable',
    prompt: 'Preview an answer with nothing to read.',
  },
  {
    content: '',
    errorCode: 'invalid_answer',
    hint: 'The service rejects an empty answer with invalid_answer. The error survives reopening history.',
    id: 'chat-answer-empty',
    label: 'Answer failure: empty response',
    prompt: 'Preview an empty model response.',
  },
  {
    content:
      'This partial answer will be cleared when the safety guard flags the response. [#1]',
    errorCode: 'response_flagged',
    hint: 'Streams a partial answer and citation, then flags it. Both disappear; completed tool activity and the safety notice remain in history.',
    id: 'chat-answer-flagged',
    label: 'Answer failure: safety flagged',
    passages: [1],
    prompt: 'Preview the tool-protocol safety guard.',
  },
  {
    closeEarly: true,
    content:
      'This part arrived before the connection closed. The rest of the answer never arrived.',
    hint: 'The stream closes before block_end/done. Partial content remains with a connection error.',
    id: 'chat-answer-interrupted',
    label: 'Answer failure: interrupted stream',
    prompt: 'Preview a disconnected answer stream.',
  },
  {
    content:
      'The engineering society had not run an exchange trip for three years. [#1]',
    hint: 'In Biology 101, cites a passage of exchange-plan.docx; opening the source highlights it in the Office viewer.',
    id: 'chat-answer-office',
    label: 'Answer: Office citation',
    passages: [
      {
        fileId: 'bio-office-docx',
        snippet: '工程學會亦因此已經三年沒有舉辦交流學習團',
      },
    ],
    prompt: 'Why is the exchange trip new this year?',
  },
  {
    content: edited,
    edits: [
      {
        changes: [
          { id: 'f_2', operation: 'edited' },
          { id: 'f_3', operation: 'edited' },
        ],
        tool: 'edit_document',
      },
      {
        changes: [{ id: 'mat_1', operation: 'edited' }],
        tool: 'edit_material',
      },
      {
        changes: [{ id: 'mat_2', operation: 'edited' }],
        tool: 'edit_material',
      },
    ],
    hint: 'Biology 101: one step edits two notes, then a mindmap and a diagram are edited, each with Undo.',
    id: 'chat-files-edited',
    label: 'Files: several edited',
    passages: [1, 2],
    prompt: 'Fix the membrane wording everywhere.',
  },
  {
    content: created,
    edits: [
      {
        changes: [{ id: 'qz_1', operation: 'created' }],
        tool: 'create_material',
      },
      {
        changes: [{ id: 'qz_1', operation: 'edited', undo: 'none' }],
        tool: 'add_questions',
      },
      {
        changes: [{ id: 'mat_1', operation: 'created' }],
        tool: 'create_material',
      },
      {
        changes: [{ id: 'mat_2', operation: 'created' }],
        tool: 'create_material',
      },
      { changes: [{ id: 'f_2', operation: 'edited' }], tool: 'edit_document' },
    ],
    hint: 'Biology 101: a quiz, a mindmap and a diagram created, then a note edited.',
    id: 'chat-files-created',
    label: 'Files: several created + edited',
    passages: [1, 2],
    prompt: 'Make me a study pack for cells.',
  },
  {
    content: edited,
    edits: [
      {
        changes: [{ id: 'qz_2', operation: 'created' }],
        tool: 'create_material',
      },
      {
        changes: [
          { id: 'f_2', operation: 'edited' },
          { id: 'f_3', operation: 'edited', undo: 'none' },
        ],
        tool: 'edit_document',
      },
      {
        changes: [{ id: 'mat_2', operation: 'edited', undo: 'none' }],
        tool: 'edit_material',
      },
      {
        changes: [{ id: 'mat_1', operation: 'edited', undo: 'none' }],
        tool: 'edit_material',
      },
    ],
    hint: 'Biology 101: a quiz created, notes and a mindmap edited, some without Undo: edits no open room took show their receipt alone.',
    id: 'chat-files-no-undo',
    label: 'Files: edits without Undo',
    passages: [1, 2],
    prompt: 'Rewrite my osmosis notes and the mindmap.',
  },
  {
    content: officeEdited,
    edits: [
      {
        changes: [{ id: 'bio-office-xlsx', operation: 'edited' }],
        cut: { applied: 30, total: 32 },
        tool: 'edit_office_document',
      },
      {
        changes: [{ id: 'bio-office-xlsx', operation: 'edited' }],
        tool: 'edit_office_document',
      },
    ],
    hint: 'Biology 101: an Office edit cut at a per-call limit stays in progress (30 of 32) until the next edit of the file, then both close as edits.',
    id: 'chat-office-cut',
    label: 'Files: Office edit cut at a limit',
    passages: [1],
    prompt: 'Fill in the course guide.',
  },
  {
    content: officeEdited,
    edits: [
      {
        changes: [{ id: 'bio-office-xlsx', operation: 'edited' }],
        cut: { applied: 30, total: 32 },
        tool: 'edit_office_document',
      },
    ],
    hint: 'Biology 101: an Office edit cut at a per-call limit that the turn never follows up ends with a warning icon whose tooltip says 2 commands not applied.',
    id: 'chat-office-unapplied',
    label: 'Files: Office commands not applied',
    passages: [1],
    prompt: 'Fill in the whole course guide.',
  },
  {
    content: overview,
    hint: 'Slow chunks make progressive rendering and Stop easy to inspect. Reopen the conversation to see the saved partial answer.',
    id: 'chat-answer-slow',
    label: 'Answer: slow stream / Stop',
    passages: [1, 2],
    prompt: 'Explain cell structure slowly.',
    slow: true,
  },
] as const satisfies readonly ChatFixture[];

export const chatFixtureOptions = chatFixtures.map(({ hint, id, label }) => ({
  hint: `Open a workspace's Chat tab and send any message. ${hint}`,
  id,
  label,
}));

// The scenario PDF (e2e/fixtures/files/basic/three-pages.pdf) is cited on
// "Osmosis moves water across the membrane.", mid-page 2, so opening it
// scrolls. The box is PDF.js's text position, padded a little.
const scenarioPdfRegion = { bbox: [80, 505, 490, 538], page: 2 };

export function fixtureCitations(
  fixture: ChatFixture,
  sources: Pick<SourceFile, 'id' | 'name' | 'indexed'>[]
): Citation[] {
  const indexed = sources.filter((source) => source.indexed);
  return (fixture.passages ?? []).flatMap((passage, index): Citation[] => {
    if (typeof passage === 'object' && 'materialId' in passage)
      return [
        {
          fileId: '',
          fileName: passage.name,
          kind: 'material',
          materialId: passage.materialId,
          n: index + 1,
          snippet: passage.snippet,
        },
      ];
    const quoted = typeof passage === 'object';
    const source = quoted
      ? sources.find(({ id }) => id === passage.fileId)
      : indexed[passage - 1];
    // PDFs get a page-1 box so the viewer's citation overlay shows; each
    // passage sits lower on the page than the one before.
    const top = 120 + index * 220;
    const { bbox, page } =
      source?.id === 'mock-scenario-pdf'
        ? scenarioPdfRegion
        : { bbox: [90, top, 910, top + 160], page: 1 };
    const region = source?.name.endsWith('.pdf')
      ? {
          pageEnd: page,
          pageStart: page,
          regions: [{ bbox, page, space: 'page-1000-topleft' }],
        }
      : {};
    return source
      ? [
          {
            ...region,
            fileId: source.id,
            fileName: source.name,
            n: quoted ? index + 1 : passage,
            snippet: quoted
              ? passage.snippet
              : 'Example source passage for the chat preview.',
          },
        ]
      : [];
  });
}

export function fixtureResult(
  fixture: ChatFixture,
  content = fixture.content,
  aborted = false
) {
  const errorCode = aborted
    ? undefined
    : (fixture.errorCode ?? (fixture.closeEarly ? 'agent_failed' : undefined));
  return {
    content: errorCode === 'response_flagged' ? '' : content,
    errorCode,
    status: aborted ? 'aborted' : errorCode ? 'error' : 'complete',
  };
}

export const mockChatModel = {
  modelDisplayName: 'DeepSeek Flash',
  modelSlug: 'deepseek-flash',
  modelVersion: 1,
  providerSlug: 'deepseek',
};
