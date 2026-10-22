/** Why a diagram could not be drawn: the source line mermaid blamed, or none
 * when the failure names no line (an unknown diagram type, a render error);
 * a limit it ran into has its own message. */
export interface MermaidFailure {
  line: number | null;
  reason?: MermaidLimit;
}

/** A source over `MERMAID_SOURCE_MAX`, more links than mermaid draws, or a
 * render still running at the time limit. */
export type MermaidLimit = 'edges' | 'tooLarge' | 'tooLong';

/** mermaid's own `maxEdges`, past which it refuses ("Edge limit exceeded"). */
export const MERMAID_EDGES_MAX = 500;

/** A render refused before it ran, or stopped while it ran. */
export class MermaidLimitError extends Error {
  readonly reason: MermaidLimit;
  constructor(reason: MermaidLimit) {
    super(`mermaid ${reason}`);
    this.reason = reason;
  }
}

const LINE_IN_MESSAGE = /\bline (\d+)/i;
const EDGE_LIMIT = /Edge limit exceeded/i;

/**
 * Reads the line out of a mermaid error. The parsers report it in the message
 * ("Parse error on line 3:") counted in the trimmed source `renderMermaid`
 * draws, so blank lines cut from the top are added back; an error at the end
 * points one past the last line, so the line is clamped into the source.
 */
export function mermaidFailure(error: unknown, code: string): MermaidFailure {
  if (error instanceof MermaidLimitError)
    return { line: null, reason: error.reason };
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (EDGE_LIMIT.test(message)) return { line: null, reason: 'edges' };
  const match = LINE_IN_MESSAGE.exec(message);
  if (!match) return { line: null };
  const cutAbove = code.length - code.trimStart().length;
  const offset = code.slice(0, cutAbove).split('\n').length - 1;
  const lines = code.trimEnd().split('\n').length;
  return {
    line: Math.min(Math.max(Number(match[1]) + offset, 1), lines),
  };
}
