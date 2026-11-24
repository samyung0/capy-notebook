import { z } from 'zod';
import * as limits from '@/api/limits.generated';
import { mergedCap, passesCap } from '@/api/mergedCap';
import { m } from '@/i18n';
import { CopyError } from '@/lib/copyError';
import { quantityValuePattern } from './quantity';
import {
  CHART_KINDS,
  canvasCount,
  type GraphElement,
  gapNumbers,
  modelMarked,
  partAnswerCanvas,
  type Question,
  type QuestionBlock,
} from './types';

const trailingSlash = /\/$/;

/** The canvases one block list holds, the stem's, a group's or a part's
 * (Epo 2026-11-23): one, which an editor stops at. Go's `partCanvases` and
 * Rust's `PART_CANVASES_MAX` are the same. */
export const PART_CANVASES_MAX = 1;

/** The block lists that may hold a canvas, by where a live quiz keeps them:
 * `stem`, `groups/<id>` and `parts/<id>` (`canvasCapIssue`). */
export function canvasLists(
  question: Question
): (readonly [string, QuestionBlock[]])[] {
  return [
    ['stem', question.stem] as const,
    ...(question.groups ?? []).map(
      (group) => [`groups/${group.id}`, group.blocks] as const
    ),
    ...question.parts.map((part) => [`parts/${part.id}`, part.blocks] as const),
  ];
}

/** A question's canvases (Epo 2026-11-23): its canvas blocks in the stem,
 * groups and parts and its drawn sample answers, at most
 * QUESTION_CANVASES_MAX. */
export function questionCanvases(question: Question): number {
  return (
    canvasLists(question).reduce(
      (sum, [, blocks]) => sum + canvasCount(blocks),
      0
    ) +
    question.parts.filter(
      (part) => part.answer.type === 'canvas' && part.answer.sample
    ).length
  );
}

export type QuestionPolicy = {
  bank?: boolean;
  bankAssetsUrl?: string;
  snapshot?: boolean;
};
/** A cap as one validator takes it (Epo 2026-11-22, "Yes, A everywhere"):
 * twice it (`mergedCap`) for quizzes, notes and attempt snapshots, whose live
 * rooms may merge two people's adds or typing past it; the cap itself for the
 * bank's questions, which no room merges. Rust `Policy::held` and Go
 * `Policy.held` are the same. */
type Held = (cap: number) => number;
const atCap: Held = (cap) => cap;

/** Trimmed, not blank, at most `max` code points. */
const textWithin = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((value) => [...value].length <= max, {
      error: () => m.question_validation_text_too_long(),
    });
const text = textWithin(limits.QUESTION_TEXT_MAX);
// A chart category label may be empty (Epo 2026-10-14), 60 at most
// (Epo 2026-10-17).
const label = z
  .string()
  .trim()
  .refine((value) => [...value].length <= limits.QUESTION_CHART_LABEL_MAX, {
    error: () => m.question_validation_text_too_long(),
  });
const identifier = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    error: () => m.question_validation_id_required(),
  })
  .refine((value) => [...value].length <= limits.QUESTION_ID_MAX, {
    error: () => m.question_validation_text_too_long(),
  });
const meta = z
  .string()
  .refine((value) => [...value].length <= limits.QUESTION_METADATA_MAX, {
    error: () => m.question_validation_text_too_long(),
  });
// A graph's point names and angle labels, and its label text (Epo 2026-10-17).
const graphName = z
  .string()
  .refine((value) => [...value].length <= limits.QUESTION_GRAPH_NAME_MAX, {
    error: () => m.question_validation_text_too_long(),
  });
const graphSize = {
  height: z
    .number()
    .int()
    .min(limits.QUESTION_GRAPH_DIMENSION_MIN)
    .max(limits.QUESTION_GRAPH_DIMENSION_MAX),
  width: z
    .number()
    .int()
    .min(limits.QUESTION_GRAPH_DIMENSION_MIN)
    .max(limits.QUESTION_GRAPH_DIMENSION_MAX),
};
const graphLabel = text.refine(
  (value) => [...value].length <= limits.QUESTION_GRAPH_LABEL_MAX,
  { error: () => m.question_validation_text_too_long() }
);
/** A chart's or plot's title, axis title, unit, series name or label, within
 * its own bound (plots match charts, Epo 2026-10-17). */
const chartText = (max: number) =>
  z.string().refine((value) => [...value].length <= max, {
    error: () => m.question_validation_text_too_long(),
  });
