import type {
  ChartBlock,
  GraphBlock,
  Question,
} from '@/features/questions/types';
import surfaceAreaSvg from './fixtures/biology-surface-area.svg?raw';

export const surfaceAreaGraph: GraphBlock = {
  board: { axis: true, bbox: [-0.8, 7.5, 7, -1.5], grid: true },
  description:
    'Surface-area-to-volume ratio, y = 6/x, for a cube-shaped cell. A is (1, 6), B is (2, 3), and C is (3, 2).',
  elements: [
    { domain: [1, 6], id: 'ratio', term: '6/x', type: 'functiongraph' },
    { coords: [1, 6], id: 'a', name: 'A', type: 'point' },
    { coords: [2, 3], id: 'b', name: 'B', type: 'point' },
    { coords: [3, 2], id: 'c', name: 'C', type: 'point' },
    {
      coords: [2, -0.9],
      id: 'x-label',
      text: 'Cell side length (µm)',
      type: 'text',
    },
    {
      coords: [0.4, 7],
      id: 'y-label',
      text: 'Surface area : volume (µm⁻¹)',
      type: 'text',
    },
  ],
  height: 400,
  image: { svg: surfaceAreaSvg },
  type: 'graph',
  width: 600,
};

const photosynthesis: ChartBlock = {
  gridlines: 'fine',
  kind: 'line',
  labels: ['0', '100', '200', '300', '400'],
  series: [
    { name: 'Low CO₂', values: [0, 3, 6, 6, 6] },
    { name: 'High CO₂', values: [0, 4, 8, 10, 10] },
  ],
  title: 'Photosynthesis at two carbon dioxide concentrations',
  type: 'chart',
  xTitle: 'Light intensity (µmol photons m⁻² s⁻¹)',
  yTitle: 'Oxygen production (µmol/min)',
};

