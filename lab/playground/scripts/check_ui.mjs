// Run with node lab/playground/scripts/check_ui.mjs. No server or browser needed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const elements = new Map();
const pending = [];
const makeElement = () => ({
  value: '',
  textContent: '',
  options: [],
  children: [],
  dataset: {},
  appendChild(child) { this.children.push(child); },
  showModal() { this.open = true; },
  close() { this.open = false; },
});
const element = (id) => {
  if (!elements.has(id))
    elements.set(id, makeElement());
  return elements.get(id);
};
const context = vm.createContext({
  document: { getElementById: element, createElement: makeElement },
  AbortController,
  TextDecoder,
  URL,
  console,
  fetch: (url, options) =>
    new Promise((resolve) => pending.push({ url, options, resolve })),
});
const html = readFileSync(new URL('./ui.html', import.meta.url), 'utf8');
const script = html
  .match(/<script>([\s\S]*)<\/script>/)[1]
  .replace(/loadState\(\);\s*$/, '');
vm.runInContext(script, context);
vm.runInContext(
  "state = {defaults: {model: {}}, quality_files: [], target: 'local'}",
  context
);
const configure = (config) =>
  vm.runInContext(`setConfig(${JSON.stringify(config)})`, context);
const resolvePreview = async (index, prompt) => {
  const request = pending.filter((p) => p.url === '/api/prompt')[index];
  const config = JSON.parse(request.options.body);
  const toolPrompts = {
    search_knowledge: 'Production search',
    browse_knowledge: 'Production browse',
  };
  request.resolve({
    ok: true,
    json: async () => ({
      prompt,
      tool_prompts: toolPrompts,
      tools: Object.entries(toolPrompts).map(([name, description]) => ({
        function: {
          name,
          description: config.tool_descriptions?.[name] ?? description,
        },
      })),
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
};
const type = (id, value) => {
  element(id).value = value;
  element(id).oninput?.();
};

// An older request finishing after Apply must not replace the applied text.
configure({ system_prompt: null });
type('prompt', 'My exact system prompt\n第二行');
element('applyPrompt').onclick();
await resolvePreview(1, 'My exact system prompt\n第二行');
await resolvePreview(0, 'Old production prompt');
assert.equal(element('prompt').value, 'My exact system prompt\n第二行');
assert.equal(
  JSON.parse(element('json').value).system_prompt,
  element('prompt').value
);

// Both typing during a request and a subsequent config refresh preserve drafts.
configure({ system_prompt: 'Applied text' });
type('prompt', 'Unapplied system draft');
await resolvePreview(2, 'Applied text');
assert.equal(element('prompt').value, 'Unapplied system draft');
configure({ system_prompt: 'Applied text', locale: 'zh' });
await resolvePreview(3, 'Applied text');
assert.equal(element('prompt').value, 'Unapplied system draft');
element('resetPrompt').onclick();
await resolvePreview(4, 'Production prompt');
assert.equal(element('prompt').value, 'Production prompt');

// Tool drafts survive switching tools and late previews; Apply and Reset update JSON.
element('toolName').value = 'search_knowledge';
element('toolName').onchange();
type('toolPrompt', 'My search instructions');
element('toolName').value = 'browse_knowledge';
element('toolName').onchange();
element('toolName').value = 'search_knowledge';
element('toolName').onchange();
assert.equal(element('toolPrompt').value, 'My search instructions');
configure(JSON.parse(element('json').value));
await resolvePreview(5, 'Production prompt');
assert.equal(element('toolPrompt').value, 'My search instructions');
element('applyToolPrompt').onclick();
assert.equal(
  JSON.parse(element('json').value).tool_descriptions.search_knowledge,
  'My search instructions'
);
await resolvePreview(6, 'Production prompt');
assert.equal(
  JSON.parse(element('toolsJson').textContent)[0].function.description,
  'My search instructions'
);
element('resetToolPrompt').onclick();
await resolvePreview(7, 'Production prompt');
assert.equal(
  JSON.parse(element('json').value).tool_descriptions.search_knowledge,
  undefined
);
assert.equal(element('toolPrompt').value, 'Production search');

// Save persists the applied config without reloading editors over newer drafts.
element('saveas').value = 'prompt-check';
type('prompt', 'System draft while saving');
const beforeSave = element('json').value;
const saving = element('save').onclick();
const saveRequest = pending.at(-1);
assert.equal(saveRequest.options.method, 'PUT');
assert.equal(saveRequest.options.body, beforeSave);
const requestsBeforeSaved = pending.length;
saveRequest.resolve({ ok: true });
await saving;
assert.equal(pending.length, requestsBeforeSaved);
assert.equal(element('json').value, beforeSave);
assert.equal(element('prompt').value, 'System draft while saving');

// Completed turns forward the production evidence and only the stored ledger.
const evidence = {
  tools: [{ name: 'create_material', text: 'Created note mat_1' }], passages: [],
  libraryExcerpts: [{ excerpt_id: 'exc_1', start: 0, section: 'Cells', text: 'Exact text read for this note.' }],
};
const storedLedger = {
  requests: ['Study cells'], next_todo_id: 2,
  todos: [{ id: 1, text: 'Make a quiz' }],
  materials: [{ id: 'mat_1', kind: 'note', title: 'Cells', size: '100 tokens', todo: 0 }],
};
const render = (event) => vm.runInContext(`render(${JSON.stringify(event)})`, context);
render({ type: 'ledger', stored: storedLedger, reads: [{ excerpt_id: 'exc_1' }] });
render({ type: 'done', answer: 'Created the note.', toolEvidence: evidence });
const submit = () => {
  element('question').value = 'Continue';
  const finished = element('run').onclick();
  const request = pending.at(-1);
  assert.equal(request.url, '/api/turn');
  request.resolve({ ok: true, body: { getReader: () => ({ read: async () => ({ done: true }) }) } });
  return { finished, body: JSON.parse(request.options.body) };
};
let turn = submit();
assert.deepEqual(turn.body.history.at(-1).toolEvidence, evidence);
assert.deepEqual(turn.body.ledger, storedLedger);
assert.equal(turn.body.ledger.reads, undefined);
await turn.finished;

// Opening a saved run restores its whole conversation without changing config.
const runCheckpoint = { throughMessageId: 'm0', summary: 'Earlier study goals', estimatedTokens: 10 };
const savedRun = {
  config: {}, question: 'Study cells', answer: 'Created the note.',
  history: [{ id: 'm1', role: 'user', content: 'Hello' }, { id: 'm2', role: 'assistant', content: 'What subject?' }],
  checkpoint_in: runCheckpoint,
  ledger: { stored: storedLedger },
  materials: [{ id: 'mat_1', kind: 'note', title: 'Cells', content: '# Cells\n<script>source text</script>', size: '100 tokens' }],
  events: [{ type: 'done', answer: 'Created the note.', toolEvidence: evidence }],
};
const configBeforeRestore = element('json').value;
const loading = element('runs').onclick({ target: { dataset: { run: 'saved' } }, preventDefault() {} });
assert.equal(pending.at(-1).url, '/api/runs/saved');
pending.at(-1).resolve({ json: async () => savedRun });
await loading;
assert.equal(element('json').value, configBeforeRestore);
const openMaterial = (id) => element('materials').onclick({
  target: { closest: () => ({ dataset: { material: encodeURIComponent(id) } }) },
});
openMaterial('mat_1');
assert.equal(element('materialDialog').open, true);
assert.equal(element('materialTitle').textContent, 'Cells');
assert.equal(element('materialContent').textContent, '# Cells\n<script>source text</script>');
assert.equal(JSON.parse(element('materialJson').textContent).id, 'mat_1');
element('closeMaterial').onclick();
assert.equal(element('materialDialog').open, false);
render({ type: 'material', id: 'quiz_1', kind: 'quiz', title: 'Cells quiz', questions: [
  { question: 'Which option?', options: ['First', { value: 'Second', explanation: 'Option explanation' }], answer: 'B', explanation: 'Answer explanation' },
] });
openMaterial('quiz_1');
assert.match(element('materialContent').textContent, /B\. Second\n   Option explanation/);
assert.match(element('materialContent').textContent, /Answer \(saved\): "B"\nExplanation: Answer explanation/);
render({ type: 'material', id: 'cards_1', kind: 'flashcards', title: 'Cells cards', cards: [{ front: 'Cell?', back: 'Unit of life' }] });
openMaterial('cards_1');
assert.match(element('materialContent').textContent, /Front: Cell\?\nBack: Unit of life/);
turn = submit();
assert.deepEqual(turn.body.history.map((m) => m.content), ['Hello', 'What subject?', 'Study cells', 'Created the note.']);
assert.equal(new Set(turn.body.history.map((m) => m.id)).size, 4);
assert.deepEqual(turn.body.history.at(-1).toolEvidence, evidence);
assert.deepEqual(turn.body.checkpoint, runCheckpoint);
assert.deepEqual(turn.body.ledger, storedLedger);
await turn.finished;

// Compaction trims only the folded prefix, and Clear removes conversation state.
render({ type: 'checkpoint', ...runCheckpoint, throughMessageId: 'm2', summary: 'Folded greeting' });
turn = submit();
assert.equal(turn.body.checkpoint.summary, 'Folded greeting');
assert.equal(turn.body.history[0].content, 'Study cells');
assert.ok(turn.body.history.some((m) => m.toolEvidence));
await turn.finished;
element('clear').onclick();
assert.equal(element('materialDialog').open, false);
assert.match(element('materials').innerHTML, /none yet/);
turn = submit();
assert.deepEqual(turn.body.history, []);
assert.equal(turn.body.checkpoint, null);
assert.equal(turn.body.ledger, null);
await turn.finished;
console.log('playground UI checks passed');