const chartTitle = chartText(limits.QUESTION_CHART_TITLE_MAX);
const plotTitle = chartText(limits.QUESTION_PLOT_TITLE_MAX);
const plotLabel = chartText(limits.QUESTION_PLOT_LABEL_MAX);
// A plot's coordinate or line value; an empty cell in its editor is NaN.
const plotNumber = z.number({
  error: () => m.question_validation_plot_number(),
});
const finite = z.number().finite();
const index = z.number().int().nonnegative();
const coords = z.tuple([finite, finite]);
const imageSize = {
  height: z.number().int().min(1).max(limits.QUESTION_IMAGE_DIMENSION_MAX),
  width: z.number().int().min(1).max(limits.QUESTION_IMAGE_DIMENSION_MAX),
};
const style = { dash: z.boolean().optional(), hidden: z.boolean().optional() };

const nonzeroDigit = /[1-9]/;
const scientificSeparator = /[eE]/;
export function validQuantityValue(value: string): boolean {
  const input = value.trim();
  if (!quantityValuePattern.test(input)) return false;
  const denominator = input.split('/')[1];
  return (
    denominator === undefined ||
    nonzeroDigit.test(denominator.split(scientificSeparator)[0])
  );
}

// A formula row's or a formula's LaTeX: not blank, within its cap.
const graphLatex = (cap: number) =>
  z
    .string()
    .refine((value) => value.trim().length > 0 && [...value].length <= cap, {
      error: () => m.question_validation_text_too_long(),
    });
const textSize = z
  .number()
  .int()
  .min(limits.QUESTION_GRAPH_TEXT_SIZE_MIN)
  .max(limits.QUESTION_GRAPH_TEXT_SIZE_MAX);
// A stroke's or curve's points: one while a stroke is drawn on the plane.
const pathPoints = z.array(coords).min(1).max(limits.QUESTION_GRAPH_PATH_MAX);

/** One graph element, the one check every surface runs on each element: quiz,
 * note and bank graphs and the canvas plane's load check (boardLoad.ts). Go
 * `questions.graph` and Rust `questions::graph_element` are the same, on the
 * shared fixtures. */
export const graphElementSchema = z.discriminatedUnion('type', [
  // A formula row's LaTeX as typed (Epo 2026-11-18); what it draws is read
  // where it is drawn, so no grammar is checked here.
  z.strictObject({
    id: identifier,
    latex: graphLatex(limits.QUESTION_GRAPH_EXPRESSION_MAX),
    type: z.literal('expression'),
    ...style,
  }),
  z.strictObject({
    coords,
    hidden: z.boolean().optional(),
    id: identifier,
    name: graphName.optional(),
    type: z.literal('point'),
  }),
  z.strictObject({
    id: identifier,
    points: z.tuple([identifier, identifier]),
    type: z.literal('line'),
    ...style,
  }),
  z.strictObject({
    arrow: z.boolean().optional(),
    id: identifier,
    points: z.tuple([identifier, identifier]),
    ticks: z.number().int().min(1).max(3).optional(),
    type: z.literal('segment'),
    ...style,
  }),
  z.strictObject({
    center: identifier,
    id: identifier,
    radius: finite.positive(),
    type: z.literal('circle'),
    ...style,
  }),
  z.strictObject({
    coords,
    hidden: z.boolean().optional(),
    id: identifier,
    size: textSize.optional(),
    text: graphLabel,
    type: z.literal('text'),
  }),
  z.strictObject({
    hidden: z.boolean().optional(),
    id: identifier,
    label: graphName.optional(),
    points: z.tuple([identifier, identifier, identifier]),
    type: z.literal('angle'),
  }),
  z.strictObject({
    center: identifier,
    id: identifier,
    points: z.tuple([identifier, identifier]),
    type: z.literal('arc'),
    ...style,
  }),
  z.strictObject({
    center: identifier,
    id: identifier,
    points: z.tuple([identifier, identifier]),
    shade: z.boolean().optional(),
    type: z.literal('sector'),
    ...style,
  }),
  z.strictObject({
    id: identifier,
    points: z.array(identifier).min(3).max(limits.QUESTION_GRAPH_POLYGON_MAX),
    shade: z.boolean().optional(),
    type: z.literal('polygon'),
    ...style,
  }),
  // The free marks hold their own coordinates (Epo 2026-11-16, D1).
  z.strictObject({
    arrow: z.boolean().optional(),
    coords: pathPoints,
    id: identifier,
    type: z.literal('polyline'),
    ...style,
  }),
  // Optional [in, out] Bézier handles, a pair for each point.
  z
    .strictObject({
      coords: pathPoints,
      handles: z
        .array(z.tuple([coords, coords]))
        .max(limits.QUESTION_GRAPH_PATH_MAX)
        .optional(),
      id: identifier,
      type: z.literal('curve'),
      ...style,
    })
    .refine((v) => !v.handles || v.handles.length === v.coords.length, {
      error: () => m.question_validation_graph_handles(),
      path: ['handles'],
    }),
  z.strictObject({
    center: coords,
    id: identifier,
    radii: coords,
    type: z.literal('ellipse'),
    ...style,
  }),
  // LaTeX centred on its point (D6), KaTeX laying it out.
  z.strictObject({
    coords,
    hidden: z.boolean().optional(),
    id: identifier,
    latex: graphLatex(limits.QUESTION_GRAPH_LATEX_MAX),
    size: textSize.optional(),
    type: z.literal('formula'),
  }),
]);

