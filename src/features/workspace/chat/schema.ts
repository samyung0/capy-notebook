/**
 * The rich-answer component catalog: what the model may write in an ordinary
 * chat answer and how each component is shaped. Every component name, prop
 * order and description here reaches the model through the generated prompt
 * (`pnpm gen:openui`), and the Python service reads the same shapes from
 * `pipeline/pipeline/generated/openui_library.json` to find passage refs.
 *
 * `buildLibrary` binds React renderers by name so the prompt generator can
 * run without the app's components (it passes stubs). Prop key order is the
 * positional argument order the model writes.
 */

// biome-ignore-all assist/source/useSortedKeys: zod key order is the positional argument order the model writes

import {
  type ComponentRenderer,
  createLibrary,
  defineComponent,
  type PromptOptions,
} from '@openuidev/react-lang';
import { z } from 'zod/v4';

/** Shown passage numbers ([n] in the tool results) grounding a block. */
const passages = z.array(z.number().int()).optional();

export const mdProps = z.object({ text: z.string(), passages });
export const calloutProps = z.object({
  kind: z.enum(['info', 'tip', 'warning', 'success', 'danger']),
  title: z.string(),
  text: z.string(),
  passages,
});
export const stepProps = z.object({
  title: z.string(),
  text: z.string(),
  passages,
});
export const revealProps = z.object({
  title: z.string(),
  text: z.string(),
  passages,
});
export const tagsProps = z.object({ tags: z.array(z.string()) });
export const factProps = z.object({ label: z.string(), value: z.string() });
export const cardProps = z.object({
  title: z.string(),
  text: z.string(),
  passages,
  value: z.string().optional(),
});
export const rowProps = z.object({ cells: z.array(z.string()), passages });
export const seriesProps = z.object({
  name: z.string(),
  values: z.array(z.number()),
});
export const pointProps = z.object({
  x: z.number(),
  y: z.number(),
  label: z.string().optional(),
});
export const askUserProps = z.object({
  question: z.string(),
  choices: z.array(z.string()),
});

export type MdProps = z.infer<typeof mdProps>;
export type CalloutProps = z.infer<typeof calloutProps>;
export type StepProps = z.infer<typeof stepProps>;
export type RevealProps = z.infer<typeof revealProps>;
export type TagsProps = z.infer<typeof tagsProps>;
export type FactProps = z.infer<typeof factProps>;
export type CardProps = z.infer<typeof cardProps>;
export type RowProps = z.infer<typeof rowProps>;
export type SeriesProps = z.infer<typeof seriesProps>;
export type PointProps = z.infer<typeof pointProps>;
export type AskUserProps = z.infer<typeof askUserProps>;

/** Props of the container components, whose children arrive as element nodes. */
export interface TabProps {
  children: unknown[];
  label: string;
}
export interface AccordionItemProps {
  children: unknown[];
  title: string;
}
export interface TableProps {
  caption?: string;
  columns: string[];
  passages?: number[];
  rows: unknown[];
}
export const chartKinds = [
  'bar',
  'hbar',
  'line',
  'area',
  'pie',
  'stacked',
] as const;
export type ChartKind = (typeof chartKinds)[number];
export interface ChartProps {
  illustrative?: boolean;
  kind: ChartKind;
  labels: string[];
  passages?: number[];
  series: unknown[];
  title: string;
  unit?: string;
}
export interface ScatterProps {
  illustrative?: boolean;
  passages?: number[];
  points: unknown[];
  title: string;
  unit?: string;
  xLabel: string;
  yLabel: string;
}

// OpenUI's own library type is ComponentRenderer<any>; the renderers are typed
// at their definition site.
type AnyRenderer = ComponentRenderer<any>;

export type Renderers = Record<
  | 'Answer'
  | 'Md'
  | 'Callout'
  | 'Tabs'
  | 'Tab'
  | 'Steps'
  | 'Step'
  | 'Accordion'
  | 'AccordionItem'
  | 'Reveal'
  | 'Tags'
  | 'Facts'
  | 'Fact'
  | 'Cards'
  | 'Card'
  | 'Table'
  | 'Row'
  | 'Chart'
  | 'Series'
  | 'ScatterChart'
  | 'Point'
  | 'AskUser',
  AnyRenderer
>;

