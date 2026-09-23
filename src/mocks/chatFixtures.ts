import type { Citation, SourceFile } from '@/api/types';

export interface ChatFixture {
  closeEarly?: boolean;
  content: string;
  errorCode?: 'invalid_answer' | 'response_flagged';
  hint: string;
  id: string;
  label: string;
  passages?: readonly number[];
  prompt: string;
  slow?: boolean;
}

const overview = [
  'root = Answer([intro, concepts, summary])',
  'intro = Md("A **cell** is the smallest unit of life. Its parts work together to keep it alive.", [1])',
  'concepts = Cards([membrane, nucleus, energy])',
  'membrane = Card("Membrane", "Controls what enters and leaves the cell.", [1])',
  'nucleus = Card("Nucleus", "Stores the instructions used to make proteins.", [2])',
  'energy = Card("Mitochondria", "Transfer energy from food into ATP.", [2])',
  'summary = Callout("tip", "Remember the jobs", "Boundary, instructions, energy. Connect each organelle to its job.", [1, 2])',
].join('\n');

export const chatFixtures = [
  {
    content: overview,
    hint: 'Concept cards, prose, a callout and clickable source markers.',
    id: 'chat-openui-overview',
    label: 'OpenUI: overview + citations',
    passages: [1, 2],
    prompt: 'Give me a quick overview of the parts of a cell.',
  },
  {
    content: [
      'root = Answer([prose, code, math, languages])',
      `prose = Md(${JSON.stringify('## Active recall\n\nExplain the idea **without looking**, then check your notes.\n\n- Name the concept.\n- Give one example.\n- Correct the missing detail.\n\n> Small, repeated checks beat rereading.')})`,
      `code = Md(${JSON.stringify('```python\ndef recall(correct, total):\n    return correct / total * 100\n\nprint(recall(8, 10))\n```')})`,
      `math = Md(${JSON.stringify('Accuracy is $a = c/n$.\n\n$$P(A \\mid B) = \\frac{P(B \\mid A)P(A)}{P(B)}$$')})`,
      'languages = Md("**中文**：先回忆，再核对。\\n\\n**日本語**：思い出してから、ノートで確かめる。")',
    ].join('\n'),
    hint: 'Headings, lists, quotes, code, inline/display math and CJK text.',
    id: 'chat-openui-prose',
    label: 'OpenUI: prose, code + math',
    prompt: 'Show an active-recall example with code and a formula.',
  },
  {
    content: [
      'root = Answer([intro, tabs, details, hint])',
      'intro = Md("Compare how substances cross the cell membrane.", [1])',
      'tabs = Tabs([passive, active])',
      'passive = Tab("Passive transport", [p])',
      'p = Steps([p1, p2])',
      'p1 = Step("Concentration difference", "More particles start on one side of the membrane.", [1])',
      'p2 = Step("Net movement", "Particles move down their concentration gradient.", [1])',
      'active = Tab("Active transport", [a])',
      'a = Callout("info", "Energy required", "A membrane protein uses energy to move particles against their gradient.", [2])',
      'details = Accordion([example, misconception])',
      'example = AccordionItem("An everyday example", [e])',
      'e = Md("Oxygen diffuses into a respiring cell.", [1])',
      'misconception = AccordionItem("Does movement stop at equilibrium?", [m])',
      'm = Md("Particles still move in both directions. There is no **net** movement.", [2])',
      'hint = Reveal("Reveal a memory aid", "Passive follows the gradient; active can go against it.")',
    ].join('\n'),
    hint: 'Switch tabs, expand accordions and reveal the memory aid.',
    id: 'chat-openui-layouts',
    label: 'OpenUI: tabs, steps + reveals',
    passages: [1, 2],
    prompt: 'Compare passive and active transport step by step.',
  },
  {
    content: [
      'root = Answer([tags, facts, cards, info, tip, warning, success, danger])',
      'tags = Tags(["Cell biology", "Revision", "细胞膜", "A longer keyword that wraps"])',
      'facts = Facts([Fact("Topic", "Cell membranes"), Fact("Time", "20 minutes"), Fact("Goal", "Explain transport without notes")])',
      'cards = Cards([Card("Recall", "Correct answers in this illustrative practice set.", null, "8 / 10"), Card("Next step", "Revisit concentration gradients."), Card("Confidence", "Check with a new example, not familiarity.")])',
      'info = Callout("info", "Definition", "Diffusion is net movement down a concentration gradient.")',
      'tip = Callout("tip", "Try this", "Draw the particles before writing your explanation.")',
      'warning = Callout("warning", "Common mix-up", "Osmosis describes the movement of water.")',
      'success = Callout("success", "Checkpoint", "You can explain why net movement slows down.")',
      'danger = Callout("danger", "Incorrect claim", "Equilibrium does not mean that particles stop moving.")',
    ].join('\n'),
    hint: 'Metric/concept cards, facts, wrapping tags and all five callout styles.',
    id: 'chat-openui-cards',
    label: 'OpenUI: cards, facts + callouts',
    prompt: 'Make a revision card for membrane transport.',
  },
  {
    content: [
      'root = Answer([intro, table])',
      'intro = Md("Compare the mechanisms and their energy requirements.")',
      'table = Table(["Mechanism", "Direction", "Energy", "Example"], [r1, r2, r3], [1, 2], "Membrane transport comparison")',
      'r1 = Row(["Simple diffusion", "Down the concentration gradient", "No ATP", "Oxygen moving through the phospholipid bilayer"], [1])',
      'r2 = Row(["Facilitated diffusion", "Down the concentration gradient", "No ATP", "Glucose moving through a specific carrier protein"], [2])',
      'r3 = Row(["Active transport / 主动运输", "Against the concentration gradient", "Energy required", "Mineral ions entering plant root hair cells"], [2])',
    ].join('\n'),
    hint: 'Four columns, long cells, CJK text, caption and row-level citations.',
    id: 'chat-openui-table',
    label: 'OpenUI: comparison table',
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
      'root = Answer([intro, chart])',
      'intro = Md("These example measurements are illustrative.")',
      `chart = Chart("${kind}", "${title}: revision time", ["Biology", "Chemistry", "Mathematics"], [Series("This week", [25, 35, 40])${kind === 'pie' || kind === 'stacked' ? '' : ', Series("Last week", [20, 45, 30])'}], null, "min", true)`,
    ].join('\n'),
    hint: 'Illustrative data with labels and units. Resize the chat panel to check fit.',
    id: `chat-openui-${kind}` as const,
    label: `OpenUI: ${title.toLowerCase()}`,
    prompt: `Show revision time as a ${title.toLowerCase()}.`,
  })),
  {
    content: [
      'root = Answer([chart])',
      'chart = ScatterChart("Practice and recall", [Point(5, 40, "Session 1"), Point(10, 55, "Session 2"), Point(15, 70, "Session 3"), Point(20, 65, "Session 4"), Point(25, 85, "Session 5")], "Practice minutes", "Recall score (%)", null, "%", true)',
    ].join('\n'),
    hint: 'Labeled scatter points, axis labels, units and illustrative data.',
    id: 'chat-openui-scatter',
    label: 'OpenUI: scatter chart',
    prompt: 'Plot practice time against recall score.',
  },
  {
    content: [
      'root = Answer([intro, q1, q2, q3])',
      'intro = Md("I need a few details before building your revision plan.")',
      'q1 = AskUser("Which subject is the plan for?", ["Biology", "Chemistry", "Mathematics"])',
      'q2 = AskUser("How much time do you have?", ["15 minutes", "30 minutes", "One hour"])',
      'q3 = AskUser("What should the plan prepare you for?", [])',
    ].join('\n'),
    hint: 'Three docked questions. Try choices, free text, skip, collapse and Send. Older turns show the questions inline.',
    id: 'chat-openui-questions',
    label: 'OpenUI: questions to the user',
    prompt: 'Create a revision plan for me.',
  },
  {
    content:
      '## A readable fallback\n\nThe model returned Markdown.\n\n- **Diffusion** follows a concentration gradient.\n- **Active transport** requires energy.\n\n```text\nhigh concentration → low concentration\n```',
    hint: 'A plain Markdown answer uses the normal fallback without an error.',
    id: 'chat-openui-markdown',
    label: 'OpenUI: Markdown fallback',
    prompt: 'Explain membrane transport in plain language.',
  },
  {
    content:
      'root = Answer([Md("This paragraph was recovered, but the next section is missing."), missing])',
    hint: 'A missing reference keeps the readable content and shows the incomplete-answer notice.',
    id: 'chat-openui-partial',
    label: 'OpenUI failure: partial program',
    prompt: 'Preview an answer with a missing section.',
  },
  {
    content: [
      'root = Answer([intro, good, bad])',
      'intro = Md("The valid chart stays visible. The damaged chart is withheld.")',
      'good = Chart("bar", "Valid measurements", ["A", "B"], [Series("Score", [10, 20])], null, "points", true)',
      'bad = Chart("bar", "Mismatched measurements", ["A", "B", "C"], [Series("Score", [10])], null, "points", true)',
    ].join('\n'),
    hint: 'One valid chart and one mismatched series. Shows the local recovery notice.',
    id: 'chat-openui-invalid-chart',
    label: 'OpenUI failure: invalid chart',
    prompt: 'Preview a malformed chart beside a valid one.',
  },
  {
    content: 'root = Answer(',
    hint: 'No readable content can be recovered. Shows the inline error without raw program syntax.',
    id: 'chat-openui-unusable',
    label: 'OpenUI failure: unusable program',
    prompt: 'Preview an unusable program.',
  },
  {
    content: '',
    errorCode: 'invalid_answer',
    hint: 'The service rejects an empty answer with invalid_answer. The error survives reopening history.',
    id: 'chat-openui-empty',
    label: 'OpenUI failure: empty response',
    prompt: 'Preview an empty model response.',
  },
  {
    content:
      'root = Answer([Md("This partial answer will be cleared when the safety guard flags the response.", [1])])',
    errorCode: 'response_flagged',
    hint: 'Streams a partial answer and citation, then flags it. Both disappear; completed tool activity and the safety notice remain in history.',
    id: 'chat-openui-flagged',
    label: 'OpenUI failure: safety flagged',
    passages: [1],
    prompt: 'Preview the tool-protocol safety guard.',
  },
  {
    closeEarly: true,
    content:
      'root = Answer([Md("This part arrived before the connection closed. The rest of the answer never arrived.")])',
    hint: 'The stream closes before block_end/done. Partial content remains with a connection error.',
    id: 'chat-openui-interrupted',
    label: 'OpenUI failure: interrupted stream',
    prompt: 'Preview a disconnected answer stream.',
  },
  {
    content: overview,
    hint: 'Slow chunks make progressive rendering and Stop easy to inspect. Reopen the conversation to see the saved partial answer.',
    id: 'chat-openui-slow',
    label: 'OpenUI: slow stream / Stop',
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

export function fixtureCitations(
  fixture: ChatFixture,
  sources: Pick<SourceFile, 'id' | 'name' | 'indexed'>[]
): Citation[] {
  const indexed = sources.filter((source) => source.indexed);
  return (fixture.passages ?? []).flatMap((n) => {
    const source = indexed[n - 1];
    return source
      ? [
          {
            fileId: source.id,
            fileName: source.name,
            n,
            snippet: 'Example source passage for the OpenUI preview.',
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
