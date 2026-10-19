// The scripted cases (edit-cases.md in the track folder is the plan). Each
// runs on every fixture it lists; `SPOTS` name the text each fixture offers.
import { MORE } from './cases-more';
import { PPTX, XLSX } from './cases-slides-sheets';
import type { Driver, Peer } from './drivers';
import type { Fixture } from './session';

export interface Case {
  id: string;
  rows: string[];
  fixtures: string[];
  peers?: string[];
  summary: string;
  /** A case whose correct outcome writes nothing (view tools, download). */
  expectNoUpdates?: boolean;
  /** Not reachable through Capy's UI at this pin: listed, not recorded. */
  blocked?: string;
  run(driver: Driver, fixture: Fixture): Promise<void>;
  capture?(fixture: Fixture): string[];
}

/** Text the cases act on, per fixture: needles unique enough to find. */
const SPOTS: Record<string, Record<string, string>> = {
  'book-30p': {
    mid: 'Having act office',
    para1: 'Behind art rate five study',
    para2: 'Line never became run reason',
    para3: 'Following many government get here',
    heading: '1.1 While line best asked',
    listItem: 'Social best so make party',
    listLast: 'As Faraday perhaps federal',
    far1: 'Problems thing west world',
    far2: 'Money money group past Newton',
    far3: 'Upon economic integral room',
    far4: 'Very in school mother life',
    word: 'enzyme',
  },
  'exchange-plan': {
    mid: '以下為本會此次活動的概要',
    para1: '名稱：東京四天工程交流團',
    para2: '機構：香港大學工程學院',
    para3: '日期：二零二三年四月七日',
    heading: '1.1.  活動背景',
    title: '交流學習團活動計劃書',
    cell: '友邦保險',
    headerCell: '價錢',
    footer: '',
  },
  comprehensive: {
    mid: 'Centered paragraph',
    cell: 'Header A',
    cell2: 'Header B',
    tracked: 'This sentence has',
    footnote: 'A footnote with bold text',
    endnote: 'An endnote',
    header: 'default header',
    footer: 'Page ',
    field: 'Simple field: page',
    fieldDate: 'created in',
    control: 'Inline control:',
    textbox: 'A wrapped-square shape',
    arabic: 'مرحبا',
    heading: 'Character formatting',
  },
  'feature-rich-docx': {
    header: 'ROUND-TRIP PROOF',
  },
};

const spot = (fixture: Fixture, name: string) => {
  const value = SPOTS[fixture.key]?.[name];
  if (value === undefined) throw new Error(`no spot ${name} for ${fixture.key}`);
  return value;
};

const LINE = 'Pasted words from the recorder.';
const PARAGRAPHS = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `Recorder paste paragraph ${i + 1}: ${'lorem ipsum dolor sit amet '.repeat(i % 3 === 2 ? 18 : 3).trim()}.`
  ).join('\n');
const typed = (f: Fixture) => (f.key === 'exchange-plan' ? '記錄' : ' recorder');

/** Click at the end of a needle and step-log it. */
async function at(d: Driver, a: Peer, needle: string, where: 'start' | 'end' = 'end', scope?: 'body' | 'header' | 'footer' | 'notes') {
  await d.step(a.name, 'click', `${where} of "${needle}"${scope ? ` in ${scope}` : ''}`);
  await a.click(needle, { at: where, scope });
}

