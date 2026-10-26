import { describe, expect, it, vi } from 'vitest';
import { parseQuizFenceBody } from '@/features/materials/blocks';
import {
  createMaterialDocument,
  quizElementToBlock,
  quizNode,
} from '@/features/materials/document';
import { quizFenceBody } from '@/features/notes/blocks/shared';
import { exampleQuestions } from '@/features/questions/questionFixtures';
import {
  createBlankQuestion,
  isCompleteQuestion,
  quizImageUpload,
} from './QuizForm';

const { uploadEditorAsset } = vi.hoisted(() => ({
  uploadEditorAsset: vi.fn(async () => ({ assetId: 'asset_1' })),
}));
vi.mock('@/api/editorAssets', () => ({ uploadEditorAsset }));

describe('shared question editing', () => {
  it('round-trips every answer through both document and markdown boundaries', () => {
    expect(exampleQuestions.every(isCompleteQuestion)).toBe(true);
    expect(isCompleteQuestion(createBlankQuestion())).toBe(false);
    const node = quizNode({ questions: exampleQuestions }, 'quiz');
    createMaterialDocument([node]);
    expect(quizElementToBlock(node).questions).toEqual(exampleQuestions);
    expect(
      parseQuizFenceBody(quizFenceBody({ questions: exampleQuestions }))
    ).toEqual({ questions: exampleQuestions });
    expect(parseQuizFenceBody('questions: []')).toEqual({ questions: [] });
    expect(() =>
      parseQuizFenceBody('questions: [{id: old, prompt: Old, type: short}]')
    ).toThrow();
  });
});

describe('quiz image uploads', () => {
  it('passes the editor signal to the upload, so closing it cancels a waiting ticket', async () => {
    const file = new File(['png'], 'figure.png', { type: 'image/png' });
    const controller = new AbortController();
    await expect(
      quizImageUpload('qz_1')(file, controller.signal)
    ).resolves.toEqual({ assetId: 'asset_1' });
    expect(uploadEditorAsset).toHaveBeenCalledWith('qz_1', file, 'image', {
      signal: controller.signal,
    });
  });
});
