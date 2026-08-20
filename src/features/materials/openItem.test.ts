import { describe, expect, it } from 'vitest';
import { parseWorkspaceOpenSearch, searchFromOpenItem } from './openItem';

describe('parseWorkspaceOpenSearch', () => {
  it('keeps an explicit material mode from the URL', () => {
    expect(
      parseWorkspaceOpenSearch({ material: 'mat_1', mode: 'view' })
    ).toEqual({ material: 'mat_1', mode: 'view' });
  });

  it('drops an invalid material mode', () => {
    expect(
      parseWorkspaceOpenSearch({ material: 'mat_1', mode: 'preview' })
    ).toEqual({ material: 'mat_1' });
  });

  it('does not attach mode to file links', () => {
    expect(parseWorkspaceOpenSearch({ file: 'f_1', mode: 'view' })).toEqual({
      file: 'f_1',
    });
  });
});

describe('searchFromOpenItem', () => {
  it('omits mode so in-workspace navigation uses the policy default', () => {
    expect(searchFromOpenItem({ id: 'mat_1', kind: 'material' })).toEqual({
      material: 'mat_1',
    });
  });
});
