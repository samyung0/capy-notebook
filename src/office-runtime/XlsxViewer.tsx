import {
  type A11yGrid,
  analyzeOpenWorkbook,
  buildA11yGrid,
  type DisplayList,
  initWasm,
  openWorkbook,
  paintDisplayList,
  type WorkbookAnalysis,
  type WorkbookViewerHandle,
} from '@betteroffice/xlsx/viewer';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { m } from '@/i18n';

export function XlsxViewer({
  bytes,
  onAnalysis,
  onError,
}: {
  bytes: Uint8Array;
  onAnalysis: (analysis: WorkbookAnalysis) => void;
  onError: (error: Error) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<WorkbookViewerHandle | null>(null);
  const rafRef = useRef<number | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const sheetNamesRef = useRef<string[]>([]);
  const activeSheetRef = useRef(0);
  const a11yWindowKeyRef = useRef('');
  const tabsId = useId();
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [a11yGrid, setA11yGrid] = useState<A11yGrid | null>(null);
  const [extent, setExtent] = useState({ height: 0, width: 0 });

  const paint = useCallback(() => {
    const scroll = scrollRef.current;
    const canvas = canvasRef.current;
    const handle = handleRef.current;
    if (!scroll || !canvas || !handle) return;
    const width = scroll.clientWidth;
    const height = scroll.clientHeight;
    if (width === 0 || height === 0) return;
    try {
      const frame = handle.displayList({
        height,
        width,
        x: scroll.scrollLeft,
        y: scroll.scrollTop,
      });
      const sheetName = sheetNamesRef.current[activeSheetRef.current] ?? '';
      const windowKey = visibleGridWindowKey(
        frame,
        activeSheetRef.current,
        sheetName
      );
      if (windowKey !== a11yWindowKeyRef.current) {
        a11yWindowKeyRef.current = windowKey;
        setA11yGrid(
          buildA11yGrid(frame, null, sheetName, spreadsheetA11yStrings())
        );
      }
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const context = canvas.getContext('2d');
      if (context) paintDisplayList(context, frame, dpr);
    } catch (value) {
      onError(toError(value));
    }
  }, [onError]);

  useEffect(() => {
    let disposed = false;
    let handle: WorkbookViewerHandle | null = null;
    a11yWindowKeyRef.current = '';
    activeSheetRef.current = 0;
    sheetNamesRef.current = [];
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
          onAnalysis(analysis);
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
  }, [bytes, onAnalysis, onError, paint]);

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

  const selectSheet = (index: number) => {
    const handle = handleRef.current;
    if (!handle) return;
    try {
      handle.setActiveSheet(index);
      const info = handle.sheetInfo();
      activeSheetRef.current = index;
      a11yWindowKeyRef.current = '';
      setActiveSheet(index);
      setExtent({ height: info.contentHeight, width: info.contentWidth });
      const scroll = scrollRef.current;
      if (scroll) {
        scroll.scrollLeft = info.initialScrollX;
        scroll.scrollTop = info.initialScrollY;
      }
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
      {sheetNames.length > 1 && (
        <div className="office-tabs" role="tablist">
          {sheetNames.map((name, index) => (
            <button
              aria-controls={panelId}
              aria-selected={index === activeSheet}
              className="office-tab"
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
      <div
        aria-label={sheetNames.length === 1 ? a11yGrid?.label : undefined}
        aria-labelledby={sheetNames.length > 1 ? activeTabId : undefined}
        className="xlsx-viewport"
        id={panelId}
        ref={scrollRef}
        role={sheetNames.length > 1 ? 'tabpanel' : 'region'}
      >
        <div
          aria-hidden="true"
          style={{
            height: extent.height,
            left: 0,
            position: 'absolute',
            top: 0,
            width: extent.width,
          }}
        />
        <div aria-hidden="true" className="xlsx-canvas-layer">
          <canvas ref={canvasRef} />
        </div>
        {a11yGrid && <SpreadsheetA11yMirror grid={a11yGrid} />}
      </div>
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

function toError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value));
}
