/* One saved playground material as the app will show it, at
 * /preview/?run=<run id>&id=<material id>. A note's markdown goes through the
 * collaboration service's agent import (convertAgentMarkdown), so a note the
 * app would refuse says why. Where the app files each quiz and flashcards
 * fence as its own material behind a link card, the preview draws the
 * questions and cards in place. The app's read-only renderer (MaterialPreview,
 * static nodes, theme and styles) draws the result; interactive blocks run in
 * the app's sandboxed frame, served by the playground at /embed/. */
import { createRoot } from 'react-dom/client';
import '@/styles/tailwind.css';
import type { MaterialKind, Provenance, Question } from '@/api/types';
import { TooltipProvider } from '@/components/ui/Tooltip';
import {
  createMaterialDocument,
  flashcardsNode,
  flashcardsNodeFromFence,
  isMaterialRefElement,
  type MaterialDocument,
  type MaterialNode,
  quizNode,
  quizNodeFromFence,
} from '@/features/materials/document';
import { MaterialAttributionFooter } from '@/features/materials/MaterialAttributionFooter';
import { MaterialPreview } from '@/features/materials/MaterialPreview';
import { convertAgentMarkdown } from '@/features/notes/markdownConvert';
import { ThemeProvider } from '@/theme/ThemeProvider';

/** A material as the playground saves it (playground.py). */
type Saved = {
  id: string;
  kind: string;
  title: string;
  content?: string;
  questions?: Question[];
  cards?: { back: string; front: string }[];
  deck?: { slides: { brief: string; svg: string | null; title: string }[] };
  pptx?: string;
  provenance?: Provenance | null;
};

/** Each pending quiz or flashcards reference drawn in place; a fence the
 * app's question format refuses keeps its reference card and is named. */
function inlineFences(node: MaterialNode, problems: string[]): MaterialNode {
  if ('text' in node) return node;
  if (isMaterialRefElement(node) && typeof node.pending === 'string') {
    try {
      return node.refKind === 'quiz'
        ? quizNodeFromFence(node.pending)
        : flashcardsNodeFromFence(node.pending);
    } catch (error) {
      problems.push(`${node.refKind} fence: ${(error as Error).message}`);
      return node;
    }
  }
  return {
    ...node,
    children: node.children.map((child) => inlineFences(child, problems)),
  } as MaterialNode;
}

function documentFor(saved: Saved): {
  document: MaterialDocument | null;
  problems: string[];
} {
  const problems: string[] = [];
  try {
    if (saved.kind === 'quiz')
      return {
        document: createMaterialDocument([
          quizNode({ questions: saved.questions ?? [] }),
        ]),
        problems,
      };
    if (saved.kind === 'flashcards')
      return {
        document: createMaterialDocument([
          flashcardsNode((saved.cards ?? []).map((card) => ({ ...card, id: '' }))),
        ]),
        problems,
      };
    const { document } = convertAgentMarkdown(saved.content ?? '');
    return {
      document: createMaterialDocument(
        document.value.map(
          (node) => inlineFences(node, problems) as (typeof document.value)[number]
        )
      ),
      problems,
    };
  } catch (error) {
    return {
      document: null,
      problems: [`The app would refuse this: ${(error as Error).message}`],
    };
  }
}

/** Slides from the saved SVGs (figures inlined by the playground), with the
 * download once the deck is exported. */
function Deck({ run, saved }: { run: string; saved: Saved }) {
  const slides = saved.deck?.slides ?? [];
  return (
    <div className="mx-auto max-w-5xl px-5 pt-4 pb-16 sm:px-10">
      <p className="mb-6 text-fg-muted text-sm">
        {saved.pptx ? (
          <a className="underline" download href={`/api/${saved.pptx}`}>
            Download .pptx
          </a>
        ) : (
          'Not exported yet: the PPTX is written once every slide is.'
        )}{' '}
        The PPTX ends with a Sources slide built from the provenance.
      </p>
      <ol className="grid gap-6 sm:grid-cols-2">
        {slides.map((slide, i) => (
          <li className="grid gap-1" key={i}>
            {slide.svg ? (
              <img
                alt={slide.title}
                className="aspect-video w-full rounded-card border border-line"
                src={`/api/runs/${run}/slides/${saved.id}/${i + 1}.svg`}
              />
            ) : (
              <div className="grid aspect-video place-items-center rounded-card border border-line border-dashed text-fg-muted text-sm">
                not written
              </div>
            )}
            <p className="font-semibold text-sm">
              {i + 1}. {slide.title}
            </p>
            <p className="text-fg-muted text-xs">{slide.brief}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Preview({ run, saved }: { run: string; saved: Saved }) {
  if (saved.kind === 'deck') return <Deck run={run} saved={saved} />;
  const { document, problems } = documentFor(saved);
  return (
    <>
      {problems.map((problem) => (
        <p
          className="mx-5 mt-4 rounded-card border border-solid-error/30 p-3 text-solid-error text-sm"
          key={problem}
        >
          {problem}
        </p>
      ))}
      {document && (
        <MaterialPreview
          content={document}
          kind={saved.kind as MaterialKind}
          title={saved.title}
        />
      )}
      <MaterialAttributionFooter
        provenance={saved.provenance?.books ? saved.provenance : undefined}
      />
    </>
  );
}

const params = new URLSearchParams(location.search);
const run = params.get('run') ?? '';
const id = params.get('id') ?? '';
const root = createRoot(document.getElementById('root')!);
fetch(`/api/runs/${encodeURIComponent(run)}/materials/${encodeURIComponent(id)}.json`)
  .then((response) => {
    if (!response.ok) throw new Error(`material ${id} of run ${run}: ${response.status}`);
    return response.json() as Promise<Saved>;
  })
  .then((saved) => {
    document.title = saved.title;
    root.render(
      <ThemeProvider>
        <TooltipProvider>
          <Preview run={run} saved={saved} />
        </TooltipProvider>
      </ThemeProvider>
    );
  })
  .catch((error: Error) => root.render(<p className="p-5">{error.message}</p>));
