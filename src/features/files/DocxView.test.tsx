import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SourceFile } from '@/api/types';
import { m } from '@/i18n';
import DocxView from './DocxView';
import { FileHeaderTarget } from './fileModeContext';
import { useOfficeRuntime } from './useOfficeRuntime';

vi.mock('./useOfficeRuntime', () => ({ useOfficeRuntime: vi.fn() }));
// It portals into the header target, which the server renderer cannot do.
vi.mock('./FileModeControl', () => ({ FileModeControl: () => null }));

type Runtime = ReturnType<typeof useOfficeRuntime>;

const HEADER_ROW = /<div class="([^"]*)"><span class="t-meta/;

function render(
  runtime: Partial<Runtime>,
  headerTarget: HTMLElement | null = null
) {
  vi.mocked(useOfficeRuntime).mockReturnValue({
    analysis: null,
    iframeKey: 'f:0',
    iframeRef: { current: null },
    mode: 'view',
    ready: false,
    status: 'saved',
    ...runtime,
  } as Runtime);
  return renderToStaticMarkup(
    <FileHeaderTarget.Provider value={headerTarget}>
      <DocxView canEdit file={{ id: 'f', name: 'plan.docx' } as SourceFile} />
    </FileHeaderTarget.Provider>
  );
}

describe('DocxView header', () => {
  it('stops saying the document is opening once the editor is ready', () => {
    expect(render({ mode: 'edit' })).toContain('Opening document…');
    expect(render({ mode: 'edit', ready: true })).not.toContain(
      'Opening document…'
    );
  });

  it('counts pages in view mode only', () => {
    const analysis = { format: 'docx', pageCount: 15 } as const;
    expect(render({ analysis, ready: true })).toContain('15 pages');
    expect(render({ analysis, mode: 'edit', ready: true })).not.toContain(
      '15 pages'
    );
  });

  it('leaves the mode control and menus to the file header in both modes', () => {
    const target = {} as HTMLElement;
    const analysis = { format: 'docx', pageCount: 15 } as const;
    expect(render({ analysis, ready: true }, target)).not.toMatch(HEADER_ROW);
    expect(render({ mode: 'edit', ready: true }, target)).not.toMatch(
      HEADER_ROW
    );
    // Without a file header a row of its own keeps the count and the toggle.
    expect(render({ analysis, ready: true })).toMatch(HEADER_ROW);
  });

  it('shows the error id when the view read fails', () => {
    const markup = render({ error: 'x', errorId: 'trace-1', mode: 'view' });
    expect(markup).toContain('trace-1');
    expect(markup).not.toContain('<iframe');
  });

  // A newer version swaps the view (FileViewer's OfficeSwap, Epo
  // 2026-10-22): the replaced view shows no banner or Reload; the
  // maintenance pause keeps its banner.
  it('shows no newer-version banner, only the maintenance one', () => {
    const replaced = render({ mode: 'edit', ready: true, replaced: true });
    expect(replaced).not.toContain(m.source_edit_replaced());
    expect(replaced).not.toContain(m.error_action_reload());
    expect(
      render({ mode: 'edit', paused: true, ready: true, replaced: true })
    ).toContain(m.source_edit_paused());
  });

  it('asks for a reload when the Office runtime speaks another protocol version', () => {
    const markup = render({ unavailable: 'outdated' });
    expect(markup).toContain('An update is ready');
    expect(markup).toContain('Reload');
    expect(markup).not.toContain('<iframe');
  });
});