/** What breaks across a graph's elements, past each one's own check: an id
 * used twice, a construction naming a missing or repeated point or a center
 * among its points. */
export type GraphElementsIssue = 'center' | 'ids' | 'points';
export function graphElementsIssue(
  elements: readonly GraphElement[]
): GraphElementsIssue | null {
  const ids = new Set<string>();
  const points = new Set(
    elements.filter((e) => e.type === 'point').map((e) => e.id)
  );
  for (const element of elements) {
    if (ids.has(element.id)) return 'ids';
    ids.add(element.id);
    const named = 'points' in element ? element.points : [];
    if (
      named.some((id) => !points.has(id)) ||
      new Set(named).size !== named.length
    )
      return 'points';
    if (
      (element.type === 'circle' ||
        element.type === 'arc' ||
        element.type === 'sector') &&
      (!points.has(element.center) || named.includes(element.center))
    )
      return 'center';
  }
  return null;
}

/** A chart block. A live one (a room's, repaired: `liveFigureSchema`) may
 * also have no series, and as a pie or stacked chart no positive total. */
const chartSchema = (live: boolean, held: Held) =>
  z
    .strictObject({
      description: textWithin(held(limits.QUESTION_TEXT_MAX)).optional(),
      gridlines: z.enum(['normal', 'fine']).optional(),
      kind: z.enum(CHART_KINDS),
      labels: z.array(label).min(1).max(held(limits.QUESTION_CHART_LABELS_MAX)),
      series: z
        .array(
          z.strictObject({
            name: chartText(limits.QUESTION_CHART_SERIES_NAME_MAX),
            // null is an empty cell, drawn as nothing (Epo 2026-10-14).
            values: z
              .array(
                finite
                  .min(-limits.QUESTION_CHART_VALUE_MAX)
                  .max(limits.QUESTION_CHART_VALUE_MAX)
                  .nullable()
              )
              .min(1)
              .max(held(limits.QUESTION_CHART_LABELS_MAX)),
          })
        )
        .min(live ? 0 : 1)
        .max(held(limits.QUESTION_CHART_SERIES_MAX)),
      title: chartTitle,
      type: z.literal('chart'),
      xTitle: chartTitle.optional(),
      yTitle: chartTitle.optional(),
    })
    .superRefine((v, ctx) => {
      if (v.series.some((s) => s.values.length !== v.labels.length))
        ctx.addIssue({
          code: 'custom',
          message: m.question_validation_series_values(),
        });
      // Empty cells are skipped: the rest are nonnegative with a positive
      // total. A live chart keeps at most its first series and any values
      // (Epo 2026-10-18).
      if (
        ['pie', 'stacked'].includes(v.kind) &&
        (live
          ? v.series.length > 1
          : v.series.length !== 1 ||
            v.series[0].values.some((n) => n !== null && n < 0) ||
            !v.series[0].values.some((n) => n !== null && n > 0))
      )
        ctx.addIssue({
          code: 'custom',
          message: m.question_validation_pie_series(),
        });
    });

/** A plot block; a live one may also have no series. */
const plotSchema = (live: boolean, held: Held) =>
  z
    .strictObject({
      description: textWithin(held(limits.QUESTION_TEXT_MAX)).optional(),
      kind: z.enum(['line', 'scatter']).optional(),
      lines: z
        .array(
          z.strictObject({
            axis: z.enum(['x', 'y']),
            label: plotLabel.optional(),
            value: plotNumber,
          })
        )
        .max(limits.QUESTION_PLOT_MARKS_MAX)
        .optional(),
      marks: z
        .array(
          z.strictObject({ label: plotLabel, x: plotNumber, y: plotNumber })
        )
        .max(limits.QUESTION_PLOT_MARKS_MAX)
        .optional(),
      series: z
        .array(
          z.strictObject({
            name: plotLabel,
            points: z
              .array(z.tuple([plotNumber, plotNumber]))
              .min(1)
              .max(limits.QUESTION_PLOT_POINTS_MAX),
          })
        )
        .min(live ? 0 : 1)
        .max(limits.QUESTION_PLOT_SERIES_MAX),
      title: plotTitle,
      type: z.literal('plot'),
      unit: plotTitle.optional(),
      xTitle: plotTitle,
      yTitle: plotTitle,
    })
    // A scatter series needs one point, a line two (Epo 2026-10-14).
    .refine(
      (v) =>
        v.kind === 'scatter' || v.series.every((s) => s.points.length >= 2),
      { error: () => m.question_validation_plot_line_points() }
    );

