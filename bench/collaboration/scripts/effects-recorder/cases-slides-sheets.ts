// PPTX and XLSX cases (edit-cases.md). Slide text is reached through the
// shape boxes of the slide XML (pptx_shapes.py) and the keyboard; cells
// through the name box.
import type { Case } from './cases';

const LINE = 'Pasted words from the recorder.';
const LINES = (n: number) => Array.from({ length: n }, (_, i) => `Recorder pasted line ${i + 1}`).join('\n');

export const PPTX: Case[] = [
  {
    id: 'pptx-type-title',
    rows: ['pptx.edit.text'],
    fixtures: ['lecture', 'deck-50'],
    summary: 'the slide 2 title gains " (recorded)"',
    async run(d, f) {
      const a = d.peer();
      const title = f.key === 'lecture' ? 'Eiusmod tempor incididunt' : '2. Less with behind';
      await d.step('A', 'shape', `slide 2 "${title}" paragraph end`);
      await a.shape(2, title, 'paragraph-end');
      await d.step('A', 'type');
      await a.type(' (recorded)');
    },
  },
  {
    id: 'pptx-type-body-mid',
    rows: ['pptx.edit.text'],
    fixtures: ['lecture', 'deck-50'],
    summary: 'a slide 3 body paragraph gains " recorder" in its middle',
    async run(d, f) {
      const a = d.peer();
      const needle = f.key === 'lecture' ? 'Owner sentence: The survey' : 'Hand left run almost';
      await d.step('A', 'shape', `slide 3 after "${needle}"`);
      await a.shape(3, needle, 'end');
      await d.step('A', 'type');
      await a.type(' recorder');
    },
  },
  {
    id: 'pptx-enter-split',
    rows: ['pptx.edit.text'],
    fixtures: ['lecture'],
    summary: 'a slide 3 body paragraph is split in two',
    async run(d) {
      const a = d.peer();
      await d.step('A', 'shape', 'slide 3 after "Owner sentence: The survey"');
      await a.shape(3, 'Owner sentence: The survey', 'end');
      await d.step('A', 'enter');
      await a.press('Enter');
    },
  },
  {
    id: 'pptx-enter-new-paragraph',
    rows: ['pptx.edit.text'],
    fixtures: ['lecture'],
    summary: 'a new body paragraph "Recorder bullet" after the first slide 3 body paragraph',
    async run(d) {
      const a = d.peer();
      await d.step('A', 'shape', 'slide 3 end of the first body paragraph');
      await a.shape(3, 'Owner sentence: The survey', 'paragraph-end');
      await d.step('A', 'enter');
      await a.press('Enter');
      await d.step('A', 'type');
      await a.type('Recorder bullet');
    },
  },
  {
    id: 'pptx-backspace-merge',
    rows: ['pptx.edit.text'],
    fixtures: ['lecture'],
    summary: 'Backspace at the start of numbered item 2 on slide 3: the first Backspace drops its numbering (text unchanged, paragraph properties change)',
    async run(d) {
      const a = d.peer();
      await d.step('A', 'shape', 'slide 3 start of "Quis nostrud exercitation"');
      await a.shape(3, 'Quis nostrud exercitation', 'start');
      await d.step('A', 'backspace');
      await a.press('Backspace');
    },
  },
  {
    id: 'pptx-delete-cross-paragraph',
    rows: ['pptx.edit.text'],
    fixtures: ['deck-50'],
    summary: 'from inside the first to inside the third body paragraph of slide 2 deleted',
    async run(d) {
      const a = d.peer();
      await d.step('A', 'shape', 'slide 2 after "These full toward"');
      await a.shape(2, 'These full toward', 'end');
      await d.step('A', 'select', 'Shift+Down x2');
      await a.press('Shift+ArrowDown', 2);
      await d.step('A', 'delete');
      await a.press('Delete');
    },
  },
  {
    id: 'pptx-clear-box',
    rows: ['pptx.edit.text'],
    fixtures: ['lecture'],
    summary: 'all text of the slide 3 body box is deleted',
    async run(d) {
      const a = d.peer();
      await a.shape(3, 'Owner sentence: The survey', 'start');
      await d.step('A', 'select-all');
      await a.press('ControlOrMeta+a');
      await d.step('A', 'delete');
      await a.press('Delete');
    },
  },
  {
    id: 'pptx-paste-plain',
    rows: ['pptx.edit.clipboard'],
    fixtures: ['lecture'],
    summary: `a slide 3 body paragraph gains " ${LINE}"`,
    async run(d) {
      const a = d.peer();
      await a.shape(3, 'Owner sentence: The survey', 'paragraph-end');
      await d.step('A', 'paste');
      await a.paste(` ${LINE}`);
    },
  },
  {
    id: 'pptx-paste-multi',
    rows: ['pptx.edit.clipboard'],
    fixtures: ['lecture'],
    summary: 'six pasted lines become paragraphs in the slide 3 body',
    async run(d) {
      const a = d.peer();
      await a.shape(3, 'Owner sentence: The survey', 'paragraph-end');
      await a.press('Enter');
      await d.step('A', 'paste', '6 lines');
      await a.paste(LINES(6));
    },
  },
  {
    id: 'pptx-undo-typing',
    rows: ['pptx.edit.undo'],
    fixtures: ['lecture'],
    summary: 'typed " undo me" then one Ctrl+Z, which here takes back only the last typed character (" undo m" stays)',
    async run(d) {
      const a = d.peer();
      await a.shape(3, 'Owner sentence: The survey', 'end');
      await d.step('A', 'type');
      await a.type(' undo me');
      await d.wait(700);
      await d.step('A', 'undo');
      await a.press('ControlOrMeta+z');
    },
  },
  {
    id: 'pptx-undo-redo',
    rows: ['pptx.edit.undo'],
    fixtures: ['lecture'],
    summary: 'typed text undone and redone: the paragraph gains " redo me"',
    async run(d) {
      const a = d.peer();
      await a.shape(3, 'Owner sentence: The survey', 'end');
      await d.step('A', 'type');
      await a.type(' redo me');
      await d.wait(700);
      await d.step('A', 'undo');
      await a.press('ControlOrMeta+z');
      await d.step('A', 'redo');
      await a.press('ControlOrMeta+Shift+z');
    },
  },
  {
    id: 'pptx-character',
    rows: ['pptx.edit.character'],
    fixtures: ['lecture'],
    summary: 'bold and italic on a slide 3 phrase (formatting only)',
    async run(d) {
      const a = d.peer();
      await a.shape(3, 'Owner sentence', 'start');
      await a.press('Shift+End');
      await d.step('A', 'bold+italic');
      await a.press('ControlOrMeta+b');
      await a.press('ControlOrMeta+i');
    },
  },
  {
    id: 'pptx-paragraph',
    rows: ['pptx.edit.paragraph'],
    fixtures: ['lecture'],
    summary: 'a slide 3 body paragraph centred and indented (paragraph properties only)',
    async run(d) {
      const a = d.peer();
      await a.shape(3, 'Owner sentence', 'start');
      await d.step('A', 'menu', 'format.alignCenter, format.increaseIndent');
      await a.menu('format.alignCenter');
      await a.menu('format.increaseIndent');
    },
  },
  {
    id: 'pptx-textbox-insert',
    rows: ['pptx.edit.objects'],
    fixtures: ['lecture', 'feature-rich-pptx'],
    summary: 'a new text box with "Recorder box" on slide 1',
    async run(d) {
      const a = d.peer();
      await a.slide(1);
      await d.step('A', 'menu', 'insert.textBox');
      await a.menu('insert.textBox');
      await d.step('A', 'click', 'slide at 20%,85%');
      await a.slideClick(0.2, 0.85);
      await d.step('A', 'type');
      await a.type('Recorder box');
    },
  },
  {
    id: 'pptx-shape-insert',
    rows: ['pptx.edit.objects'],
    fixtures: ['feature-rich-pptx'],
    summary: 'a new rectangle on slide 1 (no text: a new shape has no text body to type into)',
    async run(d) {
      const a = d.peer();
      await a.slide(1);
      await d.step('A', 'menu', 'insert.shape:rect');
      await a.menu('insert.shape:rect');
      await a.slideClick(0.6, 0.8);
    },
  },
  {
    id: 'pptx-shape-text-type',
    rows: ['pptx.edit.text', 'pptx.edit.objects'],
    fixtures: ['feature-rich-pptx'],
    summary: 'the text of an existing card shape ("Identify format and cheap metadata") gains " now"',
    async run(d) {
      const a = d.peer();
      await d.step('A', 'shape', 'slide 1 card text "Identify format"');
      await a.shape(1, 'Identify format and chea', 'paragraph-end');
      await d.step('A', 'type');
      await a.type(' now');
    },
  },
  {
    id: 'pptx-image-insert',
    rows: ['pptx.edit.objects'],
    fixtures: ['lecture'],
    summary: 'a red PNG is added to slide 1',
    async run(d) {
      const a = d.peer();
      await a.slide(1);
      await d.step('A', 'menu-file', 'insert.image red-64x48.png');
      await a.pickFile('insert.image', 'red-64x48.png', 'image/png');
    },
  },
  {
    id: 'pptx-object-delete',
    rows: ['pptx.edit.objects'],
    fixtures: ['lecture'],
    summary: 'the slide 3 body text box is deleted with its text',
    async run(d) {
      const a = d.peer();
      await d.step('A', 'select', 'slide 3 body box');
      await a.shape(3, 'Owner sentence', 'select');
      await d.step('A', 'delete');
      await a.press('Delete');
    },
  },
  {
    id: 'pptx-image-delete',
    rows: ['pptx.edit.objects'],
    fixtures: ['lecture'],
    summary: 'the largest picture on slide 2 is deleted',
    async run(d) {
      const a = d.peer();
      await d.step('A', 'select', 'slide 2 shape 3 (picture)');
      await a.shapeByIndex(2, 2);
      await d.step('A', 'delete');
      await a.press('Delete');
    },
  },
  {
    id: 'pptx-object-move',
    rows: ['pptx.edit.objects'],
    fixtures: ['lecture'],
    summary: 'the slide 3 body box is dragged right and down (geometry only)',
    async run(d) {
      const a = d.peer();
      await d.step('A', 'drag', 'slide 3 body box');
      await a.dragShape(3, 'Owner sentence', 0.05, 0.03);
    },
  },
  {
    id: 'pptx-arrange',
    rows: ['pptx.edit.arrange'],
    fixtures: ['lecture'],
    summary: 'a slide 2 picture brought to front (order only)',
    async run(d) {
      const a = d.peer();
      await a.shapeByIndex(2, 3);
      await d.step('A', 'menu', 'arrange.bringToFront');
      await a.menu('arrange.bringToFront');
    },
  },
  {
    id: 'pptx-slide-new',
    rows: ['pptx.edit.slides'],
    fixtures: ['lecture', 'deck-50'],
    summary: 'a new slide after slide 1',
    async run(d) {
      const a = d.peer();
      await a.slide(1);
      await d.step('A', 'menu', 'slide.new');
      await a.menu('slide.new');
    },
  },
  {
    id: 'pptx-slide-delete',
    rows: ['pptx.edit.slides'],
    fixtures: ['lecture', 'deck-50'],
    summary: 'slide 3 is deleted (its text gone)',
    async run(d) {
      const a = d.peer();
      await a.slide(3);
      await d.step('A', 'menu', 'slide.delete');
      await a.menu('slide.delete');
    },
  },
  {
    id: 'pptx-slide-move',
    rows: ['pptx.edit.slides'],
    fixtures: ['lecture'],
    summary: 'slide 2 moves down one place (order only)',
    async run(d) {
      const a = d.peer();
      await a.slide(2);
      await d.step('A', 'menu', 'slide.moveDown');
      await a.menu('slide.moveDown');
    },
  },
  {
    id: 'pptx-table-cell-type',
    rows: ['pptx.view.tables'],
    fixtures: ['lecture'],
    summary: 'a table cell gains " recorder"',
    blocked:
      "the PPTX layout gives table cells no text hit regions (pptx-render layout.rs render_table drops each cell's render_text_box hit; only the frame is hit-testable), so clicks select the table and never enter a cell; cell edits are engine-only (pptx-edit tests)",
    async run(d) {
      const a = d.peer();
      await d.step('A', 'table cell');
      await a.tableCell();
      await d.step('A', 'type');
      await a.type(' recorder');
    },
  },
  {
    id: 'pptx-notes-type',
    rows: ['pptx.view.notes'],
    fixtures: ['lecture'],
    summary: 'slide 2 speaker notes gain " Recorded."',
    async run(d) {
      const a = d.peer();
      await a.slide(2);
      await d.step('A', 'notes', 'type');
      await a.notes(' Recorded.');
    },
  },
  {
    id: 'pptx-download',
    rows: ['pptx.save.download'],
    fixtures: ['lecture'],
    summary: 'Download: nothing changes',
    expectNoUpdates: true,
    async run(d) {
      await d.step('A', 'export');
      await d.exportFile('A');
    },
  },
  {
    id: 'pptx-2p-same-paragraph',
    rows: ['pptx.edit.text'],
    fixtures: ['lecture'],
    peers: ['A', 'B'],
    summary: 'A and B type in one slide 3 paragraph at once',
    async run(d) {
      const [a, b] = [d.peer('A'), d.peer('B')];
      await d.hold();
      await a.shape(3, 'Owner sentence:', 'end');
      await b.shape(3, 'weighs 42', 'end');
      await d.step('A', 'type', ' alpha');
      await a.type(' alpha');
      await d.step('B', 'type', ' beta');
      await b.type(' beta');
      await d.release();
    },
  },
  {
    id: 'pptx-2p-delete-slide-vs-type',
    rows: ['pptx.edit.slides'],
    fixtures: ['lecture'],
    peers: ['A', 'B'],
    summary: 'A deletes slide 3 while B types in it',
    async run(d) {
      const [a, b] = [d.peer('A'), d.peer('B')];
      await d.hold();
      await b.shape(3, 'Owner sentence:', 'end');
      await a.slide(3);
      await d.step('A', 'menu', 'slide.delete');
      await a.menu('slide.delete');
      await d.step('B', 'type', ' orphan');
      await b.type(' orphan');
      await d.release();
    },
  },
  {
    id: 'pptx-2p-notes',
    rows: ['pptx.view.notes'],
    fixtures: ['lecture'],
    peers: ['A', 'B'],
    summary: 'A and B type in slide 2 notes at once (whole-value notes: one wins)',
    async run(d) {
      const [a, b] = [d.peer('A'), d.peer('B')];
      await d.hold();
      await a.slide(2);
      await b.slide(2);
      await d.step('A', 'notes', ' from A');
      await a.notes(' from A');
      await d.step('B', 'notes', ' from B');
      await b.notes(' from B');
      await d.release();
    },
  },
];

