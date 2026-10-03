import { z } from 'zod';
import * as limits from './questionLimits.generated.js';

const letterStart = /^[A-Za-z]/;
const svgStart = /^\s*<svg[\s>]/;
const svgEnd = /<\/svg>\s*$/;
const unsafeSvg =
  /<!|<\?|\bon\w+\s*=|javascript:|data:|<\s*\/?\s*(?:script|foreignObject|style|image|use|a|animate\w*|set)\b/i;
const svgReferences =
  /(?:[a-z]+:)?(?:href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const svgLocalReference = /^["']#[A-Za-z0-9_-]+["']$/;
const svgUrls = /url\s*\([^)]*\)/gi;
const svgLocalUrl = /^url\s*\(\s*["']?#[A-Za-z0-9_-]+["']?\s*\)$/i;
const svgEscapedStyle = /style\s*=\s*(?:"[^"<>]*\\|'[^'<>]*\\)/i;
const trailingSlash = /\/$/;

// Keep in sync with src/features/questions/validation.ts and Go questions; shared fixtures exercise all three.

export type QuestionPolicy = {
  bank?: boolean;
  bankAssetsUrl?: string;
  snapshot?: boolean;
};
const text = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => [...value].length <= limits.QUESTION_TEXT_MAX,
    'Text is too long.'
  );
const identifier = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, 'An ID is required.')
  .refine(
    (value) => [...value].length <= limits.QUESTION_ID_MAX,
    'Text is too long.'
  );
const meta = z.string().max(1000);
const finite = z.number().finite();
const index = z.number().int().nonnegative();
const coords = z.tuple([finite, finite]);
const list = z.array(text).min(1).max(limits.QUESTION_ANSWERS_MAX);
const imageSize = {
  height: z.number().int().min(1).max(limits.QUESTION_IMAGE_DIMENSION_MAX),
  width: z.number().int().min(1).max(limits.QUESTION_IMAGE_DIMENSION_MAX),
};
const style = { dash: z.boolean().optional(), hidden: z.boolean().optional() };
const GAP_MARKER = /\((\d+)\) ?_{3,}/g;

/** Values only. A quantity's unit belongs to the question, never to its answer. */
export const quantityValuePattern =
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:\s*\/\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)?$/;

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

export function validGraphTerm(term: string): boolean {
  if (!term || term.length > limits.QUESTION_GRAPH_TERM_MAX) return false;
  const tokens = term.match(
    /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z]+|[+\-*/^(),]/g
  );
  if (!tokens || tokens.join('') !== term.replace(/\s/g, '')) return false;
  const names = new Set([
    'x',
    'pi',
    'e',
    'sin',
    'cos',
    'tan',
    'asin',
    'acos',
    'atan',
    'sqrt',
    'abs',
    'exp',
    'log',
    'ln',
    'floor',
    'ceil',
    'pow',
    'min',
    'max',
  ]);
  return tokens.every((token) => !letterStart.test(token) || names.has(token));
}

export function validGraphSvg(svg: string): boolean {
  if (
    new TextEncoder().encode(svg).length > limits.QUESTION_SVG_BYTES_MAX ||
    !svgStart.test(svg) ||
    !svgEnd.test(svg)
  )
    return false;
  // SVG is rendered as an image; reject active content and external resources at storage too.
  if (unsafeSvg.test(svg) || svgEscapedStyle.test(svg)) return false;
  for (const match of svg.matchAll(svgReferences))
    if (!svgLocalReference.test(match[1])) return false;
  for (const match of svg.matchAll(svgUrls))
    if (!svgLocalUrl.test(match[0])) return false;
  const allowed = new Set([
    'svg',
    'g',
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    'text',
    'tspan',
    'defs',
    'marker',
    'clipPath',
    'title',
    'desc',
  ]);
  return [...svg.matchAll(/<\/?([A-Za-z][\w:-]*)\b/g)].every((match) =>
    allowed.has(match[1])
  );
}