const graphIssueMessages = {
  center: m.question_validation_graph_circles,
  ids: m.question_validation_graph_ids,
  points: m.question_validation_graph_lines,
} satisfies Record<GraphElementsIssue, () => string>;

const graphSchema = (held: Held) =>
  z
    .strictObject({
      board: z.strictObject({
        axis: z.boolean(),
        bbox: z.tuple([finite, finite, finite, finite]),
        grid: z.boolean(),
        polar: z.boolean().optional(),
      }),
      elements: z
        .array(graphElementSchema)
        .max(held(limits.QUESTION_GRAPH_ELEMENTS_MAX)),
      type: z.literal('graph'),
      ...graphSize,
      description: textWithin(held(limits.QUESTION_TEXT_MAX)).optional(),
    })
    .superRefine((v, ctx) => {
      const [left, top, right, bottom] = v.board.bbox;
      if (left >= right || bottom >= top)
        ctx.addIssue({
          code: 'custom',
          message: m.question_validation_graph_bounds(),
        });
      const issue = graphElementsIssue(v.elements);
      if (issue)
        ctx.addIssue({ code: 'custom', message: graphIssueMessages[issue]() });
    });

/** The question schemas with each list and typed text a live room's merges
 * can pass within `held` of its cap. */
function questionSchemas(held: Held) {
  const text = textWithin(held(limits.QUESTION_TEXT_MAX));
  const list = z.array(text).min(1).max(held(limits.QUESTION_ANSWERS_MAX));
  const graph = graphSchema(held);
  /** A canvas (Epo 2026-11-23): empty, or its board and picture together,
   * both the quiz's editor assets. Every block list takes one, so the rules
   * after the schema say where it may go (`ruleIssues`, never an
   * explanation); notes hold none (the store refuses one). */
  const canvas = z
    .strictObject({
      board: identifier.optional(),
      image: identifier.optional(),
      type: z.literal('canvas'),
    })
    .refine((v) => (v.board === undefined) === (v.image === undefined), {
      error: () => m.question_validation_canvas_pair(),
    });
  const block = z.discriminatedUnion('type', [
    z.strictObject({ text, type: z.literal('text') }),
    z
      .strictObject({
        header: z.boolean(),
        rows: z
          .array(
            z
              .array(
                z
                  .string()
                  .refine(
                    (value) =>
                      [...value].length <= held(limits.QUESTION_TEXT_MAX),
                    { error: () => m.question_validation_text_too_long() }
                  )
              )
              .min(1)
              .max(held(limits.QUESTION_TABLE_COLUMNS_MAX))
          )
          .min(1)
          .max(held(limits.QUESTION_TABLE_ROWS_MAX)),
        type: z.literal('table'),
      })
      .refine((v) => v.rows.every((row) => row.length === v.rows[0].length), {
        error: () => m.question_validation_table_rows(),
      }),
    chartSchema(false, held),
    plotSchema(false, held),
    z.strictObject({
      image: z.union([
        z.strictObject({ url: z.url().max(limits.QUESTION_ASSET_URL_MAX) }),
        z.strictObject({ assetId: identifier }),
      ]),
      type: z.literal('image'),
      ...imageSize,
      attribution: meta.optional(),
      description: text.optional(),
    }),
    graph,
    canvas,
  ]);
  /** A figure as a room holds it, repaired (Epo 2026-10-18): what a merge
   * leaves that the repair keeps, a chart or plot without series and a pie or
   * stacked chart without a positive total, reads; every write still takes
   * the block schema. */
  const liveFigure = z.discriminatedUnion('type', [
    chartSchema(true, held),
    plotSchema(true, held),
    graph,
  ]);
  const answers = held(limits.QUESTION_ANSWERS_MAX);
  const answer = z.discriminatedUnion('type', [
    z
      .strictObject({
        correct: z.array(index).min(1).max(answers),
        // Shuffle options keeps these options in place (Epo 2026-11-15).
        locked: z.array(index).min(1).max(answers).optional(),
        // Multiple answer (Epo 2026-11-15): checkboxes even with one correct.
        multiple: z.literal(true).optional(),
        options: list.min(2),
        shuffle: z.literal(true).optional(),
        type: z.literal('mcq'),
      })
      .superRefine((v, ctx) => {
        if (
          new Set(v.correct).size !== v.correct.length ||
          v.correct.some((n) => n >= v.options.length)
        )
          ctx.addIssue({
            code: 'custom',
            message: m.question_validation_correct_options(),
          });
        // Sorted, distinct option indices, only with shuffle.
        const { locked } = v;
        if (
          locked &&
          (!v.shuffle ||
            locked.some(
              (n, i) => n >= v.options.length || (i > 0 && n <= locked[i - 1])
            ))
        )
          ctx.addIssue({
            code: 'custom',
            message: m.question_validation_locked_options(),
          });
      }),
    z.strictObject({ correct: z.boolean(), type: z.literal('boolean') }),
    z
      .strictObject({
        accepted: list,
        type: z.literal('short'),
        unit: z
          .string()
          .trim()
          .min(1)
          .refine((value) => [...value].length <= limits.QUESTION_UNIT_MAX, {
            error: () => m.question_validation_text_too_long(),
          })
          .optional(),
      })
      .refine(
        (v) => !v.unit || v.accepted.every((a) => validQuantityValue(a)),
        {
          error: () => m.question_validation_unit_answers(),
        }
      ),
    z
      .strictObject({
        options: list,
        pairs: z
          .array(z.strictObject({ left: text, right: index }))
          .min(1)
          .max(answers),
        type: z.literal('matching'),
      })
      .refine((v) => v.pairs.every((p) => p.right < v.options.length), {
        error: () => m.question_validation_matching_pairs(),
      }),
    z.strictObject({ items: list.min(2), type: z.literal('ordering') }),
    // One accepted list per numbered gap in the part's text (a gap's number
    // is its key, which two editors cannot both add past the cap).
    z.strictObject({
      accepted: z.array(list).min(1).max(limits.QUESTION_ANSWERS_MAX),
      type: z.literal('gaps'),
    }),
    // At most one sample answer, and it is optional (Epo 2026-10-15).
    z.strictObject({
      accepted: z.array(text).max(1),
      type: z.literal('open'),
    }),
    z.strictObject({
      // A drawn sample answer's board and image, the quiz's editor assets.
      sample: z
        .strictObject({ board: identifier, image: identifier })
        .optional(),
      // Answered in the canvas above it (Epo 2026-11-23, `partAnswerCanvas`).
      shared: z.literal(true).optional(),
      type: z.literal('canvas'),
    }),
  ]);
  const blocks = z.array(block).max(held(limits.QUESTION_BLOCKS_MAX));
  const question = z.strictObject({
    // Text and figures over parts, a stem's blocks and caps (Epo 2026-11-04).
    // A group has at least one part, so no more groups than parts.
    groups: z
      .array(
        z.strictObject({
          blocks,
          id: identifier,
        })
      )
      .max(limits.QUESTION_PARTS_MAX)
      .optional(),
    id: identifier,
    labels: z.enum(['letters', 'numbers']),
    layout: z.enum(['paper', 'split']),
    level: z.enum(['recall', 'application', 'analysis']).optional(),
    parts: z
      .array(
        z.strictObject({
          answer,
          awarded: finite.nonnegative().optional(),
          blocks: blocks.min(1),
          group: identifier.optional(),
          id: identifier,
          itemAwards: z.array(finite).optional(),
          itemResults: z.array(z.boolean()).optional(),
          // Up to twice the cap, closed parts too: two editors' marking
          // items merged at once may take a total past it, and the part
          // may turn closed meanwhile (editors clamp, `withAnswer`).
          marks: z.number().int().min(1).max(held(limits.QUESTION_MARKS_MAX)),
          markscheme: z
            .array(
              z.strictObject({
                marks: z.number().int().min(1),
                text: z
                  .string()
                  .trim()
                  .min(1)
                  .refine(
                    (value) =>
                      [...value].length <= held(limits.QUESTION_MARK_ITEM_MAX),
                    { error: () => m.question_validation_text_too_long() }
                  ),
              })
            )
            .min(1)
            .max(limits.QUESTION_MARKSCHEME_MAX)
            .optional(),
          solution: blocks,
        })
      )
      .min(1)
      .max(limits.QUESTION_PARTS_MAX),
    stem: blocks,
    topicIds: z
      .array(identifier)
      .max(limits.QUESTION_TOPICS_MAX)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
  });
  return { block, liveFigure, question };
}

