import { delay, HttpResponse, http } from 'msw';
import { EXTRACTION_PAGES_MAX } from '@/api/limits.generated';
import type {
  CreateExtractionReq,
  Extraction,
  ExtractionReport,
} from '@/api/types';
import type { Question } from '@/features/questions/types';
import * as db from './db';
import { uid } from './db';
import { biologyOfficeFixtures } from './officeFixtures';

/** A real PDF, so the page picker draws real pages: a cover, then numbered
 * questions with ruled answer lines, in Helvetica with no fonts embedded. */
export function paperPdf(title: string, pages: number): string {
  const pdfText = (text: string) => text.replace(/[()\\]/g, '\\$&');
  const line = (x: number, y: number, size: number, text: string) =>
    `BT /F1 ${size} Tf ${x} ${y} Td (${pdfText(text)}) Tj ET`;
  const rule = (y: number) => `0.75 G 60 ${y} m 535 ${y} l S`;
  const page = (number: number) => {
    if (number === 1)
      return [
        line(250, 600, 10, 'BIO 101'),
        line(210, 560, 34, 'Biology'),
        line(255, 525, 14, 'Paper 1'),
        line(150, 470, 11, title),
        '0.7 G 170 340 260 70 re S',
      ].join('\n');
    const question = number - 1;
    return [
      line(60, 760, 11, String(question)),
      line(
        80,
        760,
        11,
        `Describe how the structure in question ${question} works.`
      ),
      line(80, 740, 11, 'Use the figure and name each part you mention.'),
      rule(690),
      rule(660),
      rule(630),
      line(510, 610, 9, `[${(question % 5) + 1}]`),
      line(60, 560, 11, `${question}(b)`),
      line(
        90,
        560,
        11,
        'Explain what would change if the membrane were damaged.'
      ),
      rule(510),
      rule(480),
      line(510, 460, 9, '[3]'),
      line(285, 40, 9, String(number)),
    ].join('\n');
  };
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages} /Kids [${Array.from(
      { length: pages },
      (_, i) => `${4 + i * 2} 0 R`
    ).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (let i = 1; i <= pages; i += 1) {
    const stream = page(i);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${
        5 + (i - 1) * 2
      } 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
    );
  }
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = body.length;
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return URL.createObjectURL(new Blob([body], { type: 'application/pdf' }));
}

