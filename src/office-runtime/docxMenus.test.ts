import type { HostMenu } from '@betteroffice/docx-react';
import { describe, expect, it } from 'vitest';
import { editorMenus } from './docxMenus';

const item = (id: string) => ({
  edits: true,
  id,
  kind: 'item' as const,
  label: id,
});

describe('DOCX editor menus', () => {
  it('leave out Page setup and Watermark, whose changes are not saved', () => {
    const menus: HostMenu[] = [
      { id: 'file', items: [item('save'), item('page-setup')], label: 'File' },
      {
        id: 'insert',
        items: [
          item('insert-image'),
          item('insert-link'),
          item('insert-watermark'),
          { kind: 'separator' },
          item('insert-toc'),
        ],
        label: 'Insert',
      },
    ];
    const [file, insert] = editorMenus(menus, 'en');
    expect(
      file.items.map((entry) => ('id' in entry ? entry.id : entry.kind))
    ).toEqual([
      'capy.save',
      'separator',
      'download',
      'separator',
      'capy.print',
    ]);
    expect(
      insert.items.map((entry) => ('id' in entry ? entry.id : entry.kind))
    ).toEqual(['insert-image', 'insert-link', 'separator', 'insert-toc']);
  });
});
