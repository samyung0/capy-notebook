import source from "./source.json";
import katex from "katex";
import "katex/dist/katex.min.css";

const value = source.note.value;
const refs = Object.fromEntries(
  source.embedded.map((entry) => [entry.id, entry.block]),
);
const root = document.getElementById("paper");
let profile = "study",
  format = "docx";
const escape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const plain = (node) =>
  "text" in node ? node.text : node.children.map(plain).join("");
const slug = (text) =>
  text
    .toLowerCase()
    .replaceAll("&", "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const headings = value.filter((node) => /^h[1-6]$/.test(node.type));
const quiz = source.embedded
  .find((entry) => entry.kind === "quiz")
  .block.children.map((node) => node.question);
const cards = source.embedded
  .find((entry) => entry.kind === "flashcards")
  .block.children.map((node) => ({
    front: plain(node.children[0]),
    back: plain(node.children[1]),
  }));
const answerText = (answer) =>
  answer.type === "boolean"
    ? answer.correct
      ? "True"
      : "False"
    : ["mcq", "multi"].includes(answer.type)
      ? answer.correct
          .map(
            (index) =>
              `${String.fromCharCode(65 + index)}. ${answer.options[index]}`,
          )
          .join("; ")
      : answer.accepted.join(" / ");
const solutions = (part) => part.solution.map((block) => block.text).join("\n");
const questionsText = (question) =>
  [...question.stem, ...question.parts.flatMap((part) => part.blocks)]
    .map((block) => block.text)
    .join("\n");
function inline(node, md = false) {
  if ("text" in node) {
    let result = md
      ? node.text.replace(/[\\`*_\[\]<>]/g, "\\$&")
      : escape(node.text);
    if (md) {
      if (node.code || node.kbd) result = "`" + node.text + "`";
      if (node.bold) result = "**" + result + "**";
      if (node.italic) result = "*" + result + "*";
      if (node.strikethrough) result = "~~" + result + "~~";
      for (const [mark, tag] of [
        ["underline", "u"],
        ["highlight", "mark"],
        ["subscript", "sub"],
        ["superscript", "sup"],
      ])
        if (node[mark]) result = `<${tag}>${result}</${tag}>`;
      return result;
    }
    for (const [mark, tag] of [
      ["bold", "strong"],
      ["italic", "em"],
      ["underline", "u"],
      ["strikethrough", "s"],
      ["code", "code"],
      ["kbd", "kbd"],
      ["highlight", "mark"],
      ["subscript", "sub"],
      ["superscript", "sup"],
    ])
      if (node[mark]) result = `<${tag}>${result}</${tag}>`;
    if (format === "docx") {
      const style = [
        node.color && `color:${node.color}`,
        node.backgroundColor && `background-color:${node.backgroundColor}`,
        node.fontSize && `font-size:${node.fontSize}`,
        node.fontFamily && `font-family:${node.fontFamily}`,
      ]
        .filter(Boolean)
        .join(";");
      if (style) result = `<span style="${escape(style)}">${result}</span>`;
    }
    return result;
  }
  if (node.type === "a")
    return md
      ? `[${node.children.map((child) => inline(child, true)).join("")}](${node.url})`
      : `<a href="${escape(node.url)}">${node.children.map((child) => inline(child)).join("")}</a>`;
  if (node.type === "mention")
    return md ? "@" + node.value : escape("@" + node.value);
  if (node.type === "inline_equation")
    return md
      ? "$" + node.texExpression + "$"
      : katex.renderToString(node.texExpression, { throwOnError: true });
  throw new Error("Unhandled inline " + node.type);
}
function answerHtml(question, index) {
  const part = question.parts[0];
  return `<div class="answer"><p><b>${index + 1}. ${escape(answerText(part.answer))}</b></p><p><small>Marking scheme · ${part.markscheme.length} mark</small><br>${part.markscheme.map(escape).join("<br>")}</p><p><small>Worked solution</small><br>${escape(solutions(part))}</p></div>`;
}
function quizHtml() {
  return (
    quiz
      .map((question, index) => {
        const part = question.parts[0],
          a = part.answer;
        const options =
          a.options || (a.type === "boolean" ? ["True", "False"] : []);
        return `<section class="question"><div class="qhead"><strong>${index + 1}. ${escape(questionsText(question))}</strong><span class="marks">${part.markscheme.length} mark</span></div><ul class="options">${options.map((option, i) => `<li>${a.type === "multi" ? "☐" : String.fromCharCode(65 + i) + "."} ${escape(option)}</li>`).join("")}</ul>${profile === "worksheet" ? '<div class="writing" aria-label="Answer space"></div>' : a.type === "short" ? "<p>Answer: ______________________________</p>" : ""}${profile === "annotated" ? answerHtml(question, index) : ""}</section>`;
      })
      .join("") +
    (profile === "study"
      ? `<section class="answer-key"><h3>Quiz answer key</h3>${quiz.map(answerHtml).join("")}</section>`
      : "")
  );
}
function cardsHtml() {
  if (profile === "annotated")
    return `<table><thead><tr><th>Front</th><th>Back</th></tr></thead><tbody>${cards.map((card) => `<tr><td>${escape(card.front)}</td><td>${escape(card.back)}</td></tr>`).join("")}</tbody></table>`;
  return cards
    .map(
      (card, index) =>
        `<section class="flash"><div class="label">Card ${index + 1}</div><p>${escape(card.front)}</p>${profile === "worksheet" ? '<div class="writing" aria-label="Recall space"></div>' : `<p>${escape(card.back)}</p>`}</section>`,
    )
    .join("");
}
function diagram(node) {
  const labels = ["Glucose", "Glycolysis", "Pyruvate", "Krebs", "ETC", "ATP"];
  return `<svg class="diagram" viewBox="0 0 280 400" role="img" aria-label="Glucose to glycolysis to pyruvate to Krebs to ETC to ATP"><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#80768d"/></marker></defs>${labels.map((label, i) => `<rect x="60" y="${i * 66 + 6}" width="160" height="38" rx="5" fill="#f4f1f7" stroke="#b1a6bd"/><text x="140" y="${i * 66 + 31}" text-anchor="middle" font-family="Segoe UI" font-size="14" fill="#29232f">${label}</text>${i < 5 ? `<line x1="140" y1="${i * 66 + 44}" x2="140" y2="${i * 66 + 69}" stroke="#80768d" marker-end="url(#arrow)"/>` : ""}`).join("")}</svg><p class="caption">${escape(plain(node))}</p>`;
}
function blockHtml(node) {
  const t = node.type,
    contents = () =>
      node.children
        .map((child) =>
          "text" in child ||
          ["a", "mention", "inline_equation"].includes(child.type)
            ? inline(child)
            : blockHtml(child),
        )
        .join("");
  if (/^h[1-6]$/.test(t))
    return `<${t} id="${slug(plain(node))}">${contents()}</${t}>`;
  if (t === "p") {
    const body = contents();
    if (node.listStyleType)
      return `<p style="padding-left:${node.indent * 16}px">${node.listStyleType === "disc" ? "•" : node.listStyleType === "todo" ? (node.checked ? "☑" : "☐") : '<span class="numbered"></span>'} ${body}</p>`;
    return `<p${format === "docx" && node.align ? ` style="text-align:${node.align}"` : ""}>${body}</p>`;
  }
  if (t === "toc")
    return `<nav class="toc" aria-label="Document contents">${headings.map((node) => `<a style="padding-left:${(Number(node.type[1]) - 1) * 9}px" href="#${slug(plain(node))}">${escape(plain(node))}</a>`).join("")}</nav>`;
  if (t === "blockquote") return "<blockquote>" + contents() + "</blockquote>";
  if (t === "hr") return "<hr>";
  if (t === "callout")
    return `<${format === "docx" ? "div" : "blockquote"} class="${format === "docx" ? "callout " + node.variant : ""}"><b>${node.variant[0].toUpperCase() + node.variant.slice(1)}</b>${contents()}</${format === "docx" ? "div" : "blockquote"}>`;
  if (t === "code_block")
    return `<pre><code>${escape(node.children.map(plain).join("\n"))}</code></pre>`;
  if (t === "table") return "<table>" + contents() + "</table>";
  if (["tr", "th", "td"].includes(t)) return `<${t}>${contents()}</${t}>`;
  if (t === "column_group")
    return format === "docx"
      ? `<table class="columns"><tr>${node.children.map((child) => `<td style="width:${child.width}">${child.children.map(blockHtml).join("")}</td>`).join("")}</tr></table>`
      : node.children
          .map(
            (child, i) =>
              `<p><b>Column ${i + 1}</b></p>${child.children.map(blockHtml).join("")}`,
          )
          .join("");
  if (t === "equation")
    return katex.renderToString(node.texExpression, {
      displayMode: true,
      throwOnError: true,
    });
  if (t === "video") {
    const url = `https://www.youtube.com/watch?v=${node.videoId}`;
    return format === "docx"
      ? `<div class="video"><p><a href="${url}" target="_blank" rel="noopener noreferrer">YouTube video</a></p><a class="video-preview" href="${url}" target="_blank" rel="noopener noreferrer" aria-label="Watch video on YouTube"><img src="https://i.ytimg.com/vi/${escape(node.videoId)}/hqdefault.jpg" alt="YouTube video preview" loading="lazy" referrerpolicy="no-referrer"><span class="video-play" aria-hidden="true">▶</span></a></div>`
      : `<p><a href="${url}">YouTube video</a></p>`;
  }
  if (t === "mermaid")
    return format === "docx"
      ? diagram(node)
      : `<p>${escape(plain(node))}</p><pre><code>${escape(node.source)}</code></pre>`;
  if (t === "material_ref")
    return node.refKind === "quiz" ? quizHtml() : cardsHtml();
  throw new Error("Unhandled block " + t);
}
function answerMd(question, index) {
  const p = question.parts[0];
  return `**${index + 1}. ${answerText(p.answer)}**\n\nMarking scheme (${p.markscheme.length} mark):\n${p.markscheme.map((item) => "- " + item).join("\n")}\n\nWorked solution: ${solutions(p)}\n\n`;
}
function quizMd() {
  return (
    quiz
      .map((q, i) => {
        const p = q.parts[0],
          a = p.answer;
        return `### Question ${i + 1}\n\n${questionsText(q)} (${p.markscheme.length} mark)\n\n${(a.options || (a.type === "boolean" ? ["True", "False"] : [])).map((o, j) => `${a.type === "multi" ? "- [ ]" : String.fromCharCode(65 + j) + "."} ${o}`).join("\n")}\n\n${profile === "worksheet" || a.type === "short" ? "Answer: ______________________________\n\n" : ""}${profile === "annotated" ? answerMd(q, i) : ""}`;
      })
      .join("") +
    (profile === "study"
      ? "### Quiz answer key\n\n" + quiz.map(answerMd).join("")
      : "")
  );
}
function cardsMd() {
  if (profile === "annotated")
    return (
      "| Front | Back |\n| --- | --- |\n" +
      cards.map((card) => `| ${card.front} | ${card.back} |`).join("\n") +
      "\n\n"
    );
  return cards
    .map(
      (card, i) =>
        `### Card ${i + 1}\n\n**Front:** ${card.front}\n\n${profile === "worksheet" ? "Recall: ______________________________" : `**Back:** ${card.back}`}\n\n`,
    )
    .join("");
}
function blockMd(node) {
  const t = node.type;
  const text = () => node.children.map((child) => inline(child, true)).join("");
  if (/^h[1-6]$/.test(t))
    return "#".repeat(Number(t[1])) + " " + text() + "\n\n";
  if (t === "toc")
    return (
      headings
        .map(
          (h) =>
            "  ".repeat(Number(h.type[1]) - 1) +
            `- [${plain(h)}](#${slug(plain(h))})`,
        )
        .join("\n") + "\n\n"
    );
  if (t === "p") {
    let marker = "";
    if (node.listStyleType === "disc") marker = "- ";
    if (node.listStyleType === "decimal") marker = "1. ";
    if (node.listStyleType === "todo")
      marker = node.checked ? "- [x] " : "- [ ] ";
    return marker + text() + "\n\n";
  }
  if (t === "hr") return "---\n\n";
  if (t === "blockquote" || t === "callout")
    return (
      (t === "callout"
        ? "> **" +
          node.variant[0].toUpperCase() +
          node.variant.slice(1) +
          "**\n>\n"
        : "") +
      node.children
        .map(blockMd)
        .join("")
        .trim()
        .split("\n")
        .map((line) => "> " + line)
        .join("\n") +
      "\n\n"
    );
  if (t === "code_block")
    return (
      "```" +
      node.lang +
      "\n" +
      node.children.map(plain).join("\n") +
      "\n```\n\n"
    );
  if (t === "table") {
    const rows = node.children.map(
      (row) =>
        "| " +
        row.children
          .map((cell) => plain(cell).replaceAll("|", "\\|"))
          .join(" | ") +
        " |",
    );
    rows.splice(
      1,
      0,
      "| " + node.children[0].children.map(() => "---").join(" | ") + " |",
    );
    return rows.join("\n") + "\n\n";
  }
  if (t === "column_group")
    return node.children
      .map(
        (column, i) =>
          `**Column ${i + 1}**\n\n` + column.children.map(blockMd).join(""),
      )
      .join("");
  if (t === "equation") return "$$\n" + node.texExpression + "\n$$\n\n";
  if (t === "video")
    return `[YouTube video](https://www.youtube.com/watch?v=${node.videoId})\n\n`;
  if (t === "mermaid")
    return plain(node) + "\n\n```mermaid\n" + node.source + "\n```\n\n";
  if (t === "material_ref")
    return node.refKind === "quiz" ? quizMd() : cardsMd();
  throw new Error("Unhandled Markdown " + t);
}
function worksheetKey(md) {
  if (profile !== "worksheet") return "";
  return md
    ? "## Answers\n\n### Quiz\n\n" +
        quiz.map(answerMd).join("") +
        "### Flashcards\n\n" +
        cards
          .map((card, i) => `**${i + 1}. ${card.front}**\n\n${card.back}\n\n`)
          .join("")
    : `<section class="answer-key"><h2 id="answers">Answers</h2><h3>Quiz</h3>${quiz.map(answerHtml).join("")}<h3>Flashcards</h3>${cards.map((card, i) => `<p><b>${i + 1}. ${escape(card.front)}</b><br>${escape(card.back)}</p>`).join("")}</section>`;
}
const coverage = [
  [
    "Headings 1–6 and paragraphs",
    "Native heading syntax and text",
    "Word heading styles and paragraphs",
  ],
  [
    "Table of contents",
    "Resolved heading links",
    "Static linked contents; no stale page numbers",
  ],
  [
    "Bold, italic, strike, code",
    "Native Markdown marks",
    "Native text styling",
  ],
  [
    "Underline, highlight, subscript, superscript",
    "Small HTML tags; support varies by reader",
    "Native run properties",
  ],
  ["Keyboard shortcut", "Inline code", "Monospace key labels"],
  [
    "Color, background, font size and family",
    "Keep text; appearance simplified",
    "Preserve authored run styles",
  ],
  [
    "Alignment",
    "Reading order retained; alignment simplified",
    "Keep left, center, right, justified",
  ],
  [
    "Links and mentions",
    "URL links and stored @display name",
    "Hyperlinks and stored @display name",
  ],
  [
    "Bullets, numbering and todos",
    "Lists and GFM checkboxes",
    "Word lists and static checkboxes",
  ],
  [
    "Quote and divider",
    "Blockquote and horizontal rule",
    "Quote paragraph and divider border",
  ],
  [
    "Callouts, all four variants",
    "Labeled blockquotes",
    "Shaded paragraphs with a text label",
  ],
  ["Code blocks", "Language-tagged fences", "Monospace preformatted text"],
  [
    "Tables",
    "GFM tables for simple cells",
    "Native Word table; preserve spans",
  ],
  [
    "Columns, all three layouts",
    "Read columns left to right",
    "Borderless table with original proportions",
  ],
  [
    "Inline and block equations",
    "LaTeX math, reader-dependent rendering",
    "Rendered equation image with LaTeX alt text initially",
  ],
  [
    "YouTube video",
    "Canonical watch link",
    "Proposed Word online-video object with linked preview and title; playback in Word still needs validation",
  ],
  [
    "Mermaid diagram",
    "Mermaid source fence and caption",
    "Rendered diagram image and caption",
  ],
  [
    "Embedded quiz",
    "All stems, parts, options, marking items and solutions",
    "Native text using the selected answer layout",
  ],
  [
    "Embedded flashcards",
    "Both faces as readable text",
    "Both faces as text or a table",
  ],
  [
    "Charts, absent from this fixture",
    "Image plus data table in an asset bundle",
    "Embedded image with caption; retain data table",
  ],
  [
    "Graphs, absent from this fixture",
    "Saved SVG/PNG asset and description",
    "Embedded rendered image and description",
  ],
  [
    "Uploaded image, absent from this fixture",
    "Relative image path in a ZIP with assets",
    "Embed image bytes, alt text and caption",
  ],
  [
    "Audio and file, absent from this fixture",
    "Descriptive link; bundle attachment for offline use",
    "Descriptive app link; no playable inline widget",
  ],
  [
    "Merged or rich table cells",
    "Flatten to labeled rows if GFM cannot represent structure",
    "Keep table spans and nested paragraphs",
  ],
  [
    "Comments, edit menus, cursors, upload placeholders",
    "No editing UI; pending uploads must be resolved before export",
    "No editing UI; pending uploads must be resolved before export",
  ],
];
function render() {
  document
    .querySelectorAll("[data-profile]")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.profile === profile),
      ),
    );
  document
    .querySelectorAll("[data-format]")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.format === format),
      ),
    );
  root.className =
    "paper" +
    (format === "markdown" ? " md" : format === "coverage" ? " coverage" : "");
  const markdown = value.map(blockMd).join("") + worksheetKey(true);
  window.exportMockMarkdown = markdown;
  if (format === "source") {
    root.innerHTML = '<pre class="source">' + escape(markdown) + "</pre>";
  } else if (format === "coverage") {
    root.innerHTML =
      '<h2>Proposed block conversions</h2><p class="notice">The fixture contains 51 top-level nodes. Charts, graphs and uploads below are additional coverage, not invented content in the source note. These are proposals to choose before app changes.</p><table><thead><tr><th>Block or feature</th><th>Markdown</th><th>DOCX</th></tr></thead><tbody>' +
      coverage
        .map(
          (row) =>
            "<tr>" +
            row.map((text) => "<td>" + escape(text) + "</td>").join("") +
            "</tr>",
        )
        .join("") +
      "</tbody></table><p>Readable Markdown is a shareable document. Reimporting it will not reconstruct interactive quiz, flashcard or column nodes. The current JSON export also contains references, so it is not a complete offline backup of embedded materials.</p>";
  } else {
    root.innerHTML = value.map(blockHtml).join("") + worksheetKey(false);
    root
      .querySelectorAll(".numbered")
      .forEach((node, index) => (node.textContent = index + 1 + "."));
  }
  document.getElementById("status").textContent =
    format === "docx"
      ? "DOCX layout mock · Not a generated Word file. The video preview opens YouTube here; native playback in Word, pagination and image conversion still need validation."
      : format === "coverage"
        ? "All block types accounted for · Proposed export behavior"
        : format === "source"
          ? "Portable Markdown source · No quiz YAML or custom MDX components"
          : "Markdown rendering mock · Math, Mermaid and inline HTML support depends on the reader. Fonts, colors and alignment are simplified.";
}
document.querySelectorAll("[data-profile]").forEach((button) =>
  button.addEventListener("click", () => {
    profile = button.dataset.profile;
    render();
  }),
);
document.querySelectorAll("[data-format]").forEach((button) =>
  button.addEventListener("click", () => {
    format = button.dataset.format;
    render();
  }),
);
document.getElementById("jump").addEventListener("change", (event) => {
  if (format === "source" || format === "coverage") {
    format = "docx";
    render();
  }
  if (event.target.value)
    document
      .getElementById(event.target.value)
      ?.scrollIntoView({ behavior: "smooth" });
  else window.scrollTo({ top: 0, behavior: "smooth" });
});
document.getElementById("download").addEventListener("click", () => {
  const url = URL.createObjectURL(
    new Blob([window.exportMockMarkdown], { type: "text/markdown" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `editor-feature-matrix-${profile}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
render();

