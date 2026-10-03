import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { ViewableFile } from '@/api/types';
import { FileHeaderTarget } from './fileModeContext';
import SheetView from './SheetView';
import { useOfficeRuntime } from './useOfficeRuntime';

vi.mock('./useOfficeRuntime', () => ({ useOfficeRuntime: vi.fn() }));
// It portals into the header target, which the server renderer cannot do.
vi.mock('./FileModeControl', () => ({ FileModeControl: () => null }));

type Runtime = ReturnType<typeof useOfficeRuntime>;

// The row OfficeHeader draws when there is no file header to portal into.
const MODE_ROW =
  '<div class="flex min-h-10 items-center gap-2 border-line border-b px-2">';

function render(runtime: Partial<Runtime>, headerTarget: HTMLElement | null) {
  vi.mocked(useOfficeRuntime).mockReturnValue({
    analysis: { format: 'xlsx', sheetCount: 3 },
    iframeKey: 'f:0',
    iframeRef: { current: null },
    mode: 'view',
    ready: true,
    status: 'saved',
    ...runtime,
  } as Runtime);
  return renderToStaticMarkup(
    <FileHeaderTarget.Provider value={headerTarget}>
      <SheetView
        canEdit
        file={{ id: 'f', name: 'plan.xlsx' } as ViewableFile}
      />
    </FileHeaderTarget.Provider>
  );
}

it('draws no count row: the grid starts under the file header in both modes', () => {
  const target = {} as HTMLElement;
  for (const markup of [render({}, target), render({ mode: 'edit' }, target)]) {
    expect(markup).not.toContain(MODE_ROW);
    expect(markup).not.toContain('3 sheets');
  }
  // Without a header the mode control keeps a row of its own.
  expect(render({}, null)).toContain(MODE_ROW);
});