/** Shared by the workspace quiz and both Biology note embeds. All data are illustrative. */
export const biologyQuizQuestions: Question[] = [
  {
    id: 'q1',
    labels: 'letters',
    layout: 'paper',
    parts: [
      {
        answer: {
          correct: [1],
          options: ['Nucleus', 'Mitochondria', 'Golgi apparatus', 'Ribosome'],
          type: 'mcq',
        },
        blocks: [
          {
            text: 'Which organelle produces most of the ATP during aerobic respiration in a typical animal cell?',
            type: 'text',
          },
        ],
        id: 'q1:part',
        marks: 1,
        solution: [
          {
            label: 'Reasoning',
            text: 'The electron transport chain and ATP synthase are in the inner mitochondrial membrane. Glycolysis also makes ATP, but its net yield is much smaller.',
            type: 'text',
          },
          {
            header: true,
            rows: [
              ['Stage', 'Location', 'How ATP is made'],
              ['Glycolysis', 'Cytosol', 'Substrate-level phosphorylation'],
              [
                'Citric acid cycle',
                'Mitochondrial matrix',
                'Substrate-level phosphorylation',
              ],
              [
                'Oxidative phosphorylation',
                'Inner mitochondrial membrane',
                'ATP synthase uses a proton gradient',
              ],
            ],
            type: 'table',
          },
        ],
      },
    ],
    stem: [
      {
        text: 'Cellular respiration transfers energy from glucose to ATP. The overall reaction is shown below.',
        type: 'text',
      },
      {
        text: '$$\\mathrm{C_6H_{12}O_6}+6\\,\\mathrm{O_2}\\rightarrow6\\,\\mathrm{CO_2}+6\\,\\mathrm{H_2O}+\\text{energy}$$',
        type: 'text',
      },
    ],
  },
  {
    id: 'q2',
    labels: 'letters',
    layout: 'split',
    parts: [
      {
        answer: { correct: true, type: 'boolean' },
        blocks: [
          {
            text: 'The cell membrane is a phospholipid bilayer, even though proteins account for more mass than lipids in this sample.',
            type: 'text',
          },
        ],
        id: 'q2:part',
        marks: 1,
        solution: [
          {
            label: 'Verdict',
            text: 'True. Phospholipids form the bilayer. Proteins are embedded in it or attached to its surfaces; their larger mass fraction does not replace that structure.',
            type: 'text',
          },
          {
            kind: 'stacked',
            labels: ['Proteins', 'Lipids', 'Carbohydrates'],
            series: [{ name: 'Dry mass', values: [50, 40, 10] }],
            title: 'The same membrane sample as a composition bar',
            type: 'chart',
            unit: '%',
          },
        ],
      },
    ],
    stem: [
      {
        text: 'The chart shows an illustrative membrane sample by dry mass.',
        type: 'text',
      },
      {
        kind: 'pie',
        labels: ['Proteins', 'Lipids', 'Carbohydrates'],
        series: [{ name: 'Dry mass', values: [50, 40, 10] }],
        title: 'Membrane composition',
        type: 'chart',
        unit: '%',
      },
    ],
  },
  {
    id: 'q3',
    labels: 'letters',
    layout: 'paper',
    parts: [
      {
        answer: {
          correct: [1, 2],
          options: ['Ribosome', 'Nucleus', 'Mitochondria', 'Cytosol'],
          type: 'multi',
        },
        blocks: [
          {
            text: 'Select all the membrane-bound organelles. Two answers are correct.',
            type: 'text',
          },
        ],
        id: 'q3:part',
        marks: 2,
        solution: [
          {
            header: true,
            rows: [
              ['Option', 'Membrane-bound?', 'Reason'],
              ['Ribosome', 'No', 'A complex of RNA and proteins'],
              ['Nucleus', 'Yes', 'Surrounded by the nuclear envelope'],
              ['Mitochondria', 'Yes', 'Have outer and inner membranes'],
              ['Cytosol', 'No', 'The fluid portion of the cytoplasm'],
            ],
            type: 'table',
          },
          {
            label: 'Common mistake',
            text: 'A structure can be essential for cell function without being a membrane-bound organelle. Ribosomes are an example.',
            type: 'text',
          },
        ],
      },
    ],
    stem: [],
  },
  {
    id: 'q4',
    labels: 'letters',
    layout: 'paper',
    parts: [
      {
        answer: { accepted: ['osmosis'], type: 'short' },
        blocks: [
          {
            text: 'Name the process responsible for the net movement of water into its cells.',
            type: 'text',
          },
        ],
        id: 'q4:part',
        marks: 1,
        solution: [
          {
            label: 'Definition',
            text: 'Osmosis is the net movement of water through a partially permeable membrane from higher water potential to lower water potential.',
            type: 'text',
          },
          {
            label: 'Apply it',
            text: 'Distilled water has a higher water potential than the cell contents. Water enters the cells, increasing the cylinder’s mass.',
            type: 'text',
          },
          {
            label: 'Check the evidence',
            text: '$$\\%\\text{ mass change}=\\frac{2.20-2.00}{2.00}\\times100=10\\%$$',
            type: 'text',
          },
        ],
      },
    ],
    stem: [
      {
        text: 'A potato cylinder is placed in distilled water for 30 minutes. Its mass rises from $2.00\\,\\mathrm{g}$ to $2.20\\,\\mathrm{g}$.',
        type: 'text',
      },
    ],
  },
  {
    id: 'q5',
    labels: 'letters',
    layout: 'paper',
    parts: [
      {
        answer: {
          items: [
            'Ribosome',
            'Rough ER',
            'Golgi apparatus',
            'Vesicle',
            'Cell membrane',
          ],
          type: 'ordering',
        },
        blocks: [
          {
            text: 'Order the path of a secreted protein. “Vesicle” here means the secretory vesicle leaving the Golgi apparatus.',
            type: 'text',
          },
        ],
        id: 'q5:part',
        marks: 3,
        solution: [
          {
            label: '1. Synthesize',
            text: 'A ribosome on the rough ER translates the mRNA. The growing protein enters the ER, where it folds.',
            type: 'text',
          },
          {
            label: '2. Process',
            text: 'Transport vesicles carry the protein to the Golgi apparatus for further modification and sorting.',
            type: 'text',
          },
          {
            label: '3. Release',
            text: 'A secretory vesicle buds from the Golgi and fuses with the cell membrane, releasing the protein by exocytosis.',
            type: 'text',
          },
        ],
      },
    ],
    stem: [],
  },
  {
    id: 'q6',
    labels: 'letters',
    layout: 'paper',
    parts: [
      {
        answer: {
          options: [
            'Stores DNA',
            'Makes ATP using a proton gradient',
            'Builds proteins',
            'Packages proteins for secretion',
          ],
          pairs: [
            { left: 'Nucleus', right: 0 },
            { left: 'Mitochondrion', right: 1 },
            { left: 'Ribosome', right: 2 },
            { left: 'Chloroplast', right: 1 },
          ],
          type: 'matching',
        },
        blocks: [
          {
            text: 'Match each structure to its function. An option may be used more than once, and one option is unused.',
            type: 'text',
          },
        ],
        id: 'q6:part',
        marks: 4,
        solution: [
          {
            header: true,
            rows: [
              ['Structure', 'Option', 'Explanation'],
              ['Nucleus', 'A', 'Contains the nuclear genome'],
              [
                'Mitochondrion',
                'B',
                'A proton gradient drives ATP synthase in its inner membrane',
              ],
              ['Ribosome', 'C', 'Translates mRNA into a polypeptide'],
              [
                'Chloroplast',
                'B',
                'A proton gradient drives ATP synthase in thylakoid membranes',
              ],
            ],
            type: 'table',
          },
          {
            text: 'Option B is reused. Option D describes the Golgi apparatus, which is not one of the structures to match.',
            type: 'text',
          },
        ],
      },
    ],
    stem: [],
  },
  {
    id: 'q11',
    labels: 'letters',
    layout: 'paper',
    parts: [
      {
        answer: {
          correct: [1],
          options: [
            'It doubles',
            'It halves',
            'It stays the same',
            'It becomes four times larger',
          ],
          type: 'mcq',
        },
        blocks: [
          {
            text: 'What happens to the surface-area-to-volume ratio when side length doubles from point A to point B?',
            type: 'text',
          },
        ],
        id: 'q11:part',
        marks: 1,
        solution: [
          {
            label: 'Read the graph',
            text: 'A has coordinates $(1,6)$ and B has coordinates $(2,3)$. The side length doubles while the ratio falls from $6$ to $3\\,\\mathrm{µm}^{-1}$.',
            type: 'text',
          },
          {
            label: 'Algebraic check',
            text: '$$\\frac{6}{2L}=\\frac{1}{2}\\times\\frac{6}{L}$$',
            type: 'text',
          },
          {
            label: 'Biological meaning',
            text: 'A larger cell has less exchange surface per unit volume, so it is harder to supply its contents by diffusion alone.',
            type: 'text',
          },
        ],
      },
    ],
    stem: [
      {
        text: 'Model a cell as a cube of side length $L$. Its surface-area-to-volume ratio is $\\frac{6L^2}{L^3}=\\frac{6}{L}$.',
        type: 'text',
      },
      surfaceAreaGraph,
    ],
  },
  {
    id: 'q12',
    labels: 'numbers',
    layout: 'split',
    parts: [
      {
        answer: { correct: false, type: 'boolean' },
        blocks: [
          { text: 'Ribosomes are membrane-bound organelles.', type: 'text' },
        ],
        id: 'q12:part',
        marks: 1,
        solution: [
          {
            label: 'Correct the statement',
            text: 'False. Ribosomes are complexes of ribosomal RNA and proteins with no surrounding membrane. Both bacteria and animal cells need them to synthesize proteins.',
            type: 'text',
          },
        ],
      },
    ],
    stem: [
      {
        text: 'The chart compares structures found in the two cell types. Values indicate presence, not abundance.',
        type: 'text',
      },
      {
        kind: 'hbar',
        labels: ['Ribosomes', 'Plasma membrane', 'Membrane-bound nucleus'],
        series: [
          { name: 'Typical bacterium', values: [1, 1, 0] },
          { name: 'Typical animal cell', values: [1, 1, 1] },
        ],
        title: 'Cell structures',
        type: 'chart',
        xTitle: '0 = absent · 1 = present',
      },
    ],
  },
  {
    id: 'q13',
    labels: 'letters',
    layout: 'paper',
    parts: [
      {
        answer: { accepted: ['3', '24/8'], type: 'short', unit: 'µm⁻¹' },
        blocks: [
          {
            text: 'Calculate its surface-area-to-volume ratio. Enter the value only; the unit is provided.',
            type: 'text',
          },
        ],
        id: 'q13:part',
        marks: 3,
        solution: [
          {
            label: 'Method 1: calculate separately',
            text: '$$A=6(2)^2=24\\,\\mathrm{µm}^2\\qquad V=2^3=8\\,\\mathrm{µm}^3$$\n$$\\frac{A}{V}=\\frac{24}{8}=3\\,\\mathrm{µm}^{-1}$$',
            type: 'text',
          },
          {
            label: 'Method 2: simplify first',
            text: '$$\\frac{A}{V}=\\frac{6L^2}{L^3}=\\frac{6}{L}=\\frac{6}{2}=3\\,\\mathrm{µm}^{-1}$$',
            type: 'text',
          },
          surfaceAreaGraph,
          {
            label: 'Graph check',
            text: 'Point B is at $(2,3)$, agreeing with both calculations. The ratio is not an area or a volume, so its unit is inverse length.',
            type: 'text',
          },
        ],
      },
    ],
    stem: [
      {
        text: 'A cube-shaped cell has side length $L=2\\,\\mathrm{µm}$. Use $A=6L^2$ and $V=L^3$.',
        type: 'text',
      },
    ],
  },
  {
    id: 'q14',
    labels: 'numbers',
    layout: 'paper',
    parts: [
      {
        answer: {
          accepted: [
            'At low CO₂, increasing light above 200 no longer raises oxygen production. Light is no longer the limiting factor. Increasing CO₂ at the same light intensity raises the rate, supporting the conclusion that CO₂ supply limits photosynthesis under the low-CO₂ condition.',
          ],
          hints: [
            'Compare the two CO₂ conditions at the same light intensity.',
            'Distinguish a limiting factor from a variable held constant.',
          ],
          type: 'open',
        },
        blocks: [
          {
            text: 'Explain why the low-CO₂ curve levels off, and use the comparison to identify a limiting factor.',
            type: 'text',
          },
        ],
        id: 'q14:part',
        marks: 4,
        markscheme: [
          {
            marks: 1,
            text: 'Describes the low-CO₂ plateau at 6 µmol/min from light intensity 200 onward.',
          },
          {
            marks: 1,
            text: 'Explains that additional light no longer increases the rate, so light is not limiting there.',
          },
          {
            marks: 2,
            text: 'Uses the higher rate at higher CO₂ and the same light intensity as evidence that CO₂ supply is limiting.',
          },
        ],
        solution: [
          {
            label: 'Claim',
            text: 'CO₂ supply limits the rate in the low-CO₂ treatment once light intensity reaches 200.',
            type: 'text',
          },
          {
            kind: 'bar',
            labels: ['Low CO₂', 'High CO₂'],
            series: [{ name: 'Oxygen production', values: [6, 10] }],
            title: 'Compare CO₂ at light intensity 300',
            type: 'chart',
            unit: 'µmol/min',
          },
          {
            label: 'Evidence',
            text: 'At the same light intensity of 300, increasing CO₂ raises oxygen production from $6$ to $10\\,\\mathrm{µmol/min}$.',
            type: 'text',
          },
          {
            label: 'Reasoning',
            text: 'More light alone does not lift the low-CO₂ plateau, but more CO₂ does. This supports CO₂ supply as a limiting factor in that treatment. The graph alone does not establish what causes the high-CO₂ plateau.',
            type: 'text',
          },
        ],
      },
      {
        answer: { accepted: ['4'], type: 'short', unit: 'µmol/min' },
        blocks: [
          {
            text: 'At light intensity 300, calculate the increase in oxygen production when changing from low to high CO₂.',
            type: 'text',
          },
        ],
        id: 'q14:increase',
        marks: 1,
        solution: [
          {
            text: '$$\\Delta r=r_{\\mathrm{high}}-r_{\\mathrm{low}}=10-6=4\\,\\mathrm{µmol/min}$$',
            type: 'text',
          },
          {
            ...photosynthesis,
            kind: 'area',
            title: 'Both rate curves, shown as filled areas',
          },
          {
            text: 'Compare the heights at the same light intensity. The shaded areas are visual aids, not total oxygen amounts: the horizontal axis is light intensity, not time.',
            type: 'text',
          },
        ],
      },
      {
        answer: { correct: false, type: 'boolean' },
        blocks: [
          {
            text: 'Temperature was deliberately changed between the two CO₂ treatments.',
            type: 'text',
          },
        ],
        id: 'q14:control',
        marks: 1,
        solution: [
          {
            header: true,
            rows: [
              ['Role', 'Variable'],
              ['Independent', 'Light intensity and CO₂ concentration'],
              ['Dependent', 'Rate of oxygen production'],
              ['Controlled', 'Temperature'],
            ],
            type: 'table',
          },
        ],
      },
    ],
    stem: [
      {
        text: 'A student varies light intensity while keeping temperature constant. The illustrative data show oxygen production at low and high carbon dioxide concentrations.',
        type: 'text',
      },
      photosynthesis,
    ],
  },
  {
    id: 'q15',
    labels: 'numbers',
    layout: 'paper',
    parts: [
      {
        answer: {
          accepted: [['mitochondria', 'mitochondrion'], ['glucose'], ['ATP']],
          type: 'gaps',
        },
        blocks: [
          {
            text: 'Complete the summary below. Write one word in each gap.',
            type: 'text',
          },
          {
            text: 'Aerobic respiration takes place mainly in the (1) ______. There, the energy stored in (2) ______ is released step by step and captured in (3) ______, which the cell spends on its work.',
            type: 'text',
          },
        ],
        id: 'q15:part',
        marks: 3,
        solution: [
          {
            text: '(1) Mitochondria host the Krebs cycle and the electron transport chain. (2) Glucose is the usual fuel. (3) ATP carries the released energy.',
            type: 'text',
          },
        ],
      },
    ],
    stem: [],
  },
];