const DOCX: Case[] = [
  {
    id: 'docx-type-mid',
    rows: ['docx.edit.typing'],
    fixtures: ['book-30p', 'exchange-plan'],
    summary: 'one body paragraph gains " recorder" (book) / "記錄" (exchange) at the caret',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'mid'));
      await d.step('A', 'type', typed(f));
      await a.type(typed(f));
    },
    capture: (f) => [spot(f, 'mid')],
  },
  {
    id: 'docx-type-end',
    rows: ['docx.edit.typing'],
    fixtures: ['book-30p', 'exchange-plan'],
    summary: 'para1 gains a sentence at its end',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'para1'));
      await a.press('End');
      await d.step('A', 'type');
      await a.type(' The recorder appended this sentence.');
    },
    capture: (f) => [spot(f, 'para1')],
  },
  {
    id: 'docx-type-scattered',
    rows: ['docx.edit.typing'],
    fixtures: ['book-30p'],
    summary: 'five paragraphs on pages 1 to 28 each gain one "Z" after their first words',
    async run(d, f) {
      const a = d.peer();
      for (const name of ['mid', 'far1', 'far2', 'far3', 'far4']) {
        await at(d, a, spot(f, name));
        await d.step('A', 'type', 'Z');
        await a.type('Z');
      }
    },
    capture: (f) => ['far1', 'far2', 'far3', 'far4'].map((n) => spot(f, n)),
  },
  {
    id: 'docx-type-long',
    rows: ['docx.edit.typing'],
    fixtures: ['book-30p'],
    summary: 'para1 gains 400 typed characters at its end',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'para1'));
      await a.press('End');
      await d.step('A', 'type', '400 characters');
      await a.type(` ${'The quick brown fox jumps over the lazy dog. '.repeat(9).slice(0, 399)}`, 8);
    },
    capture: (f) => [spot(f, 'para1')],
  },
  {
    id: 'docx-type-heading',
    rows: ['docx.edit.typing'],
    fixtures: ['book-30p', 'exchange-plan'],
    summary: 'a heading gains text at its end',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'heading'));
      await a.press('End');
      await d.step('A', 'type');
      await a.type(f.key === 'exchange-plan' ? '（修訂）' : ' (revised)');
    },
    capture: (f) => [spot(f, 'heading')],
  },
  {
    id: 'docx-type-list-item',
    rows: ['docx.edit.typing', 'docx.edit.lists'],
    fixtures: ['book-30p'],
    summary: 'a bulleted list item gains text',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'listItem'));
      await d.step('A', 'type');
      await a.type(' recorder');
    },
    capture: (f) => [spot(f, 'listItem')],
  },
  {
    id: 'docx-type-empty-paragraph',
    rows: ['docx.edit.typing'],
    fixtures: ['exchange-plan'],
    summary: 'the empty paragraph after the title gets text',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'title'));
      await a.press('End');
      await a.press('ArrowDown');
      await a.press('Home');
      await d.step('A', 'type');
      await a.type('新段落');
    },
    capture: () => ['新段落'],
  },
  {
    id: 'docx-ime',
    rows: ['docx.edit.typing'],
    fixtures: ['book-30p'],
    summary: 'IME composition commits 日本語 into a paragraph',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'mid'));
      await d.step('A', 'ime', '日本語');
      await a.ime('日本語');
    },
    capture: (f) => [spot(f, 'mid')],
  },
  {
    id: 'docx-enter-new-paragraph',
    rows: ['docx.edit.typing'],
    fixtures: ['book-30p', 'exchange-plan'],
    summary: 'a new paragraph "A new paragraph from the recorder." is inserted after para1',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'para1'));
      await a.press('End');
      await d.step('A', 'enter');
      await a.press('Enter');
      await d.step('A', 'type');
      await a.type('A new paragraph from the recorder.');
    },
    capture: (f) => [spot(f, 'para1'), 'A new paragraph from the recorder.'],
  },
  {
    id: 'docx-enter-split',
    rows: ['docx.edit.typing'],
    fixtures: ['book-30p', 'exchange-plan'],
    summary: 'para2 is split in two at the caret (no text added)',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'para2'));
      await d.step('A', 'enter');
      await a.press('Enter');
    },
    capture: (f) => [spot(f, 'para2')],
  },
  {
    id: 'docx-backspace-merge',
    rows: ['docx.edit.typing'],
    fixtures: ['book-30p', 'exchange-plan'],
    summary: 'para2 is joined onto para1 (para1 updated, para2 deleted)',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'para2'), 'start');
      await a.press('Home');
      await d.step('A', 'backspace');
      await a.press('Backspace');
    },
    capture: (f) => [spot(f, 'para1')],
  },
  {
    id: 'docx-delete-merge',
    rows: ['docx.edit.typing'],
    fixtures: ['book-30p'],
    summary: 'para3 is joined onto para2 by Delete at the end of para2',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'para2'));
      await a.press('End');
      await d.step('A', 'delete');
      await a.press('Delete');
    },
    capture: (f) => [spot(f, 'para2')],
  },
  {
    id: 'docx-delete-cross-paragraph',
    rows: ['docx.edit.typing'],
    fixtures: ['book-30p', 'exchange-plan'],
    summary: 'from inside para1 to inside para3 deleted: para1 keeps its head and takes the tail of para3; para2 and para3 deleted',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'para1'));
      await d.step('A', 'shift-click', `end of "${spot(f, 'para3')}"`);
      await a.click(spot(f, 'para3'), { at: 'end', shift: true });
      await d.step('A', 'delete');
      await a.press('Delete');
    },
    capture: (f) => [spot(f, 'para1')],
  },
  {
    id: 'docx-delete-paragraph',
    rows: ['docx.edit.typing'],
    fixtures: ['book-30p'],
    summary: 'para2 is deleted whole (with its paragraph mark)',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'para2'), 'start');
      await d.step('A', 'drag-select', 'to the start of para3');
      await a.click(spot(f, 'para3'), { at: 'start', shift: true });
      await d.step('A', 'delete');
      await a.press('Delete');
    },
    capture: (f) => [spot(f, 'para1'), spot(f, 'para3')],
  },
  {
    id: 'docx-replace-word',
    rows: ['docx.edit.typing'],
    fixtures: ['book-30p'],
    summary: 'the word "enzyme" in para1 is replaced by "catalyst"',
    async run(d, f) {
      const a = d.peer();
      await d.step('A', 'dblclick', spot(f, 'word'));
      await a.click(spot(f, 'word'), { at: 2, count: 2 });
      await d.step('A', 'type', 'catalyst');
      await a.type('catalyst');
    },
    capture: () => ['catalyst'],
  },
  {
    id: 'docx-delete-word',
    rows: ['docx.edit.typing'],
    fixtures: ['book-30p'],
    summary: 'the word "enzyme" in para1 is deleted',
    async run(d, f) {
      const a = d.peer();
      await d.step('A', 'dblclick', spot(f, 'word'));
      await a.click(spot(f, 'word'), { at: 2, count: 2 });
      await d.step('A', 'backspace');
      await a.press('Backspace');
    },
    capture: (f) => [spot(f, 'para1')],
  },
  {
    id: 'docx-undo-typing',
    rows: ['docx.edit.undo'],
    fixtures: ['book-30p'],
    summary: 'typed text is undone: no net change',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'mid'));
      await d.step('A', 'type', ' undo me');
      await a.type(' undo me');
      await d.wait(700);
      await d.step('A', 'undo');
      await a.press('ControlOrMeta+z');
    },
    capture: (f) => [spot(f, 'mid')],
  },
  {
    id: 'docx-undo-redo',
    rows: ['docx.edit.undo'],
    fixtures: ['book-30p'],
    summary: 'typed text undone then redone: the paragraph gains " redo me"',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'mid'));
      await d.step('A', 'type', ' redo me');
      await a.type(' redo me');
      await d.wait(700);
      await d.step('A', 'undo');
      await a.press('ControlOrMeta+z');
      await d.wait(300);
      await d.step('A', 'redo');
      await a.press('ControlOrMeta+Shift+z');
    },
    capture: (f) => [spot(f, 'mid')],
  },
  {
    id: 'docx-undo-cross-paragraph',
    rows: ['docx.edit.undo'],
    fixtures: ['book-30p'],
    summary: 'a cross-paragraph delete is undone: no net change',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'para1'));
      await a.click(spot(f, 'para3'), { at: 'end', shift: true });
      await d.step('A', 'delete');
      await a.press('Delete');
      await d.wait(700);
      await d.step('A', 'undo');
      await a.press('ControlOrMeta+z');
    },
    capture: (f) => [spot(f, 'para1'), spot(f, 'para2')],
  },
  {
    id: 'docx-paste-plain',
    rows: ['docx.edit.clipboard'],
    fixtures: ['book-30p'],
    summary: `para1 gains " ${LINE}"`,
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'para1'));
      await d.step('A', 'paste', LINE);
      await a.paste(` ${LINE}`);
    },
    capture: (f) => [spot(f, 'para1')],
  },
  {
    id: 'docx-paste-multi-paragraph',
    rows: ['docx.edit.clipboard'],
    fixtures: ['book-30p', 'exchange-plan'],
    summary: 'six pasted paragraphs split the caret paragraph (caret paragraph updated, five inserted)',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'mid'));
      await d.step('A', 'paste', '6 paragraphs');
      await a.paste(PARAGRAPHS(6));
    },
    capture: (f) => [spot(f, 'mid'), 'Recorder paste paragraph 6'],
  },
  {
    id: 'docx-paste-large',
    rows: ['docx.edit.clipboard'],
    fixtures: ['book-30p'],
    summary: 'forty pasted paragraphs (~10 KB) after para1',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'para1'));
      await a.press('End');
      await a.press('Enter');
      await d.step('A', 'paste', '40 paragraphs');
      await a.paste(PARAGRAPHS(40));
    },
    capture: () => ['Recorder paste paragraph 1:', 'Recorder paste paragraph 40'],
  },
  {
    id: 'docx-paste-over-selection',
    rows: ['docx.edit.clipboard'],
    fixtures: ['book-30p'],
    summary: 'the selected start of para2 is replaced by the pasted line',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'para2'), 'start');
      await a.click(spot(f, 'para2'), { at: 'end', shift: true });
      await d.step('A', 'paste', LINE);
      await a.paste(LINE);
    },
    capture: () => [LINE],
  },
  {
    id: 'docx-cut',
    rows: ['docx.edit.clipboard'],
    fixtures: ['book-30p'],
    summary: 'the selected start of para2 is cut',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'para2'), 'start');
      await a.click(spot(f, 'para2'), { at: 'end', shift: true });
      await d.wait(600);
      await d.step('A', 'cut');
      await a.press('ControlOrMeta+x');
    },
    capture: (f) => [spot(f, 'para1')],
  },
  {
    id: 'docx-bold',
    rows: ['docx.edit.character'],
    fixtures: ['book-30p'],
    summary: 'the word "enzyme" becomes bold (formatting only)',
    async run(d, f) {
      const a = d.peer();
      await a.click(spot(f, 'word'), { at: 2, count: 2 });
      await d.step('A', 'bold');
      await a.press('ControlOrMeta+b');
    },
  },
  {
    id: 'docx-strike-super-sub',
    rows: ['docx.edit.character'],
    fixtures: ['book-30p'],
    summary: 'strikethrough, superscript and subscript on parts of para1 (formatting only)',
    async run(d, f) {
      const a = d.peer();
      // Keyboard selections: one word of each of para1, para2, para3.
      for (const [name, menu] of [['para1', 'strikethrough'], ['para2', 'superscript'], ['para3', 'subscript']] as const) {
        await at(d, a, spot(f, name), 'start');
        await a.press('Shift+ArrowRight', 6);
        await d.step('A', 'menu', menu);
        await a.menu(menu);
      }
    },
  },
  {
    id: 'docx-clear-formatting',
    rows: ['docx.edit.clear'],
    fixtures: ['comprehensive'],
    summary: 'clear formatting on the formatted run paragraph (formatting only)',
    async run(d) {
      const a = d.peer();
      await a.click('Bold, italic', { at: 'start' });
      await a.click('double strike', { at: 'end', shift: true });
      await d.step('A', 'menu', 'clearFormatting');
      await a.menu('clearFormatting');
    },
  },
  {
    id: 'docx-align-indent',
    rows: ['docx.edit.paragraph'],
    fixtures: ['book-30p'],
    summary: 'para1 centred and para2 indented (paragraph properties only)',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'para1'));
      await d.step('A', 'menu', 'align:center');
      await a.menu('align:center');
      await at(d, a, spot(f, 'para2'));
      await d.step('A', 'menu', 'indent');
      await a.menu('indent');
    },
  },
  {
    id: 'docx-rtl',
    rows: ['docx.view.rtl'],
    fixtures: ['book-30p'],
    summary: 'para1 set right-to-left (paragraph property only)',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'para1'));
      await d.step('A', 'menu', 'rtl');
      await a.menu('rtl');
    },
  },
  {
    id: 'docx-rtl-type',
    rows: ['docx.view.rtl'],
    fixtures: ['comprehensive'],
    summary: 'the Arabic paragraph gains typed Arabic text',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'arabic'));
      await d.step('A', 'type', ' نص');
      await a.type(' نص');
    },
    capture: (f) => [spot(f, 'arabic')],
  },
  {
    id: 'docx-list-toggle',
    rows: ['docx.edit.lists'],
    fixtures: ['book-30p'],
    summary: 'bullets on para1, numbers on para2, bullets off on a list item (list properties only)',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'para1'));
      await d.step('A', 'menu', 'bulletList');
      await a.menu('bulletList');
      await at(d, a, spot(f, 'para2'));
      await d.step('A', 'menu', 'numberedList');
      await a.menu('numberedList');
      await at(d, a, spot(f, 'listItem'));
      await d.step('A', 'menu', 'bulletList (off)');
      await a.menu('bulletList');
    },
  },
  {
    id: 'docx-list-enter',
    rows: ['docx.edit.lists'],
    fixtures: ['book-30p'],
    summary: 'a new list item "Recorder item" after the last item; a second Enter on an empty item ends the list',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'listLast'));
      await a.press('End');
      await d.step('A', 'enter');
      await a.press('Enter');
      await d.step('A', 'type');
      await a.type('Recorder item');
      await d.step('A', 'enter x2');
      await a.press('Enter');
      await a.press('Enter');
    },
    capture: () => ['Recorder item'],
  },
  {
    id: 'docx-list-indent',
    rows: ['docx.edit.lists'],
    fixtures: ['book-30p'],
    summary: 'a list item moves to level 2 (list level only)',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'listItem'), 'start');
      // Tab only moves between table cells here; the indent button (Format > Indent) changes the level.
      await d.step('A', 'menu', 'indent');
      await a.menu('indent');
    },
  },
  {
    id: 'docx-style-heading',
    rows: ['docx.edit.styles'],
    fixtures: ['book-30p'],
    summary: 'para1 becomes Heading 1 (style only)',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'para1'));
      await d.step('A', 'menu', 'style:Heading1');
      await a.menu('style:Heading1');
    },
  },
  {
    id: 'docx-replace-all',
    rows: ['docx.edit.find'],
    fixtures: ['book-30p'],
    summary: 'every "Amazon" becomes "Nile" (33 occurrences in many paragraphs)',
    async run(d) {
      const a = d.peer();
      await at(d, a, 'Having act office', 'start');
      await d.step('A', 'replace-all', 'Amazon -> Nile');
      await a.replaceAll('Amazon', 'Nile');
    },
    capture: () => ['Nile'],
  },
  {
    id: 'docx-view-tools',
    rows: ['docx.edit.view_tools'],
    fixtures: ['book-30p'],
    summary: 'ruler and outline toggled: no change',
    expectNoUpdates: true,
    async run(d) {
      const a = d.peer();
      await d.step('A', 'menu', 'show-ruler, show-outline');
      await a.menu('show-ruler');
      await a.menu('show-outline');
      await a.menu('show-outline');
      await a.menu('show-ruler');
    },
  },
  {
    id: 'docx-table-insert',
    rows: ['docx.edit.tables'],
    fixtures: ['book-30p', 'exchange-plan'],
    summary: 'a 2x3 table is inserted after para1 and its first cell gets "cell one"',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'para1'));
      await a.press('End');
      await a.press('Enter');
      await d.step('A', 'menu', 'insert-table 2x3');
      await a.menu('insert-table', '2x3');
      await d.step('A', 'type', 'cell one');
      await a.type('cell one');
    },
    capture: () => ['cell one'],
  },
  {
    id: 'docx-table-cell-type',
    rows: ['docx.edit.tables'],
    fixtures: ['exchange-plan', 'comprehensive'],
    summary: 'an existing table cell gains text',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'cell'));
      await d.step('A', 'type');
      await a.type(f.key === 'exchange-plan' ? '（新）' : ' (new)');
    },
    capture: (f) => [spot(f, 'cell')],
  },
  {
    id: 'docx-table-cell-clear',
    rows: ['docx.edit.tables'],
    fixtures: ['exchange-plan'],
    summary: 'the text of one cell is deleted',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'cell'), 'start');
      await a.click(spot(f, 'cell'), { at: 'end', shift: true });
      await d.step('A', 'delete');
      await a.press('Delete');
    },
  },
  ...(
    [
      ['docx-table-row-insert', 'Insert row below', 'a row is added below the 友邦保險 row'],
      ['docx-table-row-insert-above', 'Insert row above', 'a row is added above the 友邦保險 row'],
      ['docx-table-row-delete', 'Delete row', 'the 友邦保險 row and its text are removed'],
      ['docx-table-col-insert', 'Insert column right', 'a column is added right of the 價錢 column'],
      ['docx-table-col-delete', 'Delete column', 'the 價錢 column and its text are removed'],
      ['docx-table-delete', 'Delete table', 'the insurer price table is removed'],
    ] as const
  ).map(
    ([id, label, summary]): Case => ({
      id,
      rows: ['docx.edit.tables'],
      fixtures: ['exchange-plan'],
      summary,
      async run(d, f) {
        const a = d.peer();
        const needle = label.includes('column') ? spot(f, 'headerCell') : spot(f, 'cell');
        await d.step('A', 'context-menu', `${label} at "${needle}"`);
        await a.click(needle, { at: 1, button: 'right' });
        await a.clickRole('menuitem', label);
      },
    })
  ),
  {
    id: 'docx-table-merge-split',
    rows: ['docx.edit.tables'],
    fixtures: ['comprehensive'],
    summary: 'Header A and Header B cells merged (table changed, texts joined)',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'cell'), 'start');
      await a.click(spot(f, 'cell2'), { at: 'end', shift: true });
      await d.step('A', 'context-menu', 'Merge cells');
      await a.click(spot(f, 'cell2'), { at: 2, button: 'right' });
      await a.clickRole('menuitem', 'Merge cells');
    },
  },
  {
    id: 'docx-image-insert',
    rows: ['docx.edit.pictures'],
    fixtures: ['book-30p', 'exchange-plan'],
    summary: 'a 64x48 red PNG is inserted at the end of para1',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'para1'));
      await a.press('End');
      await d.step('A', 'menu-file', 'insert-image red-64x48.png');
      await a.pickFile('insert-image', 'red-64x48.png', 'image/png');
    },
  },
  {
    id: 'docx-image-delete',
    rows: ['docx.edit.pictures'],
    fixtures: ['exchange-plan'],
    summary: 'the first picture is deleted',
    async run(d) {
      const a = d.peer();
      await d.step('A', 'click', 'picture above caption 圖片一');
      await a.clickImage('圖片一');
      await d.step('A', 'delete');
      await a.press('Delete');
    },
  },
  {
    id: 'docx-image-replace',
    rows: ['docx.edit.pictures'],
    fixtures: ['exchange-plan'],
    summary: 'the first picture is deleted and a blue PNG inserted in its place',
    async run(d) {
      const a = d.peer();
      await d.step('A', 'click', 'picture above caption 圖片一');
      await a.clickImage('圖片一');
      await d.step('A', 'delete');
      await a.press('Delete');
      await d.step('A', 'menu-file', 'insert-image blue-80x60.png');
      await a.pickFile('insert-image', 'blue-80x60.png', 'image/png');
    },
  },
  {
    id: 'docx-comment-add',
    rows: ['docx.edit.comments'],
    fixtures: ['book-30p'],
    summary: 'a comment "Recorder comment" on the start of para1 (no body text change)',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'para1'), 'start');
      await a.click(spot(f, 'para1'), { at: 'end', shift: true });
      await d.step('A', 'menu', 'insert-comment');
      await a.menu('insert-comment');
      await d.step('A', 'type', 'Recorder comment');
      await a.type('Recorder comment');
      await a.press('ControlOrMeta+Enter');
    },
  },
  {
    id: 'docx-review-accept-insertion',
    rows: ['docx.edit.review'],
    fixtures: ['comprehensive'],
    summary: 'the tracked insertion "an inserted phrase" in p62 is accepted (text stays, mark goes)',
    async run(d) {
      const a = d.peer();
      await d.step('A', 'review', 'accept first change');
      await a.review('accept', 0);
    },
  },
  {
    id: 'docx-review-reject-deletion',
    rows: ['docx.edit.review'],
    fixtures: ['comprehensive'],
    summary: 'the tracked deletion in p62 is rejected (deleted words come back as plain text)',
    async run(d) {
      const a = d.peer();
      await d.step('A', 'review', 'reject second change');
      await a.review('reject', 1);
    },
  },
  {
    id: 'docx-review-accept-all',
    rows: ['docx.edit.review'],
    fixtures: ['comprehensive'],
    summary: 'Accept all: the deleted words leave p62, insertions stay',
    async run(d) {
      const a = d.peer();
      await d.step('A', 'review', 'Accept all');
      await a.review('acceptAll');
    },
  },
  {
    id: 'docx-review-reject-all',
    rows: ['docx.edit.review'],
    fixtures: ['comprehensive'],
    summary: 'Reject all: the inserted phrase leaves p62, deleted words stay',
    async run(d) {
      const a = d.peer();
      await d.step('A', 'review', 'Reject all');
      await a.review('rejectAll');
    },
  },
  {
    id: 'docx-header-type',
    rows: ['docx.edit.headers'],
    fixtures: ['comprehensive'],
    summary: 'adds " (recorded)" at the end of the default header',
    async run(d, f) {
      const a = d.peer();
      await d.step('A', 'dblclick', 'header');
      await a.openHeaderFooter(spot(f, 'header'), 'header');
      await d.step('A', 'type');
      await a.type(' (recorded)');
      await a.press('Escape');
    },
  },

  {
    id: 'docx-footer-type',
    rows: ['docx.edit.headers'],
    fixtures: ['comprehensive', 'exchange-plan'],
    summary: 'adds " (recorder footer)" to the footer',
    async run(d, f) {
      const a = d.peer();
      await d.step('A', 'dblclick', 'footer');
      await a.openHeaderFooter(f.key === 'comprehensive' ? 'Page ' : spot(f, 'footer'), 'footer');
      await d.step('A', 'type');
      await a.type(' (recorder footer)');
      await a.press('Escape');
    },
  },

  {
    id: 'docx-page-break',
    rows: ['docx.edit.breaks'],
    fixtures: ['book-30p', 'exchange-plan'],
    summary: 'a page break splits para2 (text unchanged)',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'para2'));
      await d.step('A', 'menu', 'insert-page-break');
      await a.menu('insert-page-break');
    },
  },
  {
    id: 'docx-section-break',
    rows: ['docx.edit.breaks', 'docx.view.sections'],
    fixtures: ['book-30p'],
    summary: 'a next-page section break after para1 (text unchanged)',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'para1'));
      await a.press('End');
      await d.step('A', 'menu', 'insert-section-next');
      await a.menu('insert-section-next');
    },
  },
  {
    id: 'docx-toc-insert',
    rows: ['docx.edit.toc'],
    fixtures: ['book-30p'],
    summary: 'a table of contents is inserted before the first heading',
    async run(d) {
      const a = d.peer();
      await at(d, a, 'Chapter 1: Necessary', 'start');
      await a.press('Home');
      await d.step('A', 'menu', 'insert-toc');
      await a.menu('insert-toc');
    },
  },
  {
    id: 'docx-toc-update',
    rows: ['docx.edit.toc'],
    fixtures: ['comprehensive'],
    summary: 'heading 1 renamed, then Update table of contents rewrites its TOC entry',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'heading'), 'end');
      await a.click(spot(f, 'heading'), { at: 'end', occurrence: 1 });
      await d.step('A', 'type', ' and more');
      await a.type(' and more');
      await d.step('A', 'menu', 'update-toc');
      await a.menu('update-toc');
    },
  },
  {
    id: 'docx-control-type',
    rows: ['docx.edit.controls'],
    fixtures: ['comprehensive'],
    summary: 'p67 "Inline control: Draft." gains " v2" just before its final period (the end of the inline content control)',
    async run(d) {
      const a = d.peer();
      await at(d, a, 'Inline control:', 'start');
      await d.step('A', 'keys', 'End, ArrowLeft');
      await a.press('End');
      await a.press('ArrowLeft');
      await d.step('A', 'type', ' v2');
      await a.type(' v2');
    },
    capture: () => ['Inline control'],
  },

  {
    id: 'docx-textbox-type',
    rows: ['docx.view.shapes'],
    fixtures: ['comprehensive'],
    summary: 'the text box story "A wrapped-square shape with its own story." gains " boxed"',
    blocked:
      'driver: clicks and double clicks inside the floating (wrap-square) text box put the caret in its host body paragraph, so the typed text landed in the body, not the text-box story; no text-box edit was recorded',
    async run(d, f) {
      const a = d.peer();
      // A text box opens for typing on a double click, as a header does.
      await d.step('A', 'dblclick', 'text box');
      await a.click(spot(f, 'textbox'), { at: 3, count: 2, scope: 'any' });
      await d.wait(600);
      await a.click(spot(f, 'textbox'), { at: 'end', scope: 'any' });
      await d.step('A', 'type', ' boxed');
      await a.type(' boxed');
    },
  },

  {
    id: 'docx-footnote-type',
    rows: ['docx.view.notes'],
    fixtures: ['comprehensive'],
    summary: 'the footnote gains " Recorded."',
    async run(d, f) {
      const a = d.peer();
      await d.step('A', 'click', 'footnote');
      await a.click(spot(f, 'footnote'), { at: 'end', scope: 'notes' });
      await d.step('A', 'type');
      await a.type(' Recorded.');
    },
  },
  {
    id: 'docx-endnote-type',
    rows: ['docx.view.notes'],
    fixtures: ['comprehensive'],
    summary: 'the endnote gains " Recorded."',
    async run(d, f) {
      const a = d.peer();
      await d.step('A', 'click', 'endnote');
      await a.click(spot(f, 'endnote'), { at: 'end', scope: 'any' });
      await d.step('A', 'type');
      await a.type(' Recorded.');
    },
  },
  {
    id: 'docx-field-adjacent',
    rows: ['docx.view.fields'],
    fixtures: ['comprehensive'],
    summary: 'p58 gains text right after the PAGE field result',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'field'));
      await a.press('ArrowRight', 2);
      await d.step('A', 'type', ' (typed)');
      await a.type(' (typed)');
    },
    capture: (f) => [spot(f, 'field')],
  },
  {
    id: 'docx-field-delete',
    rows: ['docx.view.fields'],
    fixtures: ['comprehensive'],
    summary: 'the DATE field result "2026" is selected and deleted',
    async run(d, f) {
      const a = d.peer();
      await at(d, a, spot(f, 'fieldDate'));
      await a.press('Shift+End');
      await d.step('A', 'delete');
      await a.press('Delete');
    },
    capture: (f) => [spot(f, 'field')],
  },
  {
    id: 'docx-download',
    rows: ['docx.save.download'],
    fixtures: ['book-30p'],
    summary: 'File > Download: Capy exports; nothing changes',
    expectNoUpdates: true,
    async run(d) {
      await d.step('A', 'export');
      await d.exportFile('A');
    },
  },
  {
    id: 'docx-2p-same-paragraph',
    rows: ['docx.edit.typing'],
    fixtures: ['book-30p'],
    peers: ['A', 'B'],
    summary: 'A types " alpha" after "Having act office" and B types " beta" after "became under" in the same paragraph at once',
    async run(d) {
      const [a, b] = [d.peer('A'), d.peer('B')];
      await d.hold();
      await at(d, a, 'Having act office');
      await at(d, b, 'became under');
      await d.step('A', 'type', ' alpha');
      await a.type(' alpha');
      await d.step('B', 'type', ' beta');
      await b.type(' beta');
      await d.release();
    },
    capture: () => ['Having act office'],
  },
  {
    id: 'docx-2p-split-vs-type',
    rows: ['docx.edit.typing'],
    fixtures: ['book-30p'],
    peers: ['A', 'B'],
    summary: 'A presses Enter mid para2 while B types near its end',
    async run(d, f) {
      const [a, b] = [d.peer('A'), d.peer('B')];
      await d.hold();
      await at(d, a, spot(f, 'para2'));
      await at(d, b, 'protein same just');
      await d.step('A', 'enter');
      await a.press('Enter');
      await d.step('B', 'type', ' gamma');
      await b.type(' gamma');
      await d.release();
    },
    capture: () => ['gamma'],
  },
  {
    id: 'docx-2p-double-enter',
    rows: ['docx.edit.typing'],
    fixtures: ['book-30p'],
    peers: ['A', 'B'],
    summary: 'A and B both press Enter at the same point of para2 (two new paragraphs; duplicate ids renamed)',
    async run(d, f) {
      const [a, b] = [d.peer('A'), d.peer('B')];
      await d.hold();
      await at(d, a, spot(f, 'para2'));
      await at(d, b, spot(f, 'para2'));
      await d.step('A', 'enter');
      await a.press('Enter');
      await d.step('B', 'enter');
      await b.press('Enter');
      await d.release();
    },
  },
  {
    id: 'docx-2p-delete-vs-type',
    rows: ['docx.edit.typing'],
    fixtures: ['book-30p'],
    peers: ['A', 'B'],
    summary: 'A deletes from inside para1 to inside para2 while B types inside para2',
    async run(d, f) {
      const [a, b] = [d.peer('A'), d.peer('B')];
      await d.hold();
      await at(d, a, spot(f, 'para1'));
      await a.click(spot(f, 'para2'), { at: 'end', shift: true });
      await at(d, b, 'derivative city');
      await d.step('A', 'delete');
      await a.press('Delete');
      await d.step('B', 'type', ' delta');
      await b.type(' delta');
      await d.release();
    },
    capture: () => ['delta'],
  },
  {
    id: 'docx-2p-table-rows',
    rows: ['docx.edit.tables'],
    fixtures: ['exchange-plan'],
    peers: ['A', 'B'],
    summary: 'A and B each insert a row in the insurer table at once (one insert is lost by design)',
    async run(d, f) {
      const [a, b] = [d.peer('A'), d.peer('B')];
      await d.hold();
      await d.step('A', 'context-menu', 'Insert row below');
      await a.click(spot(f, 'cell'), { at: 1, button: 'right' });
      await a.clickRole('menuitem', 'Insert row below');
      await d.step('B', 'context-menu', 'Insert row above');
      await b.click(spot(f, 'cell'), { at: 1, button: 'right' });
      await b.clickRole('menuitem', 'Insert row above');
      await d.release();
    },
  },
  {
    id: 'docx-2p-two-stories',
    rows: ['docx.edit.headers'],
    fixtures: ['comprehensive'],
    peers: ['A', 'B'],
    summary: 'A types in the body while B types in the default header',
    async run(d, f) {
      const [a, b] = [d.peer('A'), d.peer('B')];
      await at(d, a, spot(f, 'mid'));
      await d.step('A', 'type', ' body edit');
      await a.type(' body edit');
      await d.step('B', 'dblclick', 'header');
      await b.openHeaderFooter(spot(f, 'header'), 'header');
      await d.step('B', 'type', ' header edit');
      await b.type(' header edit');
      await b.press('Escape');
    },
  },
  {
    id: 'docx-2p-undo-own',
    rows: ['docx.edit.undo'],
    fixtures: ['book-30p'],
    peers: ['A', 'B'],
    summary: 'A types, B types, A undoes: only B\'s text remains',
    async run(d, f) {
      const [a, b] = [d.peer('A'), d.peer('B')];
      await at(d, a, spot(f, 'para1'));
      await d.step('A', 'type', ' from A');
      await a.type(' from A');
      await d.wait(700);
      await at(d, b, spot(f, 'para3'));
      await d.step('B', 'type', ' from B');
      await b.type(' from B');
      await d.wait(700);
      await d.step('A', 'undo');
      await a.focus();
      await a.press('ControlOrMeta+z');
    },
    capture: () => ['from B'],
  },
];