const WORKSHEET = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="620" height="840"><rect width="620" height="840" fill="#fbfaf6"/><g font-family="sans-serif" fill="#333"><text x="50" y="80" font-size="22">Worksheet: osmosis</text><text x="50" y="140" font-size="15">1. What happens to a plant cell in salt solution?</text><text x="50" y="260" font-size="15">2. Name the partially permeable layer.</text></g></svg>'
)}`;

/** Files for Make a quiz, in the Biology workspace's Other files. Runs on the
 * failing paper fail; the 2024 paper's run leaves a question out. */
const FAILS = 'f_paper_fails';
const LEAVES_ONE_OUT = 'f_paper_2024';
function seedFile(
  id: string,
  name: string,
  kind: 'doc' | 'image' | 'pdf',
  sizeKb: number,
  url: string
) {
  db.fileLinks[id] = { url };
  db.files.push({
    addedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    hasBytes: true,
    id,
    indexed: true,
    isPayer: true,
    kind,
    name,
    position: 900 + db.files.length,
    revision: 1,
    sizeBytes: sizeKb * 1024,
    status: 'ready',
    topicId: null,
    workspaceId: 'ws_bio',
  });
}
export function seedExtractionFiles() {
  seedFile(
    'f_paper_2025',
    'Past paper 2025 P1.pdf',
    'pdf',
    860,
    paperPdf('Past paper 2025', 16)
  );
  seedFile(
    LEAVES_ONE_OUT,
    'Past paper 2024 P1.pdf',
    'pdf',
    840,
    paperPdf('Past paper 2024', 16)
  );
  seedFile(
    'f_paper_scheme',
    'Past paper 2025 P1 mark scheme.pdf',
    'pdf',
    210,
    paperPdf('Mark scheme', 8)
  );
  seedFile(
    FAILS,
    'Damaged scan (the run fails).pdf',
    'pdf',
    400,
    paperPdf('Damaged scan', 6)
  );
  seedFile(
    'f_paper_long',
    'Revision book.pdf',
    'pdf',
    3200,
    paperPdf('Revision book', 60)
  );
  seedFile('f_worksheet', 'Worksheet photo.jpg', 'image', 320, WORKSHEET);
  seedFile(
    'f_worked',
    'Worked answers.docx',
    'doc',
    66,
    biologyOfficeFixtures[0].sourceURL
  );
}

const shortPart = (
  blocks: string,
  accepted: string,
  marks: number,
  solution: string
): Question['parts'][number] => ({
  answer: { accepted: [accepted], type: 'short' },
  blocks: [{ text: blocks, type: 'text' }],
  id: crypto.randomUUID(),
  marks,
  solution: [{ text: solution, type: 'text' }],
});

const openPart = (
  blocks: string,
  markscheme: string[],
  solution: string,
  firstMarks = 1
): Question['parts'][number] => ({
  answer: { accepted: [], hints: [], type: 'open' },
  blocks: [{ text: blocks, type: 'text' }],
  id: crypto.randomUUID(),
  marks: markscheme.length + firstMarks - 1,
  markscheme: markscheme.map((text, i) => ({
    marks: i === 0 ? firstMarks : 1,
    text,
  })),
  solution: [{ text: solution, type: 'text' }],
});

const question = (
  parts: Question['parts'],
  stem: Question['stem'] = []
): Question => ({
  id: crypto.randomUUID(),
  labels: 'letters',
  layout: 'paper',
  parts,
  stem,
});

/** Board X2's twelve questions. */
function extractedQuestions(): Question[] {
  const single = (text: string, answer: string, marks: number) =>
    question([shortPart(text, answer, marks, `The answer is ${answer}.`)]);
  const open = (text: string, points: string[]) =>
    question([openPart(text, points, points.join(' '))]);
  return [
    open('Label the parts of the animal cell shown.', [
      'Nucleus',
      'Membrane',
      'Mitochondrion',
    ]),
    single('State the function of the mitochondria.', 'Respiration', 1),
    open('Compare prokaryotic and eukaryotic cells.', [
      'Size',
      'A nucleus',
      'Organelles',
      'Ribosome size',
    ]),
    question([
      openPart(
        'The diagram shows a plant cell placed in salt solution.',
        [
          'Water leaves by osmosis',
          'Cell shrinks',
          'Membrane pulls away',
          'Plasmolysis',
          'Vacuole shrinks',
        ],
        'Water leaves by osmosis, the vacuole shrinks and the membrane pulls away from the wall.',
        2
      ),
    ]),
    open('Describe how active transport differs from diffusion.', [
      'Against the gradient',
      'Needs energy',
      'Uses carrier proteins',
    ]),
    single('Calculate the magnification of the micrograph.', '400', 2),
    question(
      [
        {
          ...shortPart(
            'Name the stage of mitosis shown in Figure 4.',
            'Metaphase',
            1,
            ''
          ),
          solution: [],
        },
        openPart(
          'Describe what happens to the chromosomes in the next stage.',
          [
            'Sister chromatids separate',
            'and move to opposite poles',
            'pulled by shortening spindle fibres',
          ],
          'In anaphase the centromeres split, so each pair of sister chromatids separates. Spindle fibres shorten and pull the chromatids to opposite poles of the cell.'
        ),
      ],
      [{ text: 'Figure 4 shows a cell during division.', type: 'text' }]
    ),
    open('Describe the structure of a DNA nucleotide.', [
      'Phosphate',
      'Sugar',
      'Base',
    ]),
    open('Explain how a gene codes for a protein.', [
      'Base sequence',
      'Triplets',
      'Amino acids',
      'Order sets the protein',
    ]),
    open('Complete the genetic cross for flower colour.', [
      'Gametes',
      'Offspring',
      'Ratio',
    ]),
    open('Explain what the pedigree shows about the allele.', [
      'Recessive',
      'Carriers',
      'Skips a generation',
      'Evidence',
    ]),
    open('Suggest how antibiotic resistance evolves.', [
      'Mutation',
      'Selection',
      'Reproduction',
    ]),
  ];
}

function reportFor(
  recorded: string[],
  pages: number,
  missing: string[]
): ExtractionReport {
  const report: ExtractionReport = {
    expected: [...recorded, ...missing],
    figures: [],
    figuresLeftOut: [],
    keyDisagreements: [],
    marksDiffer: [],
    missing,
    pages,
    recorded,
    schemeRefused: [],
    schemeRepeats: [],
    stopped: '',
    unpaired: [],
    windows: Math.ceil(pages / 2),
  };
  return report as ExtractionReport;
}

/** How fast a run reads, so its progress can be watched. */
const QUESTION_MS = 900;
const runs = new Map<string, Extraction>();

/** What a quiz's rooms start from instead of its saved questions, so the mock
 * can show board X2's issue: question 7 waiting for its image. A real run only
 * saves complete questions, so its quizzes open without one. */
export const draftQuizQuestions = new Map<string, Question[]>();
function withMissingFigure(questions: Question[]): Question[] {
  const draft = structuredClone(questions);
  draft[6]?.stem.push({
    description: '',
    height: 1,
    image: { url: '' },
    type: 'image',
    width: 1,
  });
  return draft;
}

/** A run from start to end, on timers so it goes on with its page closed, and
 * its end on the mock's stand-in for the event stream. `saveQuiz` makes the
 * quiz, hidden from members, and returns its id. */
export function extractionHandlers(
  saveQuiz: (
    workspaceId: string,
    title: string,
    questions: Question[]
  ) => string,
  titleTaken: (workspaceId: string, title: string) => boolean
) {
  return [
    http.post(
      '/api/workspaces/:id/extractions',
      async ({ params, request }) => {
        await delay();
        const workspaceId = String(params.id);
        const body = (await request.json()) as CreateExtractionReq;
        const paper = body.paper ?? [];
        const pages = paper.reduce(
          (sum, file) => sum + (file.pages?.length ?? 0),
          0
        );
        if (pages > EXTRACTION_PAGES_MAX)
          return HttpResponse.json(
            {
              detail: `a run reads at most ${EXTRACTION_PAGES_MAX} selected pages`,
            },
            { status: 400 }
          );
        if (titleTaken(workspaceId, body.title))
          return HttpResponse.json(
            { code: 'title_taken', detail: 'title taken' },
            { status: 409 }
          );
        const run: Extraction = {
          createdAt: new Date().toISOString(),
          id: uid('ex'),
          recorded: 0,
          status: 'running',
          title: body.title,
          workspaceId,
        };
        runs.set(run.id, run);
        const fails = paper.some((file) => file.fileId === FAILS);
        const leaves = paper.some((file) => file.fileId === LEAVES_ONE_OUT);
        const questions = extractedQuestions();
        const labels = questions.map((_, i) => String(i + 1));
        const end = (status: 'done' | 'failed') => {
          clearInterval(timer);
          run.status = status;
          run.finishedAt = new Date().toISOString();
          if (status === 'done') {
            const kept = leaves ? questions.slice(0, -1) : questions;
            run.quizId = saveQuiz(workspaceId, body.title, kept);
            draftQuizQuestions.set(run.quizId, withMissingFigure(kept));
            run.report = reportFor(
              labels.slice(0, kept.length),
              pages,
              leaves ? labels.slice(-1) : []
            );
          } else {
            run.errorCode = 'extraction_failed';
            run.error =
              'The pages could not be read. Try again in a few minutes.';
          }
          window.dispatchEvent(
            new CustomEvent('capy:mock-stream', {
              detail: { extractionId: run.id, status, type: 'extraction' },
            })
          );
        };
        const timer = setInterval(() => {
          run.recorded += 1;
          if (fails && run.recorded === 4) end('failed');
          else if (run.recorded >= questions.length) end('done');
        }, QUESTION_MS);
        return HttpResponse.json(run, { status: 202 });
      }
    ),
    http.get('/api/extractions/:id', async ({ params }) => {
      await delay();
      const run = runs.get(String(params.id));
      return run
        ? HttpResponse.json(run)
        : new HttpResponse(null, { status: 404 });
    }),
  ];
}
