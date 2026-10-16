import { expect, it, vi } from 'vitest';
import { changeLocale } from './LanguageRow';

it('applies the language only after the account saved it', async () => {
  const saves: (() => void)[] = [];
  const save = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        saves.push(resolve);
      })
  );
  const apply = vi.fn();

  const change = changeLocale('zh', save, apply);
  await Promise.resolve();
  expect(save).toHaveBeenCalledWith('zh');
  expect(apply).not.toHaveBeenCalled();

  saves[0]();
  await change;
  expect(apply).toHaveBeenCalledWith('zh');
});

it('keeps the current language when the save fails', async () => {
  const apply = vi.fn();
  await expect(
    changeLocale('zh', () => Promise.reject(new Error('500')), apply)
  ).rejects.toThrow('500');
  expect(apply).not.toHaveBeenCalled();
});
