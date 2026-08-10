const mindmapRegex = /^\s*mindmap(?:\s|$)/i;

export function mermaidBlockLabel(code: string): 'Diagram' | 'Mindmap' {
  return mindmapRegex.test(code) ? 'Mindmap' : 'Diagram';
}
