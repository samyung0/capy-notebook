import {
  type A11yGrid,
  analyzeOpenWorkbook,
  buildA11yGrid,
  cellAtPoint,
  cellRect,
  type DisplayList,
  initWasm,
  openWorkbook,
  paintDisplayList,
  rangeRect,
  type WorkbookAnalysis,
  type WorkbookViewerHandle,
  zoomedViewport,
} from '@betteroffice/xlsx/viewer';
import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type {
  OfficeCitation,
  OfficeLocale,
} from '@/features/files/officeProtocol';
import { m } from '@/i18n';
import { CITATION_FILL } from './citations';
import type { OfficeMenuReporter, OfficeRenderer } from './runtimeMenus';
import { type CellCitation, xlsxCitation } from './xlsxCitation';
import { xlsxViewMenus } from './xlsxMenus';
import { sheetPages, viewportPage } from './xlsxRender';
import './xlsx-runtime.css';

interface Cell {
  col: number;
  row: number;
}

/** The selected cell, widened to the merged range it belongs to. */
interface SheetSelection {
  cell: Cell;
  range: { bottom: number; left: number; right: number; top: number } | null;
}

const ORIGIN: SheetSelection = { cell: { col: 0, row: 0 }, range: null };
// The editor's selection colours: the outline stays Excel green.
const SELECTION_STROKE = '#217346';
const SELECTION_FILL = 'rgba(33, 115, 70, 0.12)';