const TSV = Array.from({ length: 5 }, (_, r) => Array.from({ length: 5 }, (_, c) => `r${r + 1}c${c + 1}`).join('\t')).join('\n');

export const XLSX: Case[] = [
  {
    id: 'xlsx-cell-type-new',
    rows: ['xlsx.edit.entry'],
    fixtures: ['grades', 'course-guide'],
    summary: 'a cell of the first sheet gets "recorded" (grades: empty E6, course-guide: H10)',
    async run(d, f) {
      const a = d.peer();
      // Keyboard reach ends two rows and five columns past the used range.
      const cell = f.key === 'grades' ? 'E6' : 'H10';
      await d.step('A', 'goto', cell);
      await a.goto(cell);
      await d.step('A', 'type', 'recorded');
      await a.type('recorded');
      await a.press('Enter');
    },
  },
  {
    id: 'xlsx-cell-overwrite',
    rows: ['xlsx.edit.entry'],
    fixtures: ['grades', 'course-guide'],
    summary: 'B3 is overwritten (grades: 17 -> 99; course-guide: "Recorded course")',
    async run(d, f) {
      const a = d.peer();
      await d.step('A', 'goto', 'B3');
      await a.goto('B3');
      await d.step('A', 'type');
      await a.type(f.key === 'grades' ? '99' : 'Recorded course');
      await a.press('Enter');
    },
  },
  {
    id: 'xlsx-cell-edit-f2',
    rows: ['xlsx.edit.entry'],
    fixtures: ['grades'],
    summary: 'A4 gains " (edited)" at its end through F2',
    async run(d) {
      const a = d.peer();
      await a.goto('A4');
      await d.step('A', 'F2, End, type');
      await a.press('F2');
      await a.press('End');
      await a.type(' (edited)');
      await a.press('Enter');
    },
  },
  {
    id: 'xlsx-cell-formula',
    rows: ['xlsx.edit.entry', 'xlsx.calc.engine'],
    fixtures: ['grades', 'feature-rich-xlsx'],
    summary: 'D2 gets =SUM(B2:B3)',
    async run(d) {
      const a = d.peer();
      await a.goto('D2');
      await d.step('A', 'type', '=SUM(B2:B3)');
      await a.type('=SUM(B2:B3)');
      await a.press('Enter');
    },
  },
  {
    id: 'xlsx-formula-edit',
    rows: ['xlsx.calc.engine'],
    fixtures: ['grades'],
    summary: 'C2 =B2*2 becomes =B2*3',
    async run(d) {
      const a = d.peer();
      await a.goto('C2');
      await d.step('A', 'type', '=B2*3');
      await a.type('=B2*3');
      await a.press('Enter');
    },
  },
  {
    id: 'xlsx-input-recalc',
    rows: ['xlsx.calc.engine'],
    fixtures: ['grades'],
    summary: 'B2 42 becomes 50 (C2 recomputes to 100)',
    async run(d) {
      const a = d.peer();
      await a.goto('B2');
      await d.step('A', 'type', '50');
      await a.type('50');
      await a.press('Enter');
    },
  },
  {
    id: 'xlsx-cell-clear',
    rows: ['xlsx.edit.entry'],
    fixtures: ['grades', 'course-guide'],
    summary: 'A3 is cleared',
    async run(d) {
      const a = d.peer();
      await a.goto('A3');
      await d.step('A', 'delete');
      await a.press('Delete');
    },
  },
  {
    id: 'xlsx-row-insert',
    rows: ['xlsx.edit.rows_cols'],
    fixtures: ['grades', 'course-guide'],
    summary: 'a row is inserted above row 3 and its A cell gets "inserted row"',
    async run(d) {
      const a = d.peer();
      await a.goto('A3');
      await d.step('A', 'menu', 'insertRowAbove');
      await a.menu('insertRowAbove');
      await a.goto('A3');
      await d.step('A', 'type', 'inserted row');
      await a.type('inserted row');
      await a.press('Enter');
    },
  },
  {
    id: 'xlsx-row-delete',
    rows: ['xlsx.edit.rows_cols'],
    fixtures: ['grades', 'course-guide'],
    summary: 'row 3 is deleted',
    async run(d) {
      const a = d.peer();
      await a.goto('A3');
      await d.step('A', 'menu', 'deleteRows');
      await a.menu('deleteRows');
    },
  },
  {
    id: 'xlsx-col-insert',
    rows: ['xlsx.edit.rows_cols'],
    fixtures: ['grades', 'course-guide'],
    summary: 'a column is inserted left of B',
    async run(d) {
      const a = d.peer();
      await a.goto('B1');
      await d.step('A', 'menu', 'insertColumnLeft');
      await a.menu('insertColumnLeft');
    },
  },
  {
    id: 'xlsx-col-delete',
    rows: ['xlsx.edit.rows_cols'],
    fixtures: ['grades', 'course-guide'],
    summary: 'column B is deleted',
    async run(d) {
      const a = d.peer();
      await a.goto('B1');
      await d.step('A', 'menu', 'deleteColumns');
      await a.menu('deleteColumns');
    },
  },
  {
    id: 'xlsx-paste-block',
    rows: ['xlsx.edit.clipboard'],
    fixtures: ['grades', 'course-guide'],
    summary: 'a 5x5 block pasted at E2 (25 cells)',
    async run(d) {
      const a = d.peer();
      await a.goto('E2');
      await d.step('A', 'paste', '5x5 TSV');
      await a.paste(TSV);
    },
  },
  {
    id: 'xlsx-format',
    rows: ['xlsx.edit.format', 'xlsx.view.numfmt'],
    fixtures: ['grades'],
    summary: 'B2 bold, B3 percentage, A4:B5 merged (formatting only; the merge hides B4/B5/A5 values if any)',
    async run(d) {
      const a = d.peer();
      await a.goto('B2');
      await d.step('A', 'menu', 'bold');
      await a.menu('bold');
      await a.goto('B3');
      await d.step('A', 'menu', 'numberFormat:percent');
      await a.menu('numberFormat:percent');
      await d.step('A', 'select', 'A4:B5');
      await a.goto('A4');
      await a.press('Shift+ArrowRight');
      await a.press('Shift+ArrowDown');
      await d.step('A', 'menu', 'merge:all');
      await a.menu('merge:all');
    },
  },
  {
    id: 'xlsx-sheet-add',
    rows: ['xlsx.edit.sheets'],
    fixtures: ['grades'],
    summary: 'a new sheet whose A1 gets "new sheet"',
    async run(d) {
      const a = d.peer();
      await d.step('A', 'menu', 'insertSheet');
      await a.menu('insertSheet');
      await a.goto('A1');
      await d.step('A', 'type', 'new sheet');
      await a.type('new sheet');
      await a.press('Enter');
    },
  },
  {
    id: 'xlsx-undo-redo',
    rows: ['xlsx.edit.undo'],
    fixtures: ['grades'],
    summary: 'E5 typed, undone and redone ("kept"); E6 typed and undone',
    async run(d) {
      const a = d.peer();
      await a.goto('E5');
      await d.step('A', 'type', 'kept');
      await a.type('kept');
      await a.press('Enter');
      await d.step('A', 'undo, redo');
      await a.press('ControlOrMeta+z');
      await a.press('ControlOrMeta+Shift+z');
      await a.goto('E6');
      await d.step('A', 'type', 'dropped');
      await a.type('dropped');
      await a.press('Enter');
      await d.step('A', 'undo');
      await a.press('ControlOrMeta+z');
    },
  },
  {
    id: 'xlsx-freeze',
    rows: ['xlsx.view.freeze'],
    fixtures: ['grades'],
    summary: 'the first row frozen (view property only)',
    async run(d) {
      const a = d.peer();
      await a.goto('A2');
      await d.step('A', 'menu', 'freezeRows:1');
      await a.menu('freezeRows:1');
    },
  },
  {
    id: 'xlsx-large-edit',
    rows: ['xlsx.view.large'],
    fixtures: ['rows-50k'],
    summary: 'cell B40000 gets "recorded"',
    async run(d) {
      const a = d.peer();
      await a.goto('B40000');
      await d.step('A', 'type', 'recorded');
      await a.type('recorded');
      await a.press('Enter');
    },
  },
  {
    id: 'xlsx-view-only',
    rows: ['xlsx.edit.zoom', 'xlsx.edit.keyboard'],
    fixtures: ['grades'],
    summary: 'keyboard navigation only: no change',
    expectNoUpdates: true,
    async run(d) {
      const a = d.peer();
      await a.goto('A1');
      await d.step('A', 'keys', 'arrows, Ctrl+arrows');
      await a.press('ArrowDown', 3);
      await a.press('ArrowRight', 2);
      await a.press('ControlOrMeta+ArrowDown');
      await a.press('ControlOrMeta+Home');
    },
  },
  {
    id: 'xlsx-download',
    rows: ['xlsx.save.download'],
    fixtures: ['grades'],
    summary: 'Download: nothing changes',
    expectNoUpdates: true,
    async run(d) {
      await d.step('A', 'export');
      await d.exportFile('A');
    },
  },
  {
    id: 'xlsx-2p-cells',
    rows: ['xlsx.edit.entry'],
    fixtures: ['grades'],
    peers: ['A', 'B'],
    summary: 'A types in E3 and B in F3 at once',
    async run(d) {
      const [a, b] = [d.peer('A'), d.peer('B')];
      await d.hold();
      await a.goto('E3');
      await b.goto('F3');
      await d.step('A', 'type', 'from A');
      await a.type('from A');
      await a.press('Enter');
      await d.step('B', 'type', 'from B');
      await b.type('from B');
      await b.press('Enter');
      await d.release();
    },
  },
  {
    id: 'xlsx-2p-same-cell',
    rows: ['xlsx.edit.entry'],
    fixtures: ['grades'],
    peers: ['A', 'B'],
    summary: 'A and B type in E4 at once (one value wins)',
    async run(d) {
      const [a, b] = [d.peer('A'), d.peer('B')];
      await d.hold();
      await a.goto('E4');
      await b.goto('E4');
      await d.step('A', 'type', 'from A');
      await a.type('from A');
      await a.press('Enter');
      await d.step('B', 'type', 'from B');
      await b.type('from B');
      await b.press('Enter');
      await d.release();
    },
  },
  {
    id: 'xlsx-2p-row-vs-type',
    rows: ['xlsx.edit.rows_cols'],
    fixtures: ['grades'],
    peers: ['A', 'B'],
    summary: 'A inserts a row above row 2 while B types in A4',
    async run(d) {
      const [a, b] = [d.peer('A'), d.peer('B')];
      await d.hold();
      await a.goto('A2');
      await b.goto('A4');
      await d.step('A', 'menu', 'insertRowAbove');
      await a.menu('insertRowAbove');
      await d.step('B', 'type', 'from B');
      await b.type('from B');
      await b.press('Enter');
      await d.release();
    },
  },
];