const merged = questionSchemas(mergedCap);
const bankSchemas = questionSchemas(atCap);
/** A quiz's, note's or attempt's block, its lists and typed texts up to twice
 * their caps (`questionSchemas`). */
export const questionBlockSchema = merged.block;
export const liveFigureSchema = merged.liveFigure;
export const questionSchema = merged.question;
/** The question schema `policy` takes: the bank's at the caps, every other's
 * up to twice them. */
export const questionSchemaFor = (policy: QuestionPolicy) =>
  policy.bank ? bankSchemas.question : merged.question;

function hostedAsset(value: string, base?: string): boolean {
  // The schema refuses a value that is no URL; the issue list still runs these
  // rules over it.
  if (!(base && URL.canParse(value))) return false;
  const url = new URL(value);
  const allowed = new URL(base);
  const prefix = `${allowed.pathname.replace(trailingSlash, '')}/`;
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.origin === allowed.origin &&
    url.pathname.startsWith(prefix)
  );
}

/** A hand-written rule a schema-valid question fails: the rule, where (a
 * part index, and a block's section and index), and its copy. */
export type RuleIssue = {
  rule:
    | 'groups'
    | 'part-ids'
    | 'awarded'
    | 'gap-markers'
    | 'markscheme-open'
    | 'markscheme-total'
    | 'awarded-range'
    | 'bank-solution'
    | 'bank-canvas'
    | 'canvas-place'
    | 'canvas-count'
    | 'canvas-part'
    | 'canvas-shared'
    | 'canvases'
    | 'quiz-markscheme'
    | 'open-answer-length'
    | 'quiz-question-parts'
    | 'images'
    | 'description'
    | 'asset-host';
  part?: number;
  /** A block in `groups[group]` (its section is 'group'). */
  group?: number;
  block?: { section: 'stem' | 'group' | 'blocks' | 'solution'; index: number };
  message: string;
};