export function buildLibrary(render: Renderers) {
  const Md = defineComponent({
    component: render.Md,
    description:
      'A paragraph or short section of Markdown prose (headings, lists, code fences, $math$). passages: the shown passage numbers that ground it.',
    name: 'Md',
    props: mdProps,
  });
  const Callout = defineComponent({
    component: render.Callout,
    description:
      'A highlighted note: a definition, tip, misconception, warning or takeaway. text is Markdown.',
    name: 'Callout',
    props: calloutProps,
  });
  const Step = defineComponent({
    component: render.Step,
    description: 'One numbered step: a short title and Markdown text.',
    name: 'Step',
    props: stepProps,
  });
  const Steps = defineComponent({
    component: render.Steps,
    description:
      'A numbered sequence: a process, a derivation, a worked solution.',
    name: 'Steps',
    props: z.object({ items: z.array(Step.ref) }),
  });
  const Reveal = defineComponent({
    component: render.Reveal,
    description:
      'Collapsed Markdown the reader opens on demand: a hint, a solution, extra detail.',
    name: 'Reveal',
    props: revealProps,
  });
  const Tags = defineComponent({
    component: render.Tags,
    description: 'A row of short keyword chips.',
    name: 'Tags',
    props: tagsProps,
  });
  const Fact = defineComponent({
    component: render.Fact,
    description: 'One label/value row.',
    name: 'Fact',
    props: factProps,
  });
  const Facts = defineComponent({
    component: render.Facts,
    description: 'A compact list of label/value rows.',
    name: 'Facts',
    props: z.object({ items: z.array(Fact.ref) }),
  });
  const Card = defineComponent({
    component: render.Card,
    description:
      'A small card: a concept (title + Markdown text) or a metric when value is set (value shown large). Write null for passages when none apply.',
    name: 'Card',
    props: cardProps,
  });
  const Cards = defineComponent({
    component: render.Cards,
    description: 'A grid of two to six Card items.',
    name: 'Cards',
    props: z.object({ items: z.array(Card.ref) }),
  });
  const Row = defineComponent({
    component: render.Row,
    description:
      'One table row; cells are plain text in column order. passages: sources for this row only.',
    name: 'Row',
    props: rowProps,
  });
  const Table = defineComponent({
    component: render.Table,
    description:
      'A read-only comparison table. Keep it narrow: at most four columns. passages: sources for the whole table, or null when none apply.',
    name: 'Table',
    props: z.object({
      columns: z.array(z.string()),
      rows: z.array(Row.ref),
      passages,
      caption: z.string().optional(),
    }),
  });
  const Series = defineComponent({
    component: render.Series,
    description:
      'One data series; values align with the chart labels (pie and stacked take exactly one series).',
    name: 'Series',
    props: seriesProps,
  });
  const Chart = defineComponent({
    component: render.Chart,
    description:
      'A chart over labelled categories: bar, hbar (horizontal), line, area, pie or stacked (one bar split into parts). unit names the values (e.g. "USD", "%"). Cite passages for sourced values, or write null and set illustrative=true for made-up example numbers.',
    name: 'Chart',
    props: z.object({
      kind: z.enum(chartKinds),
      title: z.string(),
      labels: z.array(z.string()),
      series: z.array(Series.ref),
      passages,
      unit: z.string().optional(),
      illustrative: z.boolean().optional(),
    }),
  });
  const Point = defineComponent({
    component: render.Point,
    description: 'One scatter point with an optional label.',
    name: 'Point',
    props: pointProps,
  });
  const ScatterChart = defineComponent({
    component: render.ScatterChart,
    description:
      'A scatter plot of numeric x/y points. Same unit, illustrative and passages rules as Chart.',
    name: 'ScatterChart',
    props: z.object({
      title: z.string(),
      points: z.array(Point.ref),
      xLabel: z.string(),
      yLabel: z.string(),
      passages,
      unit: z.string().optional(),
      illustrative: z.boolean().optional(),
    }),
  });
  const AskUser = defineComponent({
    component: render.AskUser,
    description:
      'A question the user answers before you continue (shown in a question panel, answered in their next message). choices: two to five short options, or [] for a free-text answer.',
    name: 'AskUser',
    props: askUserProps,
  });

  const leaf = [
    Md.ref,
    Callout.ref,
    Steps.ref,
    Reveal.ref,
    Tags.ref,
    Facts.ref,
    Cards.ref,
    Table.ref,
    Chart.ref,
    ScatterChart.ref,
  ] as const;
  const AccordionItem = defineComponent({
    component: render.AccordionItem,
    description: 'One collapsible section.',
    name: 'AccordionItem',
    props: z.object({
      title: z.string(),
      children: z.array(z.union([...leaf])),
    }),
  });
  const Accordion = defineComponent({
    component: render.Accordion,
    description:
      'Collapsible sections for optional depth. Never nest an Accordion inside an Accordion.',
    name: 'Accordion',
    props: z.object({ items: z.array(AccordionItem.ref) }),
  });
  const Tab = defineComponent({
    component: render.Tab,
    description: 'One tab: a short label and its content.',
    name: 'Tab',
    props: z.object({
      label: z.string(),
      children: z.array(z.union([...leaf, Accordion.ref])),
    }),
  });
  const Tabs = defineComponent({
    component: render.Tabs,
    description:
      'Two to six tabs for related concepts, perspectives or examples. Never nest Tabs inside Tabs.',
    name: 'Tabs',
    props: z.object({ items: z.array(Tab.ref) }),
  });
  const Answer = defineComponent({
    component: render.Answer,
    description: 'The whole reply, top to bottom.',
    name: 'Answer',
    props: z.object({
      children: z.array(
        z.union([...leaf, Accordion.ref, Tabs.ref, AskUser.ref])
      ),
    }),
  });

  return createLibrary({
    componentGroups: [
      {
        components: ['Answer', 'Md', 'Callout', 'Reveal', 'Tags'],
        name: 'Prose',
        notes: [
          '- Md is the default. A short question gets one or two Md blocks and nothing else.',
          '- Split prose so each Md or Callout makes one point and names the passages that ground it.',
        ],
      },
      {
        components: [
          'Tabs',
          'Tab',
          'Steps',
          'Step',
          'Accordion',
          'AccordionItem',
          'Facts',
          'Fact',
          'Cards',
          'Card',
        ],
        name: 'Structure',
        notes: [
          '- Tabs: related concepts or one example per tab. Steps: a process or worked solution. Accordion: optional depth.',
          '- Say something useful before the first Tabs or Accordion so the reader has content without clicking.',
        ],
      },
      {
        components: [
          'Table',
          'Row',
          'Chart',
          'Series',
          'ScatterChart',
          'Point',
        ],
        name: 'Data',
        notes: [
          '- Tables and charts are leaves: no components inside them. Cite their passages on the block, not in cells.',
          '- Chart values must come from cited passages or be marked illustrative=true. Never present invented numbers as sourced.',
        ],
      },
      {
        components: ['AskUser'],
        name: 'Questions',
        notes: [
          '- Use AskUser when you must require a user input: which document, which depth, what the material is for. Ask at most three questions, then stop; the answers arrive as the next user message.',
          '- Do NOT use AskUser for simple follow up questions',
        ],
      },
    ],
    components: [
      Answer,
      Md,
      Callout,
      Tabs,
      Tab,
      Steps,
      Step,
      Accordion,
      AccordionItem,
      Reveal,
      Tags,
      Facts,
      Fact,
      Cards,
      Card,
      Table,
      Row,
      Chart,
      Series,
      ScatterChart,
      Point,
      AskUser,
    ],
    root: 'Answer',
  });
}

