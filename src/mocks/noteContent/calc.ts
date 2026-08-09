import { mermaidNode } from '@/features/materials/document';
import {
  bullet,
  callout,
  codeBlock,
  equation,
  heading,
  hr,
  inlineEquation,
  numbered,
  p,
  quote,
  type SeedNote,
  table,
  text,
  toc,
  todo,
} from './helpers';

/** Calculus II — showcase math (block + inline), tables, code, structured lists. */
export const calcNotes: SeedNote[] = [
  {
    chapterId: 'ch_c1',
    daysAgo: 1,
    id: 'mat_note_calc_ibp',
    title: 'Integration by parts workshop',
    value: [
      heading(1, 'Integration by parts'),
      toc(),
      p([
        text(
          'When a product of functions does not match a basic antiderivative, try '
        ),
        text('integration by parts', { bold: true }),
        text('. The formula:'),
      ]),
      equation('\\int u\\,dv = uv - \\int v\\,du'),
      callout(
        [
          text('LIATE heuristic for choosing '),
          text('u', { italic: true }),
          text(
            ': Logarithmic → Inverse trig → Algebraic → Trig → Exponential.'
          ),
        ],
        'info'
      ),
      heading(2, 'Worked example'),
      p([text('Compute '), inlineEquation('\\int x e^{x}\\,dx'), text('.')]),
      numbered([
        text('Set '),
        inlineEquation('u = x'),
        text(', '),
        inlineEquation('dv = e^{x}\\,dx'),
      ]),
      numbered([
        text('Then '),
        inlineEquation('du = dx'),
        text(', '),
        inlineEquation('v = e^{x}'),
      ]),
      numbered([
        text('Apply the formula → '),
        inlineEquation('x e^{x} - \\int e^{x}\\,dx = e^{x}(x - 1) + C'),
      ]),
      heading(2, 'Common pitfalls'),
      bullet([
        text('Forgetting '),
        text('+ C', { highlight: true }),
        text(' on indefinite integrals'),
      ]),
      bullet('Choosing u so that du gets harder, not easier'),
      bullet([
        text('Dropping the sign when rearranging '),
        inlineEquation('\\int v\\,du'),
      ]),
      hr(),
      heading(2, 'Quick reference'),
      table(
        ['Integral', 'Result', 'Notes'],
        [
          ['∫ x sin x dx', '−x cos x + ∫ cos x dx', 'u = x'],
          ['∫ ln x dx', 'x ln x − x + C', 'u = ln x'],
          ['∫ arctan x dx', 'x arctan x − ½ ln(1+x²) + C', 'parts + algebra'],
        ]
      ),
      heading(3, 'Symbolic sketch'),
      codeBlock(
        [
          'def ibp(u, dv):',
          '    """Return uv - ∫ v du (symbolic sketch)."""',
          '    v = antiderivative(dv)',
          '    du = derivative(u)',
          '    return u * v - integrate(v * du)',
        ],
        'python'
      ),
      quote(
        'Tabular method shines for ∫ xⁿ eˣ or ∫ xⁿ sin x — keep differentiating until zero.'
      ),
      heading(2, 'Before the quiz'),
      todo('Finish odd exercises 1–15 from the packet', true),
      todo('Re-derive ∫ ln x dx from scratch'),
      todo('Time a mixed set under 20 minutes'),
      p([
        text('Units matter in applied problems: if '),
        text('x', { code: true }),
        text(' is in seconds, the antiderivative may carry seconds'),
        text('2', { superscript: true }),
        text(' depending on the integrand.'),
      ]),
    ],
    workspaceId: 'ws_calc',
    workspaceName: 'Calculus II',
  },
  {
    chapterId: 'ch_c2',
    daysAgo: 4,
    id: 'mat_note_calc_series',
    title: 'Sequences & series — convergence map',
    value: [
      heading(1, 'Sequences & series'),
      p(
        'A series converges when its sequence of partial sums approaches a finite limit.'
      ),
      equation(
        '\\sum_{n=1}^{\\infty} a_n \\text{ converges} \\iff \\lim_{N\\to\\infty} S_N \\in \\mathbb{R}'
      ),
      heading(2, 'Test checklist'),
      callout(
        'Always try the nth-term test for divergence first — it is cheap.',
        'success'
      ),
      numbered('nth-term (divergence) test'),
      numbered('Geometric / p-series recognition'),
      numbered('Integral, comparison, limit comparison'),
      numbered('Ratio / root tests (factorials, exponentials)'),
      numbered('Alternating series (Leibniz) + absolute vs conditional'),
      mermaidNode(
        'flowchart TD\n  Start[Look at a_n] --> Nth{nth term → 0?}\n  Nth -->|No| Div[Diverges]\n  Nth -->|Yes| Form{Recognize form?}\n  Form -->|Geometric / p| Decide[Apply closed test]\n  Form -->|No| Tools[Ratio / root / compare / integral]',
        'Choosing a convergence test',
        'mermaid_calc_series'
      ),
      p([
        text('Taylor reminder near '),
        inlineEquation('a'),
        text(': '),
        inlineEquation(
          'f(x)=\\sum_{n=0}^{\\infty}\\frac{f^{(n)}(a)}{n!}(x-a)^n'
        ),
        text('.'),
      ]),
      p([
        text('H₂O', { italic: true }),
        text(' wait — wrong class. In calc we write H'),
        text('2', { subscript: true }),
        text('O only when a chem friend hijacks the board.'),
      ]),
    ],
    workspaceId: 'ws_calc',
    workspaceName: 'Calculus II',
  },
];