/** Groups' ids are unique, each has a part, a part's group is one the question
 * holds, and a group's parts sit next to each other. */
function groupsHold(question: Question): boolean {
  const held = new Set(question.groups?.map((group) => group.id));
  if (held.size !== (question.groups?.length ?? 0)) return false;
  const seen = new Set<string>();
  let previous: string | undefined;
  for (const { group } of question.parts) {
    if (group !== undefined) {
      if (!held.has(group) || (seen.has(group) && previous !== group))
        return false;
      seen.add(group);
    }
    previous = group;
  }
  return seen.size === held.size;
}

/** Every hand-written rule the schema-valid `question` fails, in the order
 * `validateQuestion` checks them. */
export function ruleIssues(
  question: Question,
  policy: QuestionPolicy = {}
): RuleIssue[] {
  const issues: RuleIssue[] = [];
  if (!groupsHold(question))
    issues.push({ message: m.question_validation_groups(), rule: 'groups' });
  const ids = new Set<string>();
  question.parts.forEach((part, index) => {
    const fail = (rule: RuleIssue['rule'], message: string) =>
      issues.push({ message, part: index, rule });
    if (ids.has(part.id)) fail('part-ids', m.question_validation_part_ids());
    ids.add(part.id);
    if (
      !policy.snapshot &&
      (part.awarded !== undefined ||
        part.itemAwards !== undefined ||
        part.itemResults !== undefined)
    )
      fail('awarded', m.question_validation_awarded_marks());
    // Each accepted list belongs to one blank, numbered 1 to n in the text.
    if (
      part.answer.type === 'gaps' &&
      gapNumbers(part.blocks).join() !==
        part.answer.accepted.map((_, i) => i + 1).join()
    )
      fail('gap-markers', m.question_validation_gap_markers());
    // Only model-marked parts have a marking scheme, which the model marks against.
    if (modelMarked(part.answer.type) !== (part.markscheme !== undefined))
      fail('markscheme-open', m.question_validation_markscheme_open());
    if (
      part.markscheme &&
      part.markscheme.reduce((sum, item) => sum + item.marks, 0) !== part.marks
    )
      fail('markscheme-total', m.question_validation_markscheme_total());
    if (
      (part.awarded !== undefined &&
        (part.awarded > part.marks || (part.awarded * 2) % 1 !== 0)) ||
      (part.itemAwards !== undefined && !validItemAwards(part))
    )
      fail('awarded-range', m.question_validation_awarded_range());
    if (policy.bank && part.solution.length === 0)
      fail('bank-solution', m.question_validation_bank_solution());
    // A canvas part answers on a canvas, which bank images (public links)
    // cannot hold yet (its canvas blocks are refused where they sit, below):
    // its own, or the one above it (`shared`).
    if (policy.bank) {
      if (part.answer.type === 'canvas')
        fail('bank-canvas', m.question_validation_bank_canvas());
      return;
    }
    // One canvas a block list, which two editors' adds at once may make two
    // (the stem's and the groups' after the parts).
    if (canvasCount(part.blocks) > mergedCap(PART_CANVASES_MAX))
      fail('canvas-count', m.question_validation_canvas_count());
    if (part.answer.type === 'canvas' && !partAnswerCanvas(question, part))
      fail(
        part.answer.shared ? 'canvas-shared' : 'canvas-part',
        part.answer.shared
          ? m.question_validation_canvas_shared()
          : m.question_validation_canvas_part()
      );
    // User quizzes (not the bank) cap marking items and sample answer length,
    // as their merges may leave them: up to twice each.
    const items = mergedCap(limits.QUIZ_MARKSCHEME_MAX);
    if (part.markscheme && part.markscheme.length > items)
      fail(
        'quiz-markscheme',
        m.question_validation_quiz_markscheme({ max: items })
      );
    const length = mergedCap(limits.QUIZ_OPEN_ANSWER_MAX);
    if (
      part.answer.type === 'open' &&
      part.answer.accepted.some((text) => [...text].length > length)
    )
      fail(
        'open-answer-length',
        m.question_validation_open_answer_length({ max: length })
      );
  });
  if (
    !policy.bank &&
    [
      question.stem,
      ...(question.groups ?? []).map((group) => group.blocks),
    ].some((blocks) => canvasCount(blocks) > mergedCap(PART_CANVASES_MAX))
  )
    issues.push({
      message: m.question_validation_canvas_count(),
      rule: 'canvas-count',
    });
  const parts = mergedCap(limits.QUIZ_QUESTION_PARTS_MAX);
  if (!policy.bank && question.parts.length > parts)
    issues.push({
      message: m.question_validation_quiz_question_parts({ max: parts }),
      rule: 'quiz-question-parts',
    });
  // The grader is sent every image but the explanations' (Epo 2026-11-23);
  // canvases are counted on their own.
  const images = [
    question.stem,
    ...(question.groups ?? []).map((group) => group.blocks),
    ...question.parts.map((part) => part.blocks),
  ]
    .flat()
    .filter((block) => block.type === 'image').length;
  if (images > limits.QUESTION_IMAGES_MAX)
    issues.push({
      message: m.question_validation_images({
        max: limits.QUESTION_IMAGES_MAX,
      }),
      rule: 'images',
    });
  if (questionCanvases(question) > limits.QUESTION_CANVASES_MAX)
    issues.push({
      message: m.question_validation_canvases({
        max: limits.QUESTION_CANVASES_MAX,
      }),
      rule: 'canvases',
    });
  type Section = NonNullable<RuleIssue['block']>['section'];
  const sections: {
    blocks: QuestionBlock[];
    group?: number;
    part?: number;
    section: Section;
  }[] = [
    { blocks: question.stem, section: 'stem' },
    ...(question.groups ?? []).map((group, index) => ({
      blocks: group.blocks,
      group: index,
      section: 'group' as const,
    })),
    ...question.parts.flatMap((part, index) =>
      (['blocks', 'solution'] as const).map((section) => ({
        blocks: part[section],
        part: index,
        section,
      }))
    ),
  ];
  for (const { blocks, group, part, section } of sections)
    blocks.forEach((block, index) => {
      const fail = (rule: RuleIssue['rule'], message: string) =>
        issues.push({ block: { index, section }, group, message, part, rule });
      if (!(policy.bank || descriptionFits(block)))
        fail('description', m.question_validation_text_too_long());
      if (block.type === 'canvas' && section === 'solution')
        fail('canvas-place', m.question_validation_canvas_place());
      else if (block.type === 'canvas' && policy.bank)
        fail('bank-canvas', m.question_validation_bank_canvas());
      if (block.type !== 'image') return;
      // Bank figures must be hosted bank assets; quiz figures are editor
      // assets, or a copied bank question's link under the deployment's
      // BANK_ASSETS_URL (VITE_BANK_ASSETS_URL, scripts/env/config.py). Outside
      // Vite (the site worker bundles this module) import.meta.env is
      // undefined.
      // An empty link (an image not uploaded yet) fails the schema instead.
      if (
        'url' in block.image
          ? block.image.url !== '' &&
            !hostedAsset(
              block.image.url,
              policy.bank
                ? policy.bankAssetsUrl
                : import.meta.env?.VITE_BANK_ASSETS_URL
            )
          : 'assetId' in block.image && policy.bank
      )
        fail('asset-host', m.question_validation_asset_host());
    });
  return issues;
}

