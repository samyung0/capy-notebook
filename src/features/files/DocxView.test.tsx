import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ViewableFile } from '@/api/types';
import DocxView from './DocxView';
import { FileHeaderTarget } from './fileModeContext';
import { useOfficeRuntime } from './useOfficeRuntime';

vi.mock('./useOfficeRuntime', () => ({ useOfficeRuntime: vi.fn() }));
// It portals into the header target, which the server renderer cannot do.
vi.mock('./FileModeControl', () => ({ FileModeControl: () => null }));

type Runtime = ReturnType<typeof useOfficeRuntime>;

const HEADER_ROW = /<div class="([^"]*)"><span class="t-meta/;

/** The classes of the header row, the div around the page-count label. */
function headerRow(markup: string) {
  const row = HEADER_ROW.exec(markup);
  if (!row) throw new Error('no header row');
  return row[1].split(' ');
}

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
      <DocxView canEdit file={{ id: 'f', name: 'plan.docx' } as ViewableFile} />
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

  it("gives its row to the editor's toolbar while editing under a file header", () => {
    const target = {} as HTMLElement;
    const analysis = { format: 'docx', pageCount: 15 } as const;
    expect(headerRow(render({ analysis, ready: true }, target))).not.toContain(
      'hidden'
    );
    expect(headerRow(render({ mode: 'edit', ready: true }, target))).toContain(
      'hidden'
    );
    // Without a header the row keeps the mode control.
    expect(headerRow(render({ mode: 'edit', ready: true }))).not.toContain(
      'hidden'
    );
  });

  it('asks for a reload when the Office runtime speaks another protocol version', () => {
    const markup = render({ unavailable: 'outdated' });
    expect(markup).toContain('An update is ready');
    expect(markup).toContain('Reload');
    expect(markup).not.toContain('<iframe');
  });
});
