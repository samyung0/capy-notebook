export type GradeAward = 0 | 0.5 | 1;

export type OpenGradeInput = {
  hints: string[];
  modelAnswer: string;
  prompt: string;
  rubrics: string[];
  userAnswer: string;
};

export type OpenGradeResult = {
  award: GradeAward;
  reason: string;
};

export const GRADE_SYSTEM =
  'You mark one student answer against a marking scheme. Reply with ONLY JSON: {"score":0|0.5|1,"reason":"one short sentence"}. No markdown.';

export function buildGradePrompt(input: OpenGradeInput): string {
  const hints = input.hints.filter((h) => h.trim());
  const rubrics = input.rubrics.filter((r) => r.trim());
  const lines = [
    `Question: ${input.prompt.trim()}`,
    '',
    hints.length
      ? `Hints:\n${hints.map((h) => `- ${h.trim()}`).join('\n')}`
      : '',
    '',
    rubrics.length
      ? `Marking scheme:\n${rubrics.map((r) => `- ${r.trim()}`).join('\n')}`
      : 'Marking scheme: (none given — use the model answer)',
    '',
    `Model answer: ${input.modelAnswer.trim() || '(none)'}`,
    `Student answer: ${input.userAnswer.trim() || '(empty)'}`,
    '',
    'score 1 if the marking scheme is met, 0.5 if partly met, 0 if not. Do not reward wording that misses the rubrics.',
  ];
  return lines
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n');
}

function snapAward(n: number): GradeAward {
  if (n >= 0.75) return 1;
  if (n >= 0.25) return 0.5;
  return 0;
}

/** Pull {"score", "reason"} out of model text that may wrap it in prose. */
export function parseGradeResponse(text: string): OpenGradeResult {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { award: 0, reason: 'The judge did not return a score.' };
  }
  try {
    const raw = JSON.parse(trimmed.slice(start, end + 1)) as {
      score?: unknown;
      reason?: unknown;
    };
    const score = typeof raw.score === 'number' ? raw.score : Number(raw.score);
    if (!Number.isFinite(score)) {
      return { award: 0, reason: 'The judge did not return a score.' };
    }
    const reason =
      typeof raw.reason === 'string' && raw.reason.trim()
        ? raw.reason.trim()
        : '';
    return { award: snapAward(score), reason };
  } catch {
    return { award: 0, reason: 'The judge did not return a score.' };
  }
}

export async function gradeOpenAnswer(
  input: OpenGradeInput,
  complete: (prompt: string) => Promise<string>
): Promise<OpenGradeResult> {
  if (!input.userAnswer.trim()) {
    return { award: 0, reason: '' };
  }
  return parseGradeResponse(await complete(buildGradePrompt(input)));
}
