import { mermaidNode } from '@/features/materials/document';
import {
  bullet,
  callout,
  columns,
  heading,
  hr,
  link,
  mention,
  numbered,
  p,
  quote,
  type SeedNote,
  table,
  text,
  toc,
  youtube,
} from './helpers';

/** World History — narrative layout: columns, quotes, callouts, timeline lists. */
export const histNotes: SeedNote[] = [
  {
    chapterId: null,
    daysAgo: 2,
    id: 'mat_note_hist_ww1',
    title: 'Causes of World War I',
    value: [
      heading(1, 'Causes of World War I'),
      toc(),
      p([
        text('Use the mnemonic '),
        text('MAIN', {
          backgroundColor: '#fef9c3',
          bold: true,
          color: '#854d0e',
        }),
        text(
          ': Militarism, Alliances, Imperialism, Nationalism. Primary spark: assassination of Archduke Franz Ferdinand (1914).'
        ),
      ]),
      columns(
        ['66.667%', '33.333%'],
        [
          p(
            'Long-term tensions piled up for decades. Industrial arms races made mobilization plans brittle — once one alliance moved, others felt forced to follow.'
          ),
          p([
            text('Need a source? Try '),
            link(
              'British Library WWI overview',
              'https://www.bl.uk/world-war-one'
            ),
            text('.'),
          ]),
        ]
      ),
      heading(2, 'MAIN breakdown'),
      table(
        ['Factor', 'What it looked like', 'Why it mattered'],
        [
          [
            'Militarism',
            'Naval race, huge standing armies',
            'War felt “ready”',
          ],
          [
            'Alliances',
            'Triple Entente vs Triple Alliance',
            'Local → continental',
          ],
          ['Imperialism', 'Competition for colonies', 'Extra flashpoints'],
          ['Nationalism', 'Ethnic self-determination', 'Balkans powder keg'],
        ]
      ),
      callout(
        'Do not reduce the war to a single cause in essays — examiners want interaction between factors.',
        'warning'
      ),
      heading(2, 'Short timeline'),
      numbered('28 Jun 1914 — Assassination in Sarajevo'),
      numbered('23 Jul 1914 — Austrian ultimatum to Serbia'),
      numbered('1–4 Aug 1914 — Declarations cascade across Europe'),
      hr(),
      quote(
        '“The lamps are going out all over Europe; we shall not see them lit again in our lifetime.” — attributed to Sir Edward Grey'
      ),
      p([
        text('Study buddies: '),
        mention('Kate Malone'),
        text(' is collecting primary-source excerpts for Friday’s seminar.'),
      ]),
      youtube('dQXmm87hZ3M'),
      mermaidNode(
        'timeline\n  title Path to August 1914\n  1908 : Bosnian crisis\n  1912-13 : Balkan Wars\n  1914 : Sarajevo → ultimatums → general war',
        'From crisis to continental war',
        'mermaid_hist_ww1'
      ),
      heading(3, 'Essay angle bank'),
      bullet([
        text('Argue that '),
        text('alliances', { underline: true }),
        text(' were necessary but not sufficient'),
      ]),
      bullet('Compare naval militarism vs continental army plans'),
      bullet([
        text('Weigh contingency: could July 1914 have stayed '),
        text('local', { italic: true }),
        text('?'),
      ]),
      callout(
        'Success criterion: cite at least two different factor interactions.',
        'success'
      ),
    ],
    workspaceId: 'ws_hist',
    workspaceName: 'World History',
  },
];
