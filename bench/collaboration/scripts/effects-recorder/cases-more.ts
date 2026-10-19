// The remaining parity rows' cases (edit-cases.md): toolbar formatting,
// links, comment threads, header removal, picture resize, page-break delete,
// table properties, cross-story undo; PPTX resize and border; XLSX copy/paste.
import type { Case } from './cases';

export const MORE: Case[] = [
  {
    id: 'docx-italic-underline',
    rows: ['docx.edit.character'],
    fixtures: ['book-30p'],
    summary: 'the word "enzyme" becomes italic and underlined (formatting only)',
    async run(d) {
      const a = d.peer();
      await d.step('A', 'dblclick', 'enzyme');
      await a.click('enzyme', { at: 2, count: 2 });
      await d.step('A', 'italic+underline');
      await a.press('ControlOrMeta+i');
      await a.press('ControlOrMeta+u');
    },
  },
  {
    id: 'docx-font',
    rows: ['docx.edit.font'],
    fixtures: ['book-30p'],
    summary: 'the word "enzyme" set to Arial 16 pt (formatting only)',
    async run(d) {
      const a = d.peer();
      await a.click('enzyme', { at: 2, count: 2 });
      await d.step('A', 'toolbar', 'font family Arial');
      await a.clickRole('combobox', 'Select font family');
      await a.clickRole('option', /^Arial$/);
      await d.step('A', 'toolbar', 'font size 16');
      await a.fill('Select font size', '16');
      await a.press('Enter');
    },
  },
  {
    id: 'docx-colour',
    rows: ['docx.edit.colour'],
    fixtures: ['book-30p'],
    summary: 'the word "enzyme" gets the toolbar text colour and highlight (formatting only)',
    async run(d) {
      const a = d.peer();
      await a.click('enzyme', { at: 2, count: 2 });
      await d.step('A', 'toolbar', 'text colour');
      await a.clickRole('button', /^Text color$/);
      await d.step('A', 'toolbar', 'highlight');
      await a.clickRole('button', /^Highlight color$/);
    },
  },
  {
    id: 'docx-line-spacing',
    rows: ['docx.edit.paragraph'],
    fixtures: ['book-30p'],
    summary: 'para1 gets double line spacing (paragraph property only)',
    async run(d) {
      const a = d.peer();
      await a.click('Behind art rate five study', { at: 'end' });
      await d.step('A', 'menu', 'spacing:2');
      await a.menu('spacing:2');
    },
  },
  {
    id: 'docx-link',
    rows: ['docx.edit.links'],
    fixtures: ['book-30p'],
    summary: 'the word "enzyme" becomes a link to https://example.com/recorder (text unchanged)',
    async run(d) {
      const a = d.peer();
      await a.click('enzyme', { at: 2, count: 2 });
      await d.step('A', 'Ctrl+K', 'https://example.com/recorder');
      await a.press('ControlOrMeta+k');
      await a.fill('https://example.com', 'https://example.com/recorder');
      await a.press('Enter');
    },
  },
  {
    id: 'docx-replace-one',
    rows: ['docx.edit.find'],
    fixtures: ['book-30p'],
    summary: 'the first "Faraday" after the caret becomes "Maxwell"',
    async run(d) {
      const a = d.peer();
      await a.click('Having act office', { at: 'start' });
      await d.step('A', 'replace-one', 'Faraday -> Maxwell');
      await a.replaceOne('Faraday', 'Maxwell');
    },
    capture: () => ['Maxwell'],
  },
  {
    id: 'docx-comment-reply-resolve',
    rows: ['docx.edit.comments'],
    fixtures: ['exchange-plan-comments'],
    summary: 'the existing comment gets the reply "Recorder reply" and is resolved',
    async run(d) {
      const a = d.peer();
      await d.step('A', 'expand', 'comment card');
      await a.clickText('Check the dates');
      await d.step('A', 'reply', 'Recorder reply');
      await a.fill('Reply or add others with @', 'Recorder reply');
      await a.press('Enter');
      await d.wait(500);
      await d.step('A', 'resolve');
      await a.clickTitle('Resolve');
    },
  },
  {
    id: 'docx-header-remove',
    rows: ['docx.edit.headers'],
    fixtures: ['feature-rich-docx'],
    summary: 'removes the header through its Options menu',
    async run(d) {
      const a = d.peer();
      await d.step('A', 'dblclick', 'header');
      await a.openHeaderFooter('ROUND-TRIP PROOF', 'header');
      await d.step('A', 'header options', 'Remove header');
      await a.clickRole('button', /^Options/);
      await a.clickRole('button', /^Remove /);
    },
  },

  {
    id: 'docx-image-resize',
    rows: ['docx.edit.pictures'],
    fixtures: ['exchange-plan'],
    summary: 'the picture above caption 圖片一 is resized from its bottom-right handle (picture size only)',
    async run(d) {
      const a = d.peer();
      await d.step('A', 'click', 'picture above caption 圖片一');
      await a.clickImage('圖片一');
      await d.step('A', 'drag', 'se handle -60,-40');
      await a.dragSelector('[data-handle=se]', -60, -40);
    },
  },
  {
    id: 'docx-page-break-delete',
    rows: ['docx.edit.breaks'],
    fixtures: ['exchange-plan'],
    summary: 'Backspace at the start of heading "4.2首都圈外郭放水路防洪設施" (first line after a page-break paragraph) removes the break',
    async run(d) {
      const a = d.peer();
      await d.step('A', 'click', 'start of 4.2 heading');
      await a.click('4.2首都圈外郭放水路防洪設施', { at: 'start' });
      await a.press('Home');
      await d.step('A', 'backspace');
      await a.press('Backspace');
    },
  },
  {
    id: 'docx-table-props',
    rows: ['docx.edit.tables'],
    fixtures: ['exchange-plan'],
    summary: 'the insurer table gets a pinned header row and distributed columns (table properties only)',
    async run(d) {
      const a = d.peer();
      await a.click('友邦保險', { at: 1 });
      await d.step('A', 'menu', 'table-header-row, table-distribute');
      await a.menu('table-header-row');
      await a.menu('table-distribute');
    },
  },
  {
    id: 'docx-undo-across-stories',
    rows: ['docx.edit.undo'],
    fixtures: ['comprehensive'],
    summary: 'types in the body and in the header, then undoes both: no net change',
    async run(d) {
      const a = d.peer();
      await a.click('Centered paragraph', { at: 'end' });
      await d.step('A', 'type', ' body');
      await a.type(' body');
      await d.wait(600);
      await d.step('A', 'dblclick', 'header');
      await a.openHeaderFooter('default header', 'header');
      await d.step('A', 'type', ' head');
      await a.type(' head');
      await d.wait(600);
      await d.step('A', 'undo x2');
      await a.press('ControlOrMeta+z');
      await a.press('ControlOrMeta+z');
    },
  },

  {
    id: 'pptx-object-resize',
    rows: ['pptx.edit.objects'],
    fixtures: ['lecture'],
    summary: 'the slide 3 body box is made smaller from its bottom-right handle (geometry only)',
    async run(d) {
      const a = d.peer();
      await d.step('A', 'select', 'slide 3 body box');
      await a.shape(3, 'Owner sentence', 'select');
      await d.step('A', 'drag', 'se handle -80,-40');
      await a.dragSelector('[data-testid=pptx-resize-se]', -80, -40);
    },
  },
  {
    id: 'pptx-shape-format',
    rows: ['pptx.edit.shape_format'],
    fixtures: ['feature-rich-pptx'],
    summary: 'the first card shape gets a 4 pt border (shape property only)',
    async run(d) {
      const a = d.peer();
      await d.step('A', 'select', 'slide 1 shape 3 (card)');
      await a.shapeByIndex(1, 3);
      await d.step('A', 'menu', 'format.borderWeight:4');
      await a.menu('format.borderWeight:4');
    },
  },
  {
    id: 'xlsx-copy-paste',
    rows: ['xlsx.edit.clipboard'],
    fixtures: ['grades'],
    summary: 'A1:B3 copied and pasted at D1 (6 cells set)',
    async run(d) {
      const a = d.peer();
      await a.goto('A1');
      await d.step('A', 'select', 'A1:B3');
      await a.press('Shift+ArrowRight');
      await a.press('Shift+ArrowDown', 2);
      await d.step('A', 'copy');
      await a.press('ControlOrMeta+c');
      await a.goto('D1');
      await d.step('A', 'paste');
      await a.press('ControlOrMeta+v');
    },
  },
];

