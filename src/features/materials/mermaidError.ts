/** Why a diagram could not be drawn: the source line mermaid blamed, or none
 * when the failure names no line (an unknown diagram type, a render error). */
export interface MermaidFailure {
  line: number | null;
}

const LINE_IN_MESSAGE = /\bline (\d+)/i;

/**
 * Reads the line out of a mermaid error. The parsers report it in the message
 * ("Parse error on line 3:") counted in the trimmed source `renderMermaid`
 * draws, so blank lines cut from the top are added back; an error at the end
 * points one past the last line, so the line is clamped into the source.
 */
export function mermaidFailure(error: unknown, code: string): MermaidFailure {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const match = LINE_IN_MESSAGE.exec(message);
  if (!match) return { line: null };
  const cutAbove = code.length - code.trimStart().length;
  const offset = code.slice(0, cutAbove).split('\n').length - 1;
  const lines = code.trimEnd().split('\n').length;
  return {
    line: Math.min(Math.max(Number(match[1]) + offset, 1), lines),
  };
}
