import { expect, it, vi } from 'vitest';
import { zodConfig } from './zodJitless';

const CHINESE = /[一-鿿]/;

const message = async () => {
  const { z } = await import('zod');
  return z.string().safeParse(1).error?.issues[0]?.message;
};

// Q908: main.tsx loads zod's Chinese messages apart from zod, so they may land
// before zod loads or after. Its own file, so zod is not loaded yet here.
it('keeps a locale set before zod loads', async () => {
  const { default: zhCN } = await import('zod/v4/locales/zh-CN.js');
  Object.assign(zodConfig, zhCN());
  expect(await message()).toMatch(CHINESE);
});

it('takes a locale set after zod loaded', async () => {
  vi.resetModules();
  delete zodConfig.localeError;
  expect(await message()).not.toMatch(CHINESE);
  const { default: zhCN } = await import('zod/v4/locales/zh-CN.js');
  Object.assign(zodConfig, zhCN());
  expect(await message()).toMatch(CHINESE);
});