export function validateQuestion(
  value: unknown,
  policy: QuestionPolicy = {}
): Question {
  const question = questionSchemaFor(policy).parse(value);
  const [issue] = ruleIssues(question, policy);
  if (issue) throw new CopyError(issue.message);
  return question;
}

/** A figure's description within QUESTION_DESCRIPTION_MAX, the bound in
 * quizzes and notes (a chart's or plot's is optional; an image's, typed in
 * place, up to twice it, as two people typing at once may pass it; a chart's,
 * plot's or graph's is written whole); bank questions take QUESTION_TEXT_MAX. */
export function descriptionFits(block: QuestionBlock): boolean {
  const description = 'description' in block ? block.description : undefined;
  const max =
    block.type === 'image'
      ? mergedCap(limits.QUESTION_DESCRIPTION_MAX)
      : limits.QUESTION_DESCRIPTION_MAX;
  return description === undefined || [...description].length <= max;
}

/** Open parts earn none, half or all of each item's marks, summing to `awarded`. */
function validItemAwards(part: Question['parts'][number]): boolean {
  const awards = part.itemAwards ?? [];
  const items = part.markscheme;
  return (
    items !== undefined &&
    awards.length === items.length &&
    awards.every((award, i) => {
      const marks = items[i].marks;
      return award === 0 || award === marks / 2 || award === marks;
    }) &&
    awards.reduce((sum, award) => sum + award, 0) === part.awarded
  );
}