export function XlsxViewer({
  bytes,
  citation,
  initialZoom = 1,
  locale,
  onAnalysis,
  onError,
  onMenus,
  onRenderer,
  onZoomChange,
}: {
  bytes: Uint8Array;
  citation: OfficeCitation | null;
  /** 1 = 100%, the level the file was last shown at. */
  initialZoom?: number;
  locale: OfficeLocale;
  onAnalysis: (analysis: WorkbookAnalysis) => void;
  onError: (error: Error) => void;
  onMenus: OfficeMenuReporter;
  onRenderer: (renderer: OfficeRenderer | null) => void;
  onZoomChange: (zoom: number) => void;
}) {
  const highlightRef = useRef<CellCitation | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<WorkbookViewerHandle | null>(null);
  const rafRef = useRef<number | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const sheetNamesRef = useRef<string[]>([]);
  const activeSheetRef = useRef(0);
  const a11yWindowKeyRef = useRef('');
  const frameRef = useRef<DisplayList | null>(null);
  const selectionRef = useRef<SheetSelection>(ORIGIN);
  // The open workbook's analysis, reported with the first painted grid.
  const pendingAnalysisRef = useRef<WorkbookAnalysis | null>(null);
  const tabsId = useId();
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [a11yGrid, setA11yGrid] = useState<A11yGrid | null>(null);
  const [extent, setExtent] = useState({ height: 0, width: 0 });
  // The read-only formula bar: the selected cell's address and full text.
  const [formula, setFormula] = useState({ address: '', text: '' });
  // View › Zoom (1 = 100%); the host carries it to the next frame.
  const [zoom, setZoom] = useState(initialZoom);
  const zoomRef = useRef(zoom);
  useEffect(() => onZoomChange(zoom), [onZoomChange, zoom]);
  // The sheet point at the grid's top-left when the zoom changed: it stays
  // there, as in Google Sheets.
  const zoomAnchorRef = useRef<{ x: number; y: number } | null>(null);
  // The opened sheet's saved scroll (its frozen pane's top-left cell), in
  // sheet pixels: applied once the scroll area has that sheet's size, as the
  // editor does, or the old sheet's size would cut it short.
  const sheetScrollRef = useRef<{ x: number; y: number } | null>(null);

  const select = useCallback((handle: WorkbookViewerHandle, cell: Cell) => {
    const sheet = activeSheetRef.current;
    const selection = selectionOf(handle, sheet, cell);
    selectionRef.current = selection;
    a11yWindowKeyRef.current = '';
    setFormula({
      address: cellAddress(selection.cell),
      text: handle.cellText(sheet, selection.cell.row, selection.cell.col),
    });
  }, []);

  const paint = useCallback(() => {
    const scroll = scrollRef.current;
    const canvas = canvasRef.current;
    const handle = handleRef.current;
    if (!scroll || !canvas || !handle) return;
    const width = scroll.clientWidth;
    const height = scroll.clientHeight;
    if (width === 0 || height === 0) return;
    const zoom = zoomRef.current;
    try {
      const frame = handle.displayList(zoomedViewport(scroll, zoom));
      frameRef.current = frame;
      const selection = selectionRef.current;
      const sheetName = sheetNamesRef.current[activeSheetRef.current] ?? '';
      const windowKey = visibleGridWindowKey(
        frame,
        activeSheetRef.current,
        sheetName
      );
      if (windowKey !== a11yWindowKeyRef.current) {
        a11yWindowKeyRef.current = windowKey;
        setA11yGrid(
          buildA11yGrid(
            frame,
            { anchor: selection.cell, focus: selection.cell },
            sheetName,
            spreadsheetA11yStrings()
          )
        );
      }
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const context = canvas.getContext('2d');
      if (context) {
        paintDisplayList(context, frame, dpr * zoom);
        const target = highlightRef.current;
        const rect =
          target?.sheet === activeSheetRef.current
            ? cellRect(frame.grid, target.row, target.col)
            : null;
        // Sheet pixels, as the frame; the outline stays 2 CSS px wide.
        context.save();
        context.setTransform(dpr * zoom, 0, 0, dpr * zoom, 0, 0);
        if (rect) {
          context.fillStyle = CITATION_FILL;
          context.fillRect(rect.x, rect.y, rect.w, rect.h);
        }
        const selected = selection.range
          ? rangeRect(frame.grid, selection.range)
          : cellRect(frame.grid, selection.cell.row, selection.cell.col);
        if (selected) {
          context.fillStyle = SELECTION_FILL;
          context.fillRect(selected.x, selected.y, selected.w, selected.h);
          context.strokeStyle = SELECTION_STROKE;
          context.lineWidth = 2 / zoom;
          context.strokeRect(
            selected.x + 1 / zoom,
            selected.y + 1 / zoom,
            selected.w - 2 / zoom,
            selected.h - 2 / zoom
          );
        }
        context.restore();
        const analysis = pendingAnalysisRef.current;
        pendingAnalysisRef.current = null;
        if (analysis) onAnalysis(analysis);
      }
    } catch (value) {
      onError(toError(value));
    }
  }, [onAnalysis, onError]);

  useEffect(() => {
    let disposed = false;
    let handle: WorkbookViewerHandle | null = null;
    a11yWindowKeyRef.current = '';
    activeSheetRef.current = 0;
    sheetNamesRef.current = [];
    frameRef.current = null;
    selectionRef.current = ORIGIN;
    pendingAnalysisRef.current = null;
    setFormula({ address: '', text: '' });
    setA11yGrid(null);
    setActiveSheet(0);
    setExtent({ height: 0, width: 0 });
    setSheetNames([]);
    const context = canvasRef.current?.getContext('2d');
    if (context && canvasRef.current) {
      context.clearRect(
        0,
        0,
        canvasRef.current.width,
        canvasRef.current.height
      );
    }
    void initWasm().then(
      () => {
        if (disposed) return;
        try {
          handle = openWorkbook(bytes);
          handleRef.current = handle;
          const analysis = analyzeOpenWorkbook(handle);
          const info = handle.sheetInfo();
          sheetNamesRef.current = info.sheetNames;
          activeSheetRef.current = info.activeSheet;
          setSheetNames(info.sheetNames);
          setActiveSheet(info.activeSheet);
          setExtent({ height: info.contentHeight, width: info.contentWidth });
          sheetScrollRef.current = {
            x: info.initialScrollX,
            y: info.initialScrollY,
          };
          select(handle, ORIGIN.cell);
          pendingAnalysisRef.current = analysis;
          requestAnimationFrame(paint);
        } catch (value) {
          onError(toError(value));
        }
      },
      (value: unknown) => {
        if (!disposed) onError(toError(value));
      }
    );
    return () => {
      disposed = true;
      handleRef.current = null;
      sheetNamesRef.current = [];
      handle?.dispose();
    };
  }, [bytes, onAnalysis, onError, paint, select]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const schedule = () => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        paint();
      });
    };
    scroll.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(scroll);
    return () => {
      scroll.removeEventListener('scroll', schedule);
      observer.disconnect();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [paint]);

  useEffect(() => {
    highlightRef.current = null;
    const handle = handleRef.current;
    if (!handle) return;
    const match = citation ? xlsxCitation(bytes, handle, citation.quote) : null;
    highlightRef.current = match;
    if (match) {
      handle.setActiveSheet(match.sheet);
      const info = handle.sheetInfo();
      activeSheetRef.current = match.sheet;
      a11yWindowKeyRef.current = '';
      setActiveSheet(match.sheet);
      setExtent({ height: info.contentHeight, width: info.contentWidth });
      select(handle, { col: match.col, row: match.row });
    }
    const raf = requestAnimationFrame(() => {
      if (match && scrollRef.current) {
        const position = handle.cellPosition(match.sheet, match.row, match.col);
        const zoom = zoomRef.current;
        scrollRef.current.scrollLeft = Math.max(0, (position.x - 100) * zoom);
        scrollRef.current.scrollTop = Math.max(0, (position.y - 100) * zoom);
      }
      paint();
    });
    return () => cancelAnimationFrame(raf);
  }, [bytes, citation, sheetNames, paint, select]);

  const selectSheet = (index: number) => {
    const handle = handleRef.current;
    if (!handle) return;
    try {
      handle.setActiveSheet(index);
      const info = handle.sheetInfo();
      activeSheetRef.current = index;
      setActiveSheet(index);
      setExtent({ height: info.contentHeight, width: info.contentWidth });
      sheetScrollRef.current = {
        x: info.initialScrollX,
        y: info.initialScrollY,
      };
      select(handle, ORIGIN.cell);
    } catch (value) {
      onError(toError(value));
    }
  };

  // After the scroll area takes the new size: the anchor goes back under the
  // top-left corner, and the grid is drawn at the new zoom.
  useLayoutEffect(() => {
    zoomRef.current = zoom;
    const scroll = scrollRef.current;
    const anchor = zoomAnchorRef.current;
    zoomAnchorRef.current = null;
    if (scroll && anchor) {
      scroll.scrollLeft = anchor.x * zoom;
      scroll.scrollTop = anchor.y * zoom;
    }
    paint();
  }, [paint, zoom]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const saved = sheetScrollRef.current;
    if (!(scroll && saved && extent.height)) return;
    sheetScrollRef.current = null;
    scroll.scrollLeft = saved.x * zoomRef.current;
    scroll.scrollTop = saved.y * zoomRef.current;
    paint();
  }, [activeSheet, extent, paint]);

  // View mode offers what works here: Download, PNG and Print, which Capy
  // performs from the images drawn below, and View › Zoom.
  const loaded = sheetNames.length > 0;
  useEffect(() => {
    if (!loaded) return;
    onMenus({
      menus: xlsxViewMenus(locale, zoom),
      run: (id) => {
        const [command, value] = id.split(':');
        const next = Number(value) / 100;
        if (command !== 'zoom' || next === zoomRef.current) return;
        const scroll = scrollRef.current;
        if (scroll)
          zoomAnchorRef.current = zoomedViewport(scroll, zoomRef.current);
        setZoom(next);
      },
    });
    return () => onMenus(null);
  }, [loaded, locale, onMenus, zoom]);
  useEffect(() => {
    onRenderer(async (kind) => {
      const handle = handleRef.current;
      const scroll = scrollRef.current;
      if (!(handle && scroll)) throw new Error('Nothing to render');
      const draw = handle.displayList.bind(handle);
      if (kind === 'print') return sheetPages(draw, handle.sheetInfo());
      // The part on screen, at 100% as the editor's PNG.
      return [
        await viewportPage(draw, zoomedViewport(scroll, zoomRef.current)),
      ];
    });
    return () => onRenderer(null);
  }, [onRenderer]);

  const selectAtPointer = (event: MouseEvent<HTMLDivElement>) => {
    const handle = handleRef.current;
    const box = event.currentTarget.getBoundingClientRect();
    const cell = cellAtPoint(
      frameRef.current?.grid,
      (event.clientX - box.left) / zoomRef.current,
      (event.clientY - box.top) / zoomRef.current
    );
    if (!(handle && cell)) return;
    try {
      select(handle, cell);
      paint();
    } catch (value) {
      onError(toError(value));
    }
  };

  const focusSheetTab = (index: number) => {
    selectSheet(index);
    tabRefs.current[index]?.focus();
  };

  const handleSheetTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
    if (sheetNames.length < 2) return;
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (index + 1) % sheetNames.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (index - 1 + sheetNames.length) % sheetNames.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = sheetNames.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    focusSheetTab(next);
  };

  const activeTabId = `${tabsId}-tab-${activeSheet}`;
  const panelId = `${tabsId}-panel`;

  return (
    <div className="office-runtime">
      {/* Where the editor's formula bar sits, so the two modes line up apart
          from the editor's toolbar row. */}
      <div
        aria-label={m.files_office_spreadsheet_formula_bar()}
        className="xlsx-formula-bar"
        role="group"
      >
        <input
          aria-label={m.files_office_spreadsheet_name_box()}
          className="xlsx-name-box"
          readOnly
          value={formula.address}
        />
        <span aria-hidden="true" className="xlsx-formula-mark">
          fx
        </span>
        <input
          aria-label={m.files_office_spreadsheet_cell_contents()}
          className="xlsx-formula-value"
          readOnly
          value={formula.text}
        />
      </div>
      <div
        aria-label={sheetNames.length > 0 ? undefined : a11yGrid?.label}
        aria-labelledby={sheetNames.length > 0 ? activeTabId : undefined}
        className="xlsx-viewport"
        id={panelId}
        onClick={selectAtPointer}
        ref={scrollRef}
        role={sheetNames.length > 0 ? 'tabpanel' : 'region'}
      >
        <div
          aria-hidden="true"
          style={{
            height: extent.height * zoom,
            left: 0,
            position: 'absolute',
            top: 0,
            width: extent.width * zoom,
          }}
        />
        <div aria-hidden="true" className="xlsx-canvas-layer">
          <canvas ref={canvasRef} />
        </div>
        {a11yGrid && <SpreadsheetA11yMirror grid={a11yGrid} />}
      </div>
      {/* Even one sheet gets its tab, as in the editor. */}
      {sheetNames.length > 0 && (
        <div className="xlsx-sheet-tabs" role="tablist">
          {sheetNames.map((name, index) => (
            <button
              aria-controls={panelId}
              aria-selected={index === activeSheet}
              className="xlsx-sheet-tab"
              id={`${tabsId}-tab-${index}`}
              key={`${name}-${index}`}
              onClick={() => selectSheet(index)}
              onKeyDown={(event) => handleSheetTabKeyDown(event, index)}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              role="tab"
              tabIndex={index === activeSheet ? 0 : -1}
              type="button"
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SpreadsheetA11yMirror({ grid }: { grid: A11yGrid }) {
  return (
    <>
      <div aria-label={grid.label} className="office-a11y-only" role="grid">
        <div role="row">
          <span role="columnheader" />
          {grid.columnHeaders.map((header) => (
            <span key={header.col} role="columnheader">
              {header.label}
            </span>
          ))}
        </div>
        {grid.rows.map((row) => (
          <div key={row.row} role="row">
            <span role="rowheader">{row.header}</span>
            {row.cells.map((cell) => (
              <span
                aria-selected={cell.selected}
                key={cell.col}
                role="gridcell"
              >
                {cell.label}
              </span>
            ))}
          </div>
        ))}
      </div>
      {grid.charts.map((chart, index) => (
        <div
          aria-label={chart.label}
          className="office-a11y-only"
          key={`${index}:${chart.label}`}
          role="img"
        />
      ))}
    </>
  );
}

function spreadsheetA11yStrings() {
  return {
    cellLabel: m.files_office_spreadsheet_cell_label({
      address: '{address}',
      value: '{value}',
    }),
    cellLabelSelected: m.files_office_spreadsheet_cell_label_selected({
      address: '{address}',
      value: '{value}',
    }),
    columnHeaderLabel: m.files_office_spreadsheet_column_header_label({
      column: '{column}',
    }),
    emptyCellLabel: m.files_office_spreadsheet_empty_cell_label({
      address: '{address}',
    }),
    emptyCellLabelSelected:
      m.files_office_spreadsheet_empty_cell_label_selected({
        address: '{address}',
      }),
    gridLabel: m.files_office_spreadsheet_grid_label({ sheet: '{sheet}' }),
    rowHeaderLabel: m.files_office_spreadsheet_row_header_label({
      row: '{row}',
    }),
  };
}

function visibleGridWindowKey(
  frame: DisplayList,
  sheet: number,
  sheetName: string
) {
  const grid = frame.grid;
  if (!grid) return `${sheet}:${sheetName}:empty`;
  return JSON.stringify([
    sheet,
    sheetName,
    grid.startRow,
    grid.startCol,
    grid.rowIndices ?? grid.rowOffsets.length,
    grid.colIndices ?? grid.colOffsets.length,
    (frame.charts ?? []).map((chart) => [
      chart.id,
      chart.label,
      chart.placeholder ?? false,
    ]),
  ]);
}

/** The click's cell, or the top-left cell of the merged range it falls in. */
function selectionOf(
  handle: WorkbookViewerHandle,
  sheet: number,
  cell: Cell
): SheetSelection {
  const merged = handle.mergedRanges(sheet, cellAddress(cell))[0];
  if (!merged) return { cell, range: null };
  const range = {
    bottom: Math.max(merged.start.row, merged.end.row),
    left: Math.min(merged.start.col, merged.end.col),
    right: Math.max(merged.start.col, merged.end.col),
    top: Math.min(merged.start.row, merged.end.row),
  };
  return { cell: { col: range.left, row: range.top }, range };
}

function cellAddress({ col, row }: Cell) {
  let letters = '';
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26))
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return `${letters}${row + 1}`;
}

function toError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value));
}
