import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QuestionView } from '../../src/features/questions/QuestionView';
import { renderGraphSvg } from '../../src/features/questions/graph';
import type { Question } from '../../src/features/questions/types';
import { questionBlockSchema } from '../../src/features/questions/validation';
import '../../src/styles/tailwind.css';

const root = createRoot(document.getElementById('root')!);

declare global {
  interface Window {
    renderBankLearner: (question: Question) => Promise<void>;
    renderBankQuestion: (
      question: Question,
    ) => Promise<{ question: Question; assets: Record<string, string> }>;
  }
}

// MathPreview mounts MathLive asynchronously; a screenshot taken earlier drops formulas.
async function mathDrawn() {
  const deadline = performance.now() + 10_000;
  for (;;) {
    const pending = Array.from(
      document.querySelectorAll('[data-math-preview]'),
    ).filter((host) => {
      const field = host.querySelector('math-field');
      return field
        ? !field.shadowRoot?.querySelector('.ML__latex')?.childElementCount
        : !host.textContent;
    });
    if (!pending.length) return;
    if (performance.now() > deadline)
      throw new Error(`${pending.length} formulas did not render`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function display(question: Question, review: boolean) {
  flushSync(() =>
    root.render(
      <main
        key={question.id}
        className="mx-auto max-w-5xl bg-surface-bg p-8 text-fg"
      >
        <QuestionView question={question} review={review} />
      </main>,
    ),
  );
  for (const details of document.querySelectorAll('details'))
    details.open = true;
  await document.fonts.ready;
  await Promise.all(
    Array.from(document.images, (image) => image.decode()),
  );
  await mathDrawn();
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

window.renderBankLearner = async (input) => {
  const question = structuredClone(input);
  for (const part of question.parts) {
    if (part.answer.type !== 'ordering') continue;
    const ranked = await Promise.all(
      part.answer.items.map(async (text) => ({
        text,
        hash: Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(text),
            ),
          ),
          (value) => value.toString(16).padStart(2, '0'),
        ).join(''),
      })),
    );
    part.answer.items = ranked
      .sort((a, b) => a.hash.localeCompare(b.hash))
      .map((item) => item.text);
  }
  await display(question, false);
};

window.renderBankQuestion = async (input) => {
  const question = structuredClone(input);
  const assets: Record<string, string> = {};
  for (const blocks of [
    question.stem,
    ...question.parts.flatMap((part) => [part.blocks, part.solution]),
  ]) {
    for (const block of blocks) {
      if (block.type !== 'graph') continue;
      const host = document.createElement('div');
      host.style.width = `${block.width}px`;
      host.style.height = `${block.height}px`;
      document.body.append(host);
      try {
        const svg = await renderGraphSvg(host, block);
        const hash = Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(svg),
            ),
          ),
          (v) => v.toString(16).padStart(2, '0'),
        ).join('');
        assets[`${hash}.svg`] = svg;
        block.image = { svg };
        questionBlockSchema.parse(block);
      } finally {
        host.remove();
      }
    }
  }
  await display(question, true);
  return { question, assets };
};