const graphElement = z.discriminatedUnion('type', [
  z.strictObject({
    domain: coords.optional(),
    id: identifier,
    term: z
      .string()
      .refine(validGraphTerm, 'Use a supported mathematical expression.'),
    type: z.literal('functiongraph'),
    ...style,
  }),
  z.strictObject({
    coords,
    hidden: z.boolean().optional(),
    id: identifier,
    name: meta.optional(),
    type: z.literal('point'),
  }),
  z.strictObject({
    id: identifier,
    points: z.tuple([identifier, identifier]),
    type: z.literal('line'),
    ...style,
  }),
  z.strictObject({
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
    text,
    type: z.literal('text'),
  }),
  z.strictObject({
    hidden: z.boolean().optional(),
    id: identifier,
    label: meta.optional(),
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
]);

export const questionBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({ label: meta.optional(), text, type: z.literal('text') }),
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
                  (value) => [...value].length <= limits.QUESTION_TEXT_MAX,
                  'Text is too long.'
                )
            )
            .min(1)
            .max(limits.QUESTION_TABLE_COLUMNS_MAX)
        )
        .min(1)
        .max(limits.QUESTION_TABLE_ROWS_MAX),
      type: z.literal('table'),
    })
    .refine(
      (v) => v.rows.every((row) => row.length === v.rows[0].length),
      'Table rows must have the same number of cells.'
    ),
  z
    .strictObject({
      gridlines: z.enum(['normal', 'fine']).optional(),
      kind: z.enum(['bar', 'hbar', 'line', 'area', 'pie', 'stacked']),
      labels: z.array(text).min(1).max(limits.QUESTION_CHART_LABELS_MAX),
      series: z
        .array(
          z.strictObject({
            name: meta,
            values: z
              .array(finite)
              .min(1)
              .max(limits.QUESTION_CHART_LABELS_MAX),
          })
        )
        .min(1)
        .max(limits.QUESTION_CHART_SERIES_MAX),
      title: meta,
      type: z.literal('chart'),
      unit: meta.optional(),
      xTitle: meta.optional(),
      yTitle: meta.optional(),
    })
    .superRefine((v, ctx) => {
      if (v.series.some((s) => s.values.length !== v.labels.length))
        ctx.addIssue({
          code: 'custom',
          message: 'Each series needs a value for every label.',
        });
      if (
        ['pie', 'stacked'].includes(v.kind) &&
        (v.series.length !== 1 ||
          v.series[0].values.some((n) => n < 0) ||
          !v.series[0].values.some((n) => n > 0))
      )
        ctx.addIssue({
          code: 'custom',
          message:
            'Pie and stacked charts need one nonnegative series with a positive total.',
        });
    }),
  z.strictObject({
    image: z.union([
      z.strictObject({ url: z.url().max(limits.QUESTION_ASSET_URL_MAX) }),
      z.strictObject({ assetId: identifier }),
    ]),
    type: z.literal('image'),
    ...imageSize,
    attribution: meta.optional(),
    description: text,
  }),
  z
    .strictObject({
      board: z.strictObject({
        axis: z.boolean(),
        bbox: z.tuple([finite, finite, finite, finite]),
        grid: z.boolean(),
      }),
      elements: z.array(graphElement).max(limits.QUESTION_GRAPH_ELEMENTS_MAX),
      image: z.union([
        z.strictObject({ url: z.url().max(limits.QUESTION_ASSET_URL_MAX) }),
        z.strictObject({
          svg: z
            .string()
            .refine(validGraphSvg, 'Graph SVG contains unsupported content.'),
        }),
      ]),
      type: z.literal('graph'),
      ...imageSize,
      attribution: meta.optional(),
      description: text,
    })
    .superRefine((v, ctx) => {
      const [left, top, right, bottom] = v.board.bbox;
      if (left >= right || bottom >= top)
        ctx.addIssue({
          code: 'custom',
          message: 'Graph bounds must have positive width and height.',
        });
      const ids = new Set<string>();
      const points = new Set(
        v.elements.filter((e) => e.type === 'point').map((e) => e.id)
      );
      for (const element of v.elements) {
        if (ids.has(element.id))
          ctx.addIssue({
            code: 'custom',
            message: 'Graph element IDs must be unique.',
          });
        ids.add(element.id);
        if (
          'points' in element &&
          (element.points.some((id) => !points.has(id)) ||
            new Set(element.points).size !== element.points.length)
        )
          ctx.addIssue({
            code: 'custom',
            message: 'Lines must refer to existing points.',
          });
        if (
          'center' in element &&
          (!points.has(element.center) ||
            ('points' in element && element.points.includes(element.center)))
        )
          ctx.addIssue({
            code: 'custom',
            message: 'Circle centers must refer to existing points.',
          });
        if (
          element.type === 'functiongraph' &&
          element.domain &&
          element.domain[0] >= element.domain[1]
        )
          ctx.addIssue({
            code: 'custom',
            message: 'Function domain must be increasing.',
          });
      }
    }),
]);

