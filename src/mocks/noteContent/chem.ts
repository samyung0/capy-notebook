import { flashcardsNode, mermaidNode } from '@/features/materials/document';
import {
  bullet,
  callout,
  codeBlock,
  equation,
  heading,
  hr,
  inlineEquation,
  p,
  type SeedNote,
  table,
  text,
  toc,
  todo,
} from './helpers';

/** Organic Chemistry — tables, equations, warnings, flashcards, mechanism sketch. */
export const chemNotes: SeedNote[] = [
  {
    chapterId: null,
    daysAgo: 5,
    id: 'mat_note_chem_sn',
    title: 'SN1 vs SN2 decision guide',
    value: [
      heading(1, 'SN1 vs SN2'),
      toc(),
      p([
        text('Nucleophilic substitution pathways compete. Match '),
        text('substrate', { bold: true }),
        text(', '),
        text('nucleophile', { bold: true }),
        text(', and '),
        text('solvent', { bold: true }),
        text(' before predicting the major path.'),
      ]),
      callout(
        'Safety: treat alkyl halides and strong bases as hazardous — hood + gloves for anything beyond paper mechanisms.',
        'danger'
      ),
      heading(2, 'Side-by-side'),
      table(
        ['Feature', 'SN1', 'SN2'],
        [
          ['Rate law', 'Unimolecular (substrate)', 'Bimolecular'],
          ['Stereochem', 'Racemization (planar carbocation)', 'Inversion'],
          ['Best substrate', '3° > 2°', '1° > 2° (methyl best)'],
          ['Nucleophile', 'Weak OK', 'Strong, unhindered'],
          ['Solvent', 'Polar protic', 'Polar aprotic'],
        ]
      ),
      heading(2, 'Rate expressions'),
      p([
        text('SN1: '),
        inlineEquation('Rate = k[R{-}X]'),
        text(' · SN2: '),
        inlineEquation('Rate = k[R{-}X][Nu^{-}]'),
        text('.'),
      ]),
      equation(
        '\\mathrm{SN2:\\quad Nu^{-}} + R{-}X \\rightarrow Nu{-}R + X^{-}'
      ),
      heading(3, 'Mechanism sketch'),
      mermaidNode(
        'flowchart LR\n  RX[R-X] -->|SN2 concerted| Product\n  RX -->|SN1: lose X| Carbocation\n  Carbocation -->|Nu attack| Product',
        'Competing substitution pathways',
        'mermaid_chem_sn'
      ),
      hr(),
      heading(2, 'Leaving-group rank (common)'),
      codeBlock(
        [
          '# Better leaving groups (approx.)',
          'I- > Br- > Cl- >> F-',
          '# OTs / OMs are also excellent',
        ],
        'plaintext'
      ),
      callout(
        [
          text('Pro tip: if you see '),
          text('tert-butyl bromide', { highlight: true }),
          text(' + weak Nu in ethanol, think SN1 / E1 territory.'),
        ],
        'info'
      ),
      heading(2, 'Drill cards'),
      flashcardsNode(
        [
          {
            back: 'Back-side attack; inversion of configuration; concerted',
            front: 'SN2 stereochemical outcome?',
            id: 'fc_chem_sn2',
          },
          {
            back: 'Carbocation intermediate; racemization if chiral center involved',
            front: 'SN1 key intermediate?',
            id: 'fc_chem_sn1',
          },
          {
            back: 'Polar aprotic (e.g. acetone, DMSO, DMF)',
            front: 'Preferred solvent class for SN2?',
            id: 'fc_chem_solvent',
          },
        ],
        'fcset_chem_sn'
      ),
      heading(2, 'Lab prep todos'),
      todo('Redraw both mechanisms without notes', true),
      todo('Predict major path for three mixed problems'),
      todo('Check solvent polarity notes from lecture 6'),
      p([
        text('Isotope reminder: carbon-14 is written C'),
        text('14', { superscript: true }),
        text(' in some texts; in mechanisms we usually keep ordinary C.'),
      ]),
      bullet([
        text('Watch for '),
        text('E2', { code: true }),
        text(' competing when base is strong and bulky'),
      ]),
      bullet(
        'Secondary substrates are the ambiguous middle — argue both sides'
      ),
    ],
    workspaceId: 'ws_chem',
    workspaceName: 'Organic Chemistry',
  },
];
