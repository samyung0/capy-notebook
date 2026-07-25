import { describe, expect, it } from 'vitest';
import { columnGroupFromWidths, EDITOR_COMMANDS } from './editorCommands';
import { COLUMN_LAYOUTS } from './richBlockConfig';

describe('editor insertion command catalog', () => {
  it('covers every grouped insertion surface with an icon', () => {
    const groups = new Set(EDITOR_COMMANDS.map((command) => command.group));
    expect(groups).toEqual(
      new Set(['basic', 'lists', 'media', 'advanced', 'inline'])
    );
    expect(EDITOR_COMMANDS.every((command) => command.icon)).toBe(true);
  });

  it('includes the complete heading and list set', () => {
    expect(
      EDITOR_COMMANDS.filter((command) =>
        command.id.startsWith('heading-')
      ).map((command) => command.id)
    ).toEqual([
      'heading-1',
      'heading-2',
      'heading-3',
      'heading-4',
      'heading-5',
      'heading-6',
    ]);
    expect(
      EDITOR_COMMANDS.filter((command) => command.group === 'lists').map(
        (command) => command.id
      )
    ).toEqual(['bulleted-list', 'numbered-list', 'task-list']);
  });

  it('creates an insertion node for every supported column layout', () => {
    for (const layout of COLUMN_LAYOUTS) {
      const node = columnGroupFromWidths(layout.widths);
      expect(node.type).toBe('column_group');
      expect(node.children.map((column) => column.width)).toEqual(
        layout.widths
      );
      expect(
        node.children.every((column) => column.children[0]?.type === 'p')
      ).toBe(true);
    }
  });
});
