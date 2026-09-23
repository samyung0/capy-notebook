import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FILE_ICON_NAMES } from '@/components/ui/FileIcon';
import { fileIconName, materialIconName } from './fileIcons';

describe('file icons', () => {
  it('ships a sprite symbol for every icon name', () => {
    const sprite = readFileSync(
      new URL('../assets/catppuccin.svg', import.meta.url),
      'utf8'
    );
    const ids = new Set(
      [...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1])
    );
    expect(FILE_ICON_NAMES.filter((name) => !ids.has(name))).toEqual([]);
    expect(
      [...ids].filter((id) => !FILE_ICON_NAMES.includes(id as never))
    ).toEqual([]);
  });

  it.each([
    [{ kind: 'txt', name: 'membrane_sim.py' }, 'python'],
    [{ kind: 'txt', name: 'Punnett.TSX' }, 'typescript-react'],
    [{ kind: 'txt', name: 'Dockerfile' }, 'docker'],
    [{ kind: 'txt', name: 'Osmosis notes.txt' }, 'text'],
    [{ kind: 'txt', name: 'notes' }, 'text'],
    [{ kind: 'audio', name: 'osmosis.mp4' }, 'video'],
    [{ kind: 'sheet', name: 'readings.csv' }, 'csv'],
    [{ kind: 'image', name: 'diagram.svg' }, 'svg'],
    [{ kind: 'doc', name: 'Cell structure.docx' }, 'ms-word'],
    [{ kind: 'unknown', name: 'assets.zip' }, 'zip'],
    [{ kind: 'unknown', name: 'blob' }, '_file'],
  ] as const)('maps %o to %s', (file, icon) => {
    expect(fileIconName(file)).toBe(icon);
  });

  it('maps every material type', () => {
    expect(materialIconName('quiz')).toBe('stackblitz');
    expect(materialIconName('note')).toBe('java-enum');
    expect(materialIconName('diagram')).toBe('api-blueprint');
  });
});
