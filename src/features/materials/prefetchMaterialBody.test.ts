import { QueryClient } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { MATERIAL_RENDER_WARNING } from '@/lib/const';

const get = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', async (original) => ({
  ...(await original<typeof import('@/api/client')>()),
  api: { get },
}));

import { prefetchMaterialBody } from './prefetchMaterialBody';

const LIST = [
  { id: 'm_light', nodeCount: 10, sizeBytes: 1000 },
  {
    id: 'm_heavy',
    nodeCount: 10,
    sizeBytes: MATERIAL_RENDER_WARNING.contentBytes + 1,
  },
];

it('starts a light material body once its list arrives, never a heavy one', async () => {
  get.mockImplementation(async (path: string) =>
    path.endsWith('/materials') ? LIST : { id: path }
  );
  const qc = new QueryClient();
  prefetchMaterialBody(qc, 'ws_1', 'm_light');
  prefetchMaterialBody(qc, 'ws_1', 'm_heavy');
  await vi.waitFor(() =>
    expect(get).toHaveBeenCalledWith('/materials/m_light')
  );
  expect(get).toHaveBeenCalledTimes(2);
  expect(get).toHaveBeenCalledWith('/workspaces/ws_1/materials');
});
