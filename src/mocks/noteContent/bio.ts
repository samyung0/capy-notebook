import {
  flashcardsNode,
  mermaidNode,
  quizNode,
} from '@/features/materials/document';
import {
  bullet,
  callout,
  codeBlock,
  columns,
  equation,
  heading,
  hr,
  inlineEquation,
  link,
  mention,
  numbered,
  p,
  quote,
  type SeedNote,
  table,
  text,
  toc,
  todo,
  youtube,
} from './helpers';

/** Biology 101 — showcase headings, marks, lists, callouts, media, study blocks. */
export const bioNotes: SeedNote[] = [
  {
    chapterId: 'ch_1',
    daysAgo: 0,
    id: 'mat_note_1',
    title: 'Lecture notes — the cell',
    value: [
      heading(1, 'Lecture notes — the cell'),
      toc(),
      p([
        text('The '),
        text('cell', { bold: true }),
        text(
          ' is the basic unit of life. Today we covered structure, transport, and energy — see '
        ),
        link(
          'Khan Academy: cells',
          'https://www.khanacademy.org/science/biology'
        ),
        text(' for a refresher. Ping '),
        mention('Kate Malone'),
        text(' if your lab group still needs a partner.'),
      ]),
      callout(
        [
          text('Exam tip: '),
          text('mitochondria', { highlight: true }),
          text(
            ' come up on nearly every quiz — know ATP yield and where the Krebs cycle happens.'
          ),
        ],
        'warning'
      ),
      heading(2, 'Prokaryotes vs eukaryotes'),
      bullet('Prokaryotes lack a membrane-bound nucleus'),
      bullet('Eukaryotes have organelles (nucleus, mitochondria, ER, Golgi)'),
      bullet([
        text('Both have '),
        text('ribosomes', { italic: true }),
        text(' for protein synthesis'),
      ]),
      quote(
        'Remember: mitochondria is the powerhouse of the cell — but also an endosymbiont with its own DNA.'
      ),
      heading(2, 'Lab checklist'),
      todo('Sketch a labeled eukaryotic cell', true),
      todo('Compare osmosis vs diffusion in the worksheet'),
      todo('Watch the membrane transport clip below'),
      youtube('URUJD5NEXC8'),
      hr(),
      heading(2, 'Organelle overview'),
      table(
        ['Organelle', 'Function', 'Analogy'],
        [
          ['Nucleus', 'Stores DNA; controls the cell', 'City hall'],
          ['Mitochondria', 'ATP via respiration', 'Power plant'],
          ['Ribosome', 'Protein synthesis', 'Factory'],
          ['Golgi', 'Packaging & shipping', 'Post office'],
        ]
      ),
      heading(3, 'Quick model'),
      mermaidNode(
        'flowchart LR\n  DNA --> Transcription\n  Transcription --> mRNA\n  mRNA --> Translation\n  Translation --> Protein',
        'Central dogma at a glance',
        'mermaid_bio_central'
      ),
      heading(2, 'Self-check'),
      quizNode(
        {
          questions: [
            {
              correct: [1],
              explanation:
                'Mitochondria produce ATP through cellular respiration.',
              id: 'bio_note_q1',
              level: 'recall',
              options: [
                { value: 'Nucleus' },
                { value: 'Mitochondria' },
                { value: 'Golgi apparatus' },
              ],
              prompt: 'Which organelle produces most of the cell’s ATP?',
              type: 'mcq',
            },
            {
              correct: true,
              explanation: 'True — prokaryotes lack membrane-bound organelles.',
              id: 'bio_note_q2',
              level: 'recall',
              prompt: 'Prokaryotes lack a membrane-bound nucleus.',
              type: 'boolean',
            },
          ],
        },
        'quiz_bio_note_1'
      ),
      flashcardsNode(
        [
          {
            back: 'Diffusion of water across a semi-permeable membrane',
            front: 'What is osmosis?',
            id: 'fc_bio_note_1',
          },
          {
            back: 'Phospholipid bilayer with embedded proteins',
            front: 'What is the basic structure of the cell membrane?',
            id: 'fc_bio_note_2',
          },
        ],
        'fcset_bio_note_1'
      ),
      p([
        text('Keyboard shortcut while reviewing: press '),
        text('Space', { kbd: true }),
        text(' to flip a card.'),
      ]),
    ],
    workspaceId: 'ws_bio',
    workspaceName: 'Biology 101',
  },
  {
    chapterId: 'ch_2',
    daysAgo: 2,
    id: 'mat_note_bio_transport',
    title: 'Membranes & transport cheatsheet',
    value: [
      heading(1, 'Membranes & transport'),
      p([
        text('Focus: how materials cross the '),
        text('phospholipid bilayer', { underline: true }),
        text('.'),
      ]),
      columns(
        ['50%', '50%'],
        [
          p([
            text('Passive', { bold: true, color: '#15803d' }),
            text(' — no ATP. Diffusion, osmosis, facilitated diffusion.'),
          ]),
          p([
            text('Active', { bold: true, color: '#b91c1c' }),
            text(' — requires ATP. Pumps, endocytosis, exocytosis.'),
          ]),
        ]
      ),
      callout(
        'Hypotonic → water in (cell swells). Hypertonic → water out (cell shrinks).',
        'info'
      ),
      heading(2, 'Practice prompts'),
      numbered('Explain why distilled water can lyse animal cells'),
      numbered('Contrast channel proteins vs carrier proteins'),
      numbered([
        text('Derive why '),
        text('ΔG', { code: true }),
        text(' for passive transport is favorable down a gradient'),
      ]),
      codeBlock(
        [
          '# Pseudo-rate for simple diffusion',
          'flux ≈ P * A * (C_out - C_in)',
          '# P = permeability, A = surface area',
        ],
        'python'
      ),
      p([
        text('Crossed-out from last draft: '),
        text('“protein pumps never use ATP”', { strikethrough: true }),
        text(' — that was wrong.'),
      ]),
    ],
    workspaceId: 'ws_bio',
    workspaceName: 'Biology 101',
  },
  {
    chapterId: null,
    daysAgo: 0,
    id: 'mat_note_bio_feature_matrix',
    title: 'Editor feature matrix (all blocks)',
    value: [
      heading(1, 'Editor feature matrix'),
      toc(),
      p(
        'This note intentionally exercises every Plate feature except uploaded media nodes (img / audio / file).'
      ),

      heading(2, 'Headings'),
      heading(3, 'Heading 3'),
      heading(4, 'Heading 4'),
      heading(5, 'Heading 5'),
      heading(6, 'Heading 6'),

      heading(2, 'Text marks & styles'),
      p([
        text('plain · '),
        text('bold', { bold: true }),
        text(' · '),
        text('italic', { italic: true }),
        text(' · '),
        text('underline', { underline: true }),
        text(' · '),
        text('strike', { strikethrough: true }),
        text(' · '),
        text('inline code', { code: true }),
        text(' · '),
        text('Ctrl', { kbd: true }),
        text('+'),
        text('B', { kbd: true }),
        text(' · '),
        text('highlight', { highlight: true }),
        text(' · H'),
        text('2', { subscript: true }),
        text('O · E=mc'),
        text('2', { superscript: true }),
      ]),
      p([
        text('colored', { color: '#dc2626' }),
        text(' · '),
        text('tinted', { backgroundColor: '#fef9c3', color: '#854d0e' }),
        text(' · '),
        text('larger', { fontSize: '24px' }),
        text(' · '),
        text('serif sample', { fontFamily: 'Georgia, serif' }),
      ]),
      p([
        text('Inline link: '),
        link(
          'OpenStax Biology',
          'https://openstax.org/details/books/biology-2e'
        ),
        text(' · mention '),
        mention('Kate Malone'),
        text(' · inline math '),
        inlineEquation('\\Delta G = \\Delta H - T\\Delta S'),
        text('.'),
      ]),

      heading(2, 'Alignment'),
      p('Left-aligned paragraph (default).', { align: 'left' }),
      p('Center-aligned paragraph.', { align: 'center' }),
      p('Right-aligned paragraph.', { align: 'right' }),
      p(
        'Justify-aligned paragraph: membranes separate compartments so gradients can do work across the bilayer.',
        { align: 'justify' }
      ),

      heading(2, 'Lists'),
      bullet('Bulleted item — organelles'),
      bullet('Bulleted item — membranes'),
      numbered('Numbered step — isolate the variable'),
      numbered('Numbered step — apply the model'),
      todo('Todo checked — skim the matrix', true),
      todo('Todo open — try each toolbar control'),

      heading(2, 'Quote & divider'),
      quote(
        '“Nothing in biology makes sense except in the light of evolution.” — Theodosius Dobzhansky'
      ),
      hr(),

      heading(2, 'Callout variants'),
      callout('Info callout — background reading is linked above.', 'info'),
      callout(
        'Success callout — you covered every non-media block.',
        'success'
      ),
      callout('Warning callout — osmolarity units trip people up.', 'warning'),
      callout(
        'Danger callout — do not confuse lysis with crenation.',
        'danger'
      ),

      heading(2, 'Code block'),
      codeBlock(
        [
          'def atp_yield(glucose_mol: float) -> float:',
          '    """Rough aerobic yield (~30-32 ATP / glucose)."""',
          '    return glucose_mol * 30',
        ],
        'python'
      ),

      heading(2, 'Table'),
      table(
        ['Process', 'Location', 'ATP net'],
        [
          ['Glycolysis', 'Cytosol', '2'],
          ['Krebs cycle', 'Mitochondrial matrix', '2'],
          ['ETC / oxidative phosphorylation', 'Inner membrane', '~28'],
        ]
      ),

      heading(2, 'Columns'),
      columns(
        ['50%', '50%'],
        [
          p([text('Two-column left', { bold: true }), text(' — structure.')]),
          p([text('Two-column right', { bold: true }), text(' — function.')]),
        ]
      ),
      columns(
        ['33.333%', '33.333%', '33.334%'],
        ['Prokaryote', 'Eukaryote animal', 'Eukaryote plant']
      ),
      columns(
        ['66.667%', '33.333%'],
        [
          p('Wide column: endosymbiotic origin of mitochondria.'),
          p('Narrow: DNA circular.'),
        ]
      ),

      heading(2, 'Block equation'),
      equation(
        '\\mathrm{C_6H_{12}O_6} + 6\\,\\mathrm{O_2} \\rightarrow 6\\,\\mathrm{CO_2} + 6\\,\\mathrm{H_2O} + \\text{ATP}'
      ),

      heading(2, 'YouTube embed'),
      youtube('URUJD5NEXC8'),

      heading(2, 'Mermaid diagram'),
      mermaidNode(
        'flowchart TB\n  Glucose --> Glycolysis\n  Glycolysis --> Pyruvate\n  Pyruvate --> Krebs\n  Krebs --> ETC\n  ETC --> ATP',
        'Respiration overview',
        'mermaid_bio_feature_matrix'
      ),

      heading(2, 'Quiz block'),
      quizNode(
        {
          questions: [
            {
              correct: [0],
              explanation: 'Glycolysis occurs in the cytosol of the cell.',
              id: 'bio_matrix_q_mcq',
              level: 'recall',
              options: [
                { value: 'Cytosol' },
                { value: 'Nucleus' },
                { value: 'Golgi lumen' },
              ],
              prompt: 'Where does glycolysis occur?',
              type: 'mcq',
            },
            {
              correct: [0, 2],
              explanation:
                'Both mitochondria and chloroplasts have their own DNA.',
              id: 'bio_matrix_q_multi',
              level: 'application',
              options: [
                { value: 'Mitochondria' },
                { value: 'Lysosomes' },
                { value: 'Chloroplasts' },
              ],
              prompt: 'Which organelles contain their own DNA? (multi)',
              type: 'multi',
            },
            {
              correct: true,
              explanation: 'True — ribosomes are not membrane-bound.',
              id: 'bio_matrix_q_bool',
              level: 'recall',
              prompt:
                'Ribosomes are present in both prokaryotes and eukaryotes.',
              type: 'boolean',
            },
            {
              accepted: [{ value: 'ATP' }, { value: 'adenosine triphosphate' }],
              explanation: 'ATP is the cell’s short-term energy currency.',
              id: 'bio_matrix_q_short',
              level: 'recall',
              prompt: 'The main short-term energy carrier is ____.',
              type: 'short',
            },
          ],
        },
        'quiz_bio_feature_matrix'
      ),

      heading(2, 'Flashcards block'),
      flashcardsNode(
        [
          {
            back: 'Adenosine triphosphate — cellular energy currency',
            front: 'What does ATP stand for?',
            id: 'fc_bio_matrix_1',
          },
          {
            back: 'Diffusion of water across a semi-permeable membrane',
            front: 'Define osmosis',
            id: 'fc_bio_matrix_2',
          },
        ],
        'fcset_bio_feature_matrix'
      ),

      p([
        text('End of matrix. Media uploads ('),
        text('img', { code: true }),
        text(' / '),
        text('audio', { code: true }),
        text(' / '),
        text('file', { code: true }),
        text(') are omitted on purpose.'),
      ]),
    ],
    workspaceId: 'ws_bio',
    workspaceName: 'Biology 101',
  },
];
