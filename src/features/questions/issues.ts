import type { z } from 'zod';
import { QUESTION_MARKS_MAX } from '@/api/limits.generated';
import { m } from '@/i18n';
import {
  blockWithoutBlanks,
  type Question,
  type QuestionBlock,
  type QuestionPart,
  withoutBlanks,
} from './types';
import {
  type QuestionPolicy,
  questionBlockSchema,
  questionSchema,
  type RuleIssue,
  ruleIssues,
} from './validation';

/** The question dialog's outline row an issue points at. */
export type IssueRow =
  | {
      kind: 'block';
      location: { index: number; partId?: string; solution?: boolean };
    }
  | { kind: 'part' | 'solution'; partId: string };

/** One thing that keeps a question from being marked, in the dialog's words
 * (Epo 2026-10-15): `partId` names the part whose title shows it (none: the
 * question's title), `row` the outline row. */
export type QuestionIssue = {
  message: string;
  partId?: string;
  row?: IssueRow;
};

type Section = 'stem' | 'blocks' | 'solution';

/** A block's schema issue in the dialog's words; the generic line for rules
 * its editor cannot break. */
function blockMessage(
  block: QuestionBlock | undefined,
  issue: z.core.$ZodIssue
) {
  if (
    block?.type === 'chart' &&
    issue.message === m.question_validation_pie_series()
  )
    return m.question_issue_pie();
  if (block?.type === 'graph' && issue.code === 'custom')
    return m.question_issue_graph({ message: issue.message });
  return m.question_issue_generic();
}

/** A note's plot issue its editor can leave (an empty cell, a line of one
 * point); a quiz shows its plots uneditable, so there it is the generic line. */
function plotMessage(block: QuestionBlock, issue: z.core.$ZodIssue) {
  if (
    block.type === 'plot' &&
    (issue.message === m.question_validation_plot_number() ||
      issue.message === m.question_validation_plot_line_points())
  )
    return m.question_issue_plot({ message: issue.message });
}

/** A standalone block's issues (a note's chart, plot or graph), each listed
 * once. */
export function blockIssues(block: QuestionBlock): string[] {
  const normal = blockWithoutBlanks(block);
  const parsed = questionBlockSchema.safeParse(normal);
  if (parsed.success) return [];
  return [
    ...new Set(
      parsed.error.issues.map(
        (issue) => plotMessage(normal, issue) ?? blockMessage(normal, issue)
      )
    ),
  ];
}
const blank = (block: QuestionBlock) =>
  block.type === 'text' && !block.text.trim();
const letter = (index: number) => String.fromCharCode(65 + index);

/**
 * Every issue of the question as it is typed: `withoutBlanks` first, then the
 * schema's and the hand-written rules, each mapped to the agreed wording. An
 * answer issue names its part ("Part B") only when there are several; rules
 * the dialog cannot break (agent-only bounds, ids, image links) share the
 * generic line. Identical issues are listed once.
 */