const answerSchema = z.discriminatedUnion('type', [
  z
    .strictObject({
      correct: z.array(index).min(1).max(limits.QUESTION_ANSWERS_MAX),
      options: list.min(2),
      type: z.enum(['mcq', 'multi']),
    })
    .superRefine((v, ctx) => {
      if (
        new Set(v.correct).size !== v.correct.length ||
        v.correct.some((n) => n >= v.options.length) ||
        (v.type === 'mcq' && v.correct.length !== 1)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Choose valid, distinct correct options.',
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
        .refine(
          (value) => [...value].length <= limits.QUESTION_UNIT_MAX,
          'Text is too long.'
        )
        .optional(),
    })
    .refine(
      (v) => !v.unit || v.accepted.every((a) => validQuantityValue(a)),
      'Accepted answers must contain values only, in the required unit.'
    ),
  z
    .strictObject({
      options: list,
      pairs: z
        .array(z.strictObject({ left: text, right: index }))
        .min(1)
        .max(limits.QUESTION_ANSWERS_MAX),
      type: z.literal('matching'),
    })
    .refine(
      (v) => v.pairs.every((p) => p.right < v.options.length),
      'Every pair needs a choice from the pool.'
    ),
  z.strictObject({ items: list.min(2), type: z.literal('ordering') }),
  // One accepted list per numbered gap in the part's text.
  z.strictObject({
    accepted: z.array(list).min(1).max(limits.QUESTION_ANSWERS_MAX),
    type: z.literal('gaps'),
  }),
  z.strictObject({
    accepted: list,
    hints: z.array(text).max(limits.QUESTION_ANSWERS_MAX),
    type: z.literal('open'),
  }),
]);

export const questionSchema = z.strictObject({
  id: identifier,
  labels: z.enum(['letters', 'numbers']),
  layout: z.enum(['paper', 'split']),
  level: z.enum(['recall', 'application', 'analysis']).optional(),
  parts: z
    .array(
      z.strictObject({
        answer: answerSchema,
        awarded: finite.nonnegative().optional(),
        blocks: z
          .array(questionBlockSchema)
          .min(1)
          .max(limits.QUESTION_BLOCKS_MAX),
        id: identifier,
        itemAwards: z.array(finite).optional(),
        marks: z.number().int().min(1).max(limits.QUESTION_MARKS_MAX),
        markscheme: z
          .array(
            z.strictObject({
              marks: z.number().int().min(1),
              text: z.string().trim().min(1).max(limits.QUESTION_MARK_ITEM_MAX),
            })
          )
          .min(1)
          .max(limits.QUESTION_MARKSCHEME_MAX)
          .optional(),
        solution: z.array(questionBlockSchema).max(limits.QUESTION_BLOCKS_MAX),
      })
    )
    .min(1)
    .max(limits.QUESTION_PARTS_MAX),
  stem: z.array(questionBlockSchema).max(limits.QUESTION_BLOCKS_MAX),
});

function hostedAsset(value: string, base?: string): boolean {
  if (!base) return false;
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

export function validateQuestion(value: unknown, policy: QuestionPolicy = {}) {
  const question = questionSchema.parse(value);
  const ids = new Set<string>();
  for (const part of question.parts) {
    if (ids.has(part.id)) throw new Error('Part IDs must be unique.');
    ids.add(part.id);
    if (
      !policy.snapshot &&
      (part.awarded !== undefined || part.itemAwards !== undefined)
    )
      throw new Error('Authored questions cannot contain awarded marks.');
    // Each accepted list belongs to one blank, "(1) ______", numbered 1 to n.
    if (part.answer.type === 'gaps') {
      const numbers = part.blocks.flatMap((block) =>
        block.type === 'text'
          ? [...block.text.matchAll(GAP_MARKER)].map((match) =>
              Number(match[1])
            )
          : []
      );
      if (numbers.join() !== part.answer.accepted.map((_, i) => i + 1).join())
        throw new Error(
          'Write each gap in the text as (1) ______, (2) ______ and so on, one per accepted list.'
        );
    }
    // Only open parts have a marking scheme, which Jev grades against.
    if ((part.answer.type === 'open') !== (part.markscheme !== undefined))
      throw new Error(
        'Open answers need a marking scheme, and only open answers have one.'
      );
    const marks = part.markscheme?.map((item) => item.marks) ?? [];
    if (part.markscheme && marks.reduce((sum, n) => sum + n, 0) !== part.marks)
      throw new Error("The marking items must add up to the part's marks.");
    if (
      part.awarded !== undefined &&
      (part.awarded > part.marks || (part.awarded * 2) % 1 !== 0)
    )
      throw new Error('Awarded marks exceed the part or are not half marks.');
    if (
      part.itemAwards !== undefined &&
      (!part.markscheme ||
        part.itemAwards.length !== marks.length ||
        part.itemAwards.some(
          (award, i) =>
            award !== 0 && award !== marks[i] / 2 && award !== marks[i]
        ) ||
        part.itemAwards.reduce((sum, award) => sum + award, 0) !== part.awarded)
    )
      throw new Error(
        "Item awards must give none, half or all of each marking item's marks."
      );
    if (policy.bank && part.solution.length === 0)
      throw new Error('Bank questions need a worked solution for every part.');
    if (
      !policy.bank &&
      part.markscheme &&
      part.markscheme.length > limits.QUIZ_MARKSCHEME_MAX
    )
      throw new Error(
        `A part has at most ${limits.QUIZ_MARKSCHEME_MAX} marking items.`
      );
    if (
      !policy.bank &&
      part.answer.type === 'open' &&
      part.answer.accepted.some(
        (text) => [...text].length > limits.QUIZ_OPEN_ANSWER_MAX
      )
    )
      throw new Error(
        `Sample answers are limited to ${limits.QUIZ_OPEN_ANSWER_MAX} characters.`
      );
  }
  if (!policy.bank && question.parts.length > limits.QUIZ_QUESTION_PARTS_MAX)
    throw new Error(
      `A question has at most ${limits.QUIZ_QUESTION_PARTS_MAX} parts.`
    );
  for (const block of [
    ...question.stem,
    ...question.parts.flatMap((p) => [...p.blocks, ...p.solution]),
  ]) {
    if (block.type !== 'image' && block.type !== 'graph') continue;
    // Bank figures must be hosted bank assets; quiz figures must be editor assets.
    if (
      'url' in block.image
        ? !policy.bank || !hostedAsset(block.image.url, policy.bankAssetsUrl)
        : 'assetId' in block.image && policy.bank
    )
      throw new Error('Figures must use the configured bank asset host.');
    if (policy.bank && block.type === 'graph' && 'svg' in block.image)
      throw new Error('Upload bank graphs before saving the question.');
  }
  return question;
}

/** One attempt's open parts must fit a single grading request. */
export function assertQuizBounds(
  questions: { parts: { answer: { type: unknown } }[] }[]
) {
  const parts = questions.flatMap((question) => question.parts);
  if (parts.length > limits.QUIZ_PARTS_MAX)
    throw new Error(`A quiz has at most ${limits.QUIZ_PARTS_MAX} parts.`);
  if (
    parts.filter((part) => part.answer.type === 'open').length >
    limits.QUIZ_OPEN_PARTS_MAX
  )
    throw new Error(
      `A quiz has at most ${limits.QUIZ_OPEN_PARTS_MAX} open parts.`
    );
}

export function validateQuestions(value: unknown, policy: QuestionPolicy = {}) {
  const questions = z
    .array(z.unknown())
    .max(policy.bank ? limits.QUESTION_COUNT_MAX : limits.QUIZ_PARTS_MAX)
    .parse(value)
    .map((q) => validateQuestion(q, policy));
  if (!policy.bank) assertQuizBounds(questions);
  const ids = new Set<string>();
  const partIds = new Set<string>();
  for (const question of questions) {
    if (ids.has(question.id)) throw new Error('Question IDs must be unique.');
    ids.add(question.id);
    for (const part of question.parts) {
      if (partIds.has(part.id))
        throw new Error('Part IDs must be unique throughout the quiz.');
      partIds.add(part.id);
    }
  }
  return questions;
}
