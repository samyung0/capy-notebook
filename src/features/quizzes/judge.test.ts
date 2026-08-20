import { describe, expect, it } from 'vitest';
import { buildGradePrompt, gradeOpenAnswer, parseGradeResponse } from './judge';

const sample = {
  hints: ['Think about surface area'],
  modelAnswer: 'Cristae increase surface area for ATP synthesis.',
  prompt: 'Why is the inner membrane folded?',
  rubrics: ['Mentions folds or cristae', 'Links folds to ATP'],
  userAnswer: 'The folds give more space to make ATP.',
};

describe('quiz judge', () => {
  it('builds a prompt that includes the marking scheme and both answers', () => {
    const prompt = buildGradePrompt(sample);
    expect(prompt).toContain('Why is the inner membrane folded?');
    expect(prompt).toContain('Mentions folds or cristae');
    expect(prompt).toContain('The folds give more space to make ATP.');
    expect(prompt).toContain('Cristae increase surface area');
  });

  it('parses score 0, 0.5 and 1 from messy model text', () => {
    expect(parseGradeResponse('{"score":1,"reason":"all rubrics"}')).toEqual({
      award: 1,
      reason: 'all rubrics',
    });
    expect(
      parseGradeResponse('Here you go\n{"score":0.5,"reason":"partial"}\n')
    ).toEqual({ award: 0.5, reason: 'partial' });
    expect(parseGradeResponse('{"score":0}')).toEqual({
      award: 0,
      reason: '',
    });
    expect(parseGradeResponse('no json here')).toEqual({
      award: 0,
      reason: 'The judge did not return a score.',
    });
  });

  it('skips the model when the student left the answer blank', async () => {
    let called = false;
    const result = await gradeOpenAnswer(
      { ...sample, userAnswer: '   ' },
      async () => {
        called = true;
        return '{"score":1,"reason":"should not run"}';
      }
    );
    expect(called).toBe(false);
    expect(result.award).toBe(0);
  });

  it('grades through the complete adapter', async () => {
    const result = await gradeOpenAnswer(sample, async (prompt) => {
      expect(prompt).toContain('Marking scheme');
      return '{"score":0.5,"reason":"ATP yes, cristae missing"}';
    });
    expect(result).toEqual({
      award: 0.5,
      reason: 'ATP yes, cristae missing',
    });
  });
});