const noop = async () => {};

/** Edit features no user can reach through Capy at this pin (edit-cases.md). */
const BLOCKED: Case[] = [
  {
    id: 'docx-track-changes-on',
    rows: ['docx.edit.review'],
    fixtures: ['book-30p'],
    summary: 'type with tracked changes on (suggesting mode)',
    blocked: "Capy's DocxEditorHost never passes `mode`, so the editor is always 'editing'; users cannot create tracked changes",
    run: noop,
  },
  {
    id: 'docx-footnote-insert',
    rows: ['docx.view.notes', 'docx.edit.other_refs'],
    fixtures: ['comprehensive'],
    summary: 'insert a new footnote',
    blocked: 'no command inserts a footnote or endnote (parity notes); existing notes are edited in docx-footnote-type / docx-endnote-type',
    run: noop,
  },
  {
    id: 'docx-control-checkbox',
    rows: ['docx.edit.controls'],
    fixtures: ['comprehensive'],
    summary: 'toggle a check-box content control',
    blocked: 'no committed fixture has a check-box control (the comprehensive file has a rich-text and an inline text control, typed into in docx-control-type)',
    run: noop,
  },
  {
    id: 'docx-header-page-number',
    rows: ['docx.edit.headers'],
    fixtures: ['comprehensive'],
    summary: 'insert a page number in a header',
    blocked: 'the header Options menu offers only Remove: no onInsertField reaches InlineHeaderFooterEditor and no engine op inserts PAGE/NUMPAGES (parity notes)',
    run: noop,
  },
];

export const CASES: Case[] = [...DOCX, ...PPTX, ...XLSX, ...MORE, ...BLOCKED];
