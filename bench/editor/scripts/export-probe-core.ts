let markdownRuntime:
  | Promise<{
      editor: ReturnType<typeof import("platejs").createSlateEditor>;
      serializeMd: typeof import("@platejs/markdown").serializeMd;
    }>
  | undefined;

interface Input {
  count: number;
  textLength: number;
  format: "markdown" | "docx";
  image?: boolean;
  value?: { type: string; children: { text: string }[] }[];
}

// A conversion-kernel probe, not the chosen production export implementation.
// No network, editor mounting, diagram rendering or reference fetch is timed.
export async function convert(input: Input) {
  const text = "Membranes separate compartments. ATP powers cellular activity. "
    .repeat(Math.ceil(input.textLength / 62))
    .slice(0, input.textLength);
  const value =
    input.value ??
    Array.from({ length: input.count }, (_, index) => ({
      type: index % 20 === 0 ? "h2" : "p",
      children: [{ text: `Block ${index + 1}: ${text}` }],
    }));
  const sourceBytes = new TextEncoder().encode(
    JSON.stringify({ schemaVersion: 1, value }),
  ).length;
  const start = performance.now();
  if (input.format === "markdown") {
    markdownRuntime ??= (async () => {
      const [
        { serializeMd },
        { createSlateEditor },
        { BaseBasicBlocksPlugin, BaseBasicMarksPlugin },
        { noteMarkdownPlugin },
      ] = await Promise.all([
        import("@platejs/markdown"),
        import("platejs"),
        import("@platejs/basic-nodes"),
        import("../../../src/features/notes/markdown"),
      ]);
      return {
        serializeMd,
        editor: createSlateEditor({
          plugins: [
            BaseBasicBlocksPlugin,
            BaseBasicMarksPlugin,
            noteMarkdownPlugin,
          ],
        }),
      };
    })();
    const { editor, serializeMd } = await markdownRuntime;
    const result = serializeMd(editor, { value });
    if (!result.includes(`Block ${input.count}: `))
      throw new Error("Last block missing");
    return {
      compute: performance.now() - start,
      sourceBytes,
      nodes: input.count * 2,
      bytes: new TextEncoder().encode(result).length,
    };
  }
  const { htmlToDocxBlob } = await import("@platejs/docx-io");
  let html = value
    .map((node) => `<${node.type}>${node.children[0].text}</${node.type}>`)
    .join("");
  if (input.image)
    html +=
      '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" width="1" height="1">';
  const blob = await htmlToDocxBlob(`<html><body>${html}</body></html>`);
  const signature = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (signature[0] !== 80 || signature[1] !== 75)
    throw new Error("DOCX is not ZIP");
  return {
    compute: performance.now() - start,
    sourceBytes,
    nodes: input.count * 2,
    bytes: blob.size,
  };
}