export const promptOptions: PromptOptions = {
  additionalRules: [
    'Use the API tool_calls field for tool calls; do not mix tool calls or tool-protocol markup into an OpenUI Lang program or text response.',
    'passages lists the shown passage numbers ([n] in the tool results) that support that block, most direct first, or is omitted when the sources do not cover it. Never write [n] markers inside text. Only the current passage headers supply numbers.',
    'Keep the answer as short as the question deserves; rich blocks are for content that reads better as a structure, not decoration.',
    'Write text in the response language rule above. Component names, kinds and prop order stay exactly as listed.',
    'One statement per line. Define root first, then each child in reading order.',
    'To skip an optional argument that comes before one you use, write null in its place. Values are strings, numbers, booleans, null, arrays or component calls; never object literals.',
  ],
  bindings: false,
  editMode: false,
  examples: [
    [
      'root = Answer([a])',
      'a = Md("Atomicity means the transaction completes as a whole or has no effect.", [2])',
    ].join('\n'),
    [
      'root = Answer([intro, tabs, cmp])',
      'intro = Md("ACID names four guarantees a transaction gives. A bank transfer shows the difference.", [1])',
      'tabs = Tabs([t1, t2])',
      't1 = Tab("Atomicity", [t1a, t1s])',
      't1a = Md("Both updates happen or neither does.", [1])',
      't1s = Steps([s1, s2])',
      's1 = Step("Begin", "Open the transaction before touching either balance.", [1])',
      's2 = Step("Commit or roll back", "If either update fails, both balances stay as they were.", [1])',
      't2 = Tab("Durability", [t2a])',
      't2a = Callout("info", "After commit", "A committed transfer survives a crash.", [2])',
      'cmp = Table(["Property", "Question it answers"], [r1, r2], [1, 2], "The four guarantees")',
      'r1 = Row(["Atomicity", "Did the whole transfer happen?"])',
      'r2 = Row(["Durability", "Will the result survive?"], [2])',
    ].join('\n'),
  ],
  inlineMode: false,
  preamble:
    'Final answer format: a response that calls no tools is the final answer and must be one OpenUI Lang program, nothing before or after it. Text that accompanies a tool call stays plain prose.',
  toolCalls: false,
};