export function questionIssues(
  question: Question,
  policy: QuestionPolicy = {}
): QuestionIssue[] {
  const normal = withoutBlanks(question);
  const several = question.parts.length > 1;
  const generic = m.question_issue_generic();
  const parts = (index: unknown) =>
    typeof index === 'number' ? question.parts[index] : undefined;
  const label = (index: number) =>
    question.labels === 'letters' ? letter(index) : String(index + 1);
  // Blank text blocks are gone from `normal`: its block index i is the i-th
  // kept block of the typed section.
  const blockRow = (
    part: QuestionPart | undefined,
    section: Section,
    index: number
  ): IssueRow | undefined => {
    const blocks = section === 'stem' ? question.stem : (part?.[section] ?? []);
    const kept = blocks.flatMap((block, i) => (blank(block) ? [] : [i]));
    const at = kept[index];
    if (at === undefined) return;
    return {
      kind: 'block',
      location: {
        index: at,
        ...(part && { partId: part.id }),
        ...(section === 'solution' && { solution: true }),
      },
    };
  };
  const issues: QuestionIssue[] = [];
  const add = (issue: QuestionIssue) => issues.push(issue);
  const answerIssue = (part: QuestionPart, index: number, message: string) =>
    add({
      message: several
        ? m.question_issue_part({ label: label(index), message })
        : message,
      partId: part.id,
      row: { kind: 'part', partId: part.id },
    });
  const blockIssue = (
    part: QuestionPart | undefined,
    section: Section,
    index: number,
    issue: z.core.$ZodIssue
  ) => {
    const block =
      section === 'stem'
        ? normal.stem[index]
        : normal.parts.find((item) => item.id === part?.id)?.[section][index];
    const message = blockMessage(block, issue);
    add({
      message,
      partId: message === generic ? undefined : part?.id,
      row: blockRow(part, section, index),
    });
  };

  const parsed = questionSchema.safeParse(normal);
  for (const issue of parsed.success ? [] : parsed.error.issues) {
    const [head, at, field, ...rest] = issue.path;
    if (head === 'stem' && typeof at === 'number') {
      blockIssue(undefined, 'stem', at, issue);
      continue;
    }
    const part = head === 'parts' ? parts(at) : undefined;
    if (!part || typeof at !== 'number') {
      add({ message: generic });
      continue;
    }
    if (field === 'blocks' || field === 'solution') {
      const [index] = rest;
      if (typeof index === 'number') blockIssue(part, field, index, issue);
      else if (field === 'blocks' && issue.code === 'too_small')
        add({
          // A part needs a block with content (Epo 2026-10-14).
          message: several
            ? m.question_issue_text_part({ label: label(at) })
            : m.question_issue_text_question(),
          partId: part.id,
          row: part.blocks.length
            ? { kind: 'block', location: { index: 0, partId: part.id } }
            : { kind: 'part', partId: part.id },
        });
      else add({ message: generic, row: { kind: 'part', partId: part.id } });
      continue;
    }
    // An open part's marks are its items' total: no item, nothing to grade.
    const noScheme =
      issue.code === 'too_small' &&
      (field === 'markscheme'
        ? rest.length === 0
        : field === 'marks' &&
          part.answer.type === 'open' &&
          !normal.parts[at].markscheme?.length);
    const message =
      field === 'answer'
        ? answerMessage(part, rest, issue)
        : noScheme
          ? m.question_issue_open_scheme()
          : undefined;
    if (message) answerIssue(part, at, message);
    else add({ message: generic, row: { kind: 'part', partId: part.id } });
  }

  for (const rule of ruleIssues(normal, policy)) {
    const part = parts(rule.part);
    if (!part || rule.part === undefined) {
      add({ message: generic });
      continue;
    }
    const message = ruleMessage(rule, normal.parts[rule.part]);
    if (rule.rule === 'bank-solution')
      add({
        message: m.question_validation_bank_solution(),
        partId: part.id,
        row: { kind: 'solution', partId: part.id },
      });
    else if (message) answerIssue(part, rule.part, message);
    else
      add({
        message: generic,
        row: rule.block
          ? blockRow(part, rule.block.section, rule.block.index)
          : { kind: 'part', partId: part.id },
      });
  }
  // In reading order: the stem, then each part's text, answer and solution.
  const place = ({ row }: QuestionIssue) => {
    if (!row) return -1;
    const id = row.kind === 'block' ? row.location.partId : row.partId;
    const part = question.parts.findIndex((item) => item.id === id);
    const section =
      row.kind === 'block'
        ? row.location.solution
          ? 2
          : 0
        : row.kind === 'part'
          ? 1
          : 2;
    return id === undefined ? -1 : part * 3 + section;
  };
  const seen = new Set<string>();
  return issues
    .filter((issue) => {
      const key = JSON.stringify([issue.message, issue.partId, issue.row]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => place(a) - place(b));
}

/** An answer's schema issue in the agreed wording; undefined for one the
 * dialog's inputs keep from happening (the generic line). `path` is below
 * the answer. */
function answerMessage(
  part: QuestionPart,
  path: PropertyKey[],
  issue: z.core.$ZodIssue
): string | undefined {
  const [field, index, inner] = path;
  const tooSmall = issue.code === 'too_small';
  switch (part.answer.type) {
    case 'mcq':
      if (field === 'options' && index === undefined && tooSmall)
        return m.question_issue_mcq_options();
      if (field === 'options' && typeof index === 'number' && tooSmall)
        return m.question_issue_mcq_option_empty({ letter: letter(index) });
      if (field === 'correct' && index === undefined && tooSmall)
        return m.question_issue_mcq_correct();
      return;
    case 'short':
      if (field === 'accepted' && index === undefined && tooSmall)
        return m.question_issue_short_accepted();
      if (
        field === undefined &&
        issue.message === m.question_validation_unit_answers()
      )
        return m.question_issue_short_unit();
      return;
    case 'matching':
      if (field === 'options' && tooSmall)
        return m.question_issue_matching_option();
      if (field === 'pairs' && (index === undefined || inner === 'left'))
        return tooSmall ? m.question_issue_matching_item() : undefined;
      // A pair whose choice was removed points at none (-1).
      if (
        (field === 'pairs' && inner === 'right') ||
        (field === undefined &&
          issue.message === m.question_validation_matching_pairs())
      )
        return m.question_issue_matching_pair();
      return;
    case 'ordering':
      if (field === 'items' && index === undefined && tooSmall)
        return m.question_issue_ordering_items();
      if (field === 'items' && typeof index === 'number' && tooSmall)
        return m.question_issue_ordering_item_empty();
      return;
    case 'gaps':
      if (field === 'accepted' && index === undefined && tooSmall)
        return m.question_issue_blanks_order();
      if (
        field === 'accepted' &&
        typeof index === 'number' &&
        inner === undefined &&
        tooSmall
      )
        return m.question_issue_blank_answer();
      return;
    default:
      return;
  }
}

/** A hand-written rule's agreed wording, for the rules a user can break. */
function ruleMessage(rule: RuleIssue, part: QuestionPart): string | undefined {
  if (rule.rule === 'gap-markers') return m.question_issue_blanks_order();
  // Items past the cap: the part's marks stop at it (`schemeMarks`).
  if (
    rule.rule === 'markscheme-total' &&
    (part.markscheme ?? []).reduce((sum, item) => sum + item.marks, 0) >
      QUESTION_MARKS_MAX
  )
    return m.question_issue_open_total({ max: QUESTION_MARKS_MAX });
}

/** The issues' messages, each once, in order. */
export function issueMessages(issues: QuestionIssue[]): string[] {
  return [...new Set(issues.map((issue) => issue.message))];
}