/** One attempt's open parts must fit a single grading request: a quiz's
 * parts and AI-marked parts up to twice their caps, as two editors' adds at
 * once may leave them (Epo 2026-11-22). Rust `assert_quiz_bounds` and Go
 * `questions.QuizBounds` are the same. */
export function quizBounds(questions: Question[]) {
  const { open, parts } = quizCounts(questions);
  const most = mergedCap(limits.QUIZ_PARTS_MAX);
  if (parts > most)
    throw new CopyError(m.question_validation_quiz_parts({ max: most }));
  const openMost = mergedCap(limits.QUIZ_OPEN_PARTS_MAX);
  if (open > openMost)
    throw new CopyError(
      m.question_validation_quiz_open_parts({ max: openMost })
    );
}

/** A quiz's parts and AI-marked parts. */
export type QuizCounts = { open: number; parts: number };
export function quizCounts(questions: Question[]): QuizCounts {
  const parts = questions.flatMap((question) => question.parts);
  return {
    open: parts.filter((part) => modelMarked(part.answer.type)).length,
    parts: parts.length,
  };
}

/** What an editor's write checks against the quiz as it reads now (`now`):
 * one that adds a part or an AI-marked part past QUIZ_PARTS_MAX or
 * QUIZ_OPEN_PARTS_MAX does not go (its message), one that adds none does, as
 * two editors' adds merged at once may leave a quiz past them (Epo
 * 2026-11-22). Go's `questions.QuizCaps` is the same check on a whole copy. */
export function quizCapsIssue(now: QuizCounts, next: QuizCounts) {
  if (passesCap(next.parts, now.parts, limits.QUIZ_PARTS_MAX))
    return m.question_validation_quiz_parts({ max: limits.QUIZ_PARTS_MAX });
  if (passesCap(next.open, now.open, limits.QUIZ_OPEN_PARTS_MAX))
    return m.question_validation_quiz_open_parts({
      max: limits.QUIZ_OPEN_PARTS_MAX,
    });
  return null;
}

/** What an editor's write of `next` checks against its block lists as they
 * read now (`held`, each list's canvases by its `canvasLists` key): one that
 * takes the stem, a group or a part past PART_CANVASES_MAX canvases does not
 * go (its message), as two editors' adds merged at once may leave two
 * (`quizCapsIssue` for the quiz's parts). */
export function canvasCapIssue(
  held: ReadonlyMap<string, number>,
  next: Question
) {
  const over = canvasLists(next).some(([key, blocks]) =>
    passesCap(canvasCount(blocks), held.get(key) ?? 0, PART_CANVASES_MAX)
  );
  return over ? m.question_validation_canvas_count() : null;
}

export function validateQuestions(
  value: unknown,
  policy: QuestionPolicy = {}
): Question[] {
  const questions = z
    .array(z.unknown())
    .max(
      policy.bank ? limits.QUESTION_COUNT_MAX : mergedCap(limits.QUIZ_PARTS_MAX)
    )
    .parse(value)
    .map((q) => validateQuestion(q, policy));
  if (!policy.bank) quizBounds(questions);
  const ids = new Set<string>();
  const partIds = new Set<string>();
  for (const question of questions) {
    if (ids.has(question.id))
      throw new CopyError(m.question_validation_question_ids());
    ids.add(question.id);
    for (const part of question.parts) {
      if (partIds.has(part.id))
        throw new CopyError(m.question_validation_quiz_part_ids());
      partIds.add(part.id);
    }
  }
  return questions;
}
