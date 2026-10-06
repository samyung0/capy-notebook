import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  isOfficeHostMessage,
  isOfficeRuntimeMessage,
  isOutdatedOfficeRuntime,
  OFFICE_PROTOCOL_VERSION,
} from './officeProtocol';
import {
  isCurrentOfficeRuntimeMessage,
  officeRuntimeKey,
  replicaCatchUp,
} from './useOfficeRuntime';

describe('office host protocol', () => {
  it('requires a load to choose its first runtime mode', () => {
    const load = {
      bytes: new ArrayBuffer(4),
      canEdit: true,
      fileName: 'notes.docx',
      format: 'docx' as const,
      revision: 1,
      type: 'load' as const,
      version: OFFICE_PROTOCOL_VERSION,
    };

    expect(isOfficeHostMessage({ ...load, mode: 'view' })).toBe(true);
    expect(isOfficeHostMessage({ ...load, mode: 'edit' })).toBe(false);
    expect(
      isOfficeHostMessage({
        ...load,
        collaboration: { epoch: 1, initialUpdate: new ArrayBuffer(2) },
        mode: 'edit',
      })
    ).toBe(true);
    expect(isOfficeHostMessage(load)).toBe(false);
  });

  it('does not allow an existing runtime to switch document engines in place', () => {
    expect(
      isOfficeHostMessage({
        mode: 'edit',
        type: 'set-mode',
        version: OFFICE_PROTOCOL_VERSION,
      })
    ).toBe(false);
    expect(
      isOfficeHostMessage({
        bytes: new ArrayBuffer(4),
        revision: 2,
        type: 'save-committed',
        version: OFFICE_PROTOCOL_VERSION,
      })
    ).toBe(false);
  });

  it('accepts capability updates sent after the iframe loads', () => {
    expect(
      isOfficeHostMessage({
        canEdit: true,
        type: 'set-capabilities',
        version: OFFICE_PROTOCOL_VERSION,
      })
    ).toBe(true);
  });

  it("accepts only Capy's own styles, themes and locales, with the narrow flag", () => {
    const message = {
      locale: 'zh',
      narrow: false,
      style: 'classroom',
      theme: 'mocha',
      type: 'set-appearance',
      version: OFFICE_PROTOCOL_VERSION,
    };
    expect(isOfficeHostMessage(message)).toBe(true);
    expect(isOfficeHostMessage({ ...message, style: 'notion' })).toBe(true);
    expect(isOfficeHostMessage({ ...message, theme: 'dark' })).toBe(false);
    expect(isOfficeHostMessage({ ...message, style: undefined })).toBe(false);
    expect(isOfficeHostMessage({ ...message, narrow: undefined })).toBe(false);
    expect(isOfficeHostMessage({ ...message, locale: 'zh-CN' })).toBe(false);
  });

  it('carries menu clicks, picked files and render requests to the runtime', () => {
    const version = OFFICE_PROTOCOL_VERSION;
    const accepted = [
      { id: 'zoom:125', type: 'menu-command', version },
      { id: 'insert-table', type: 'menu-command', value: '3x4', version },
      {
        bytes: new ArrayBuffer(4),
        id: 'insert-image',
        mimeType: 'image/png',
        name: 'cell.png',
        type: 'menu-file',
        version,
      },
      { id: 'r1', kind: 'print', type: 'render', version },
      { id: 'r2', kind: 'png', type: 'render', version },
    ];
    for (const message of accepted)
      expect(isOfficeHostMessage(message)).toBe(true);
    expect(
      isOfficeHostMessage({ id: 'r3', kind: 'pdf', type: 'render', version })
    ).toBe(false);
    expect(
      isOfficeHostMessage({ id: 'x', type: 'menu-command', value: 3, version })
    ).toBe(false);
  });

  it('accepts menus only in the shape the header draws', () => {
    const menus = (items: unknown[], actions: unknown[] = []) => ({
      actions,
      menus: [{ id: 'file', items, label: 'File' }],
      revision: 1,
      type: 'menus',
      version: OFFICE_PROTOCOL_VERSION,
    });
    const download = {
      icon: 'download',
      id: 'download',
      items: [{ id: 'capy.download', kind: 'item', label: 'Word document' }],
      kind: 'submenu',
      label: 'Download',
    };
    expect(
      isOfficeRuntimeMessage(
        menus(
          [
            { id: 'capy.save', kind: 'item', label: 'Save', shortcut: '⌘S' },
            { kind: 'separator' },
            download,
            { checked: true, id: 'show-outline', kind: 'item', label: 'X' },
            { id: 'insert-image', kind: 'item', label: 'Image', pick: 'image' },
            { id: 'insert-table', kind: 'grid' },
          ],
          [{ icon: 'presentation', id: 'view.present', label: 'Present' }]
        )
      )
    ).toBe(true);
    const nested = (depth: number): unknown =>
      depth
        ? {
            id: `d${depth}`,
            items: [nested(depth - 1)],
            kind: 'submenu',
            label: 'Deeper',
          }
        : { id: 'leaf', kind: 'item', label: 'Leaf' };
    for (const bad of [
      [{ icon: 'not-an-icon', id: 'a', kind: 'item', label: 'A' }],
      [{ id: 'a', kind: 'item', label: 'A', pick: 'pdf' }],
      [{ id: 'a', kind: 'item', label: '' }],
      [nested(4)],
    ])
      expect(isOfficeRuntimeMessage(menus(bad))).toBe(false);
    expect(
      isOfficeRuntimeMessage(
        menus([], [{ icon: 'not-an-icon', id: 'p', label: 'Present' }])
      )
    ).toBe(false);
    // PPTX Present: a split action whose items hand over full screen or
    // need the presenter window.
    const present = {
      fullscreen: true,
      icon: 'presentation',
      id: 'view.present',
      items: [
        { fullscreen: true, id: 'view.present', kind: 'item', label: 'A' },
        { kind: 'separator' },
        {
          id: 'view.presenterView',
          kind: 'item',
          label: 'B',
          popup: 'presenter',
        },
      ],
      label: 'Present',
    };
    expect(isOfficeRuntimeMessage(menus([], [present]))).toBe(true);
    for (const bad of [
      { ...present, fullscreen: 'yes' },
      {
        ...present,
        items: [{ id: 'x', kind: 'item', label: 'X', popup: 'window' }],
      },
      { ...present, items: 'none' },
    ])
      expect(isOfficeRuntimeMessage(menus([], [bad]))).toBe(false);
  });

  it('accepts a show starting or ending and a request for the presenter window', () => {
    const message = (fields: Record<string, unknown>) => ({
      revision: 1,
      version: OFFICE_PROTOCOL_VERSION,
      ...fields,
    });
    expect(
      isOfficeRuntimeMessage(message({ presenting: true, type: 'presenting' }))
    ).toBe(true);
    expect(
      isOfficeRuntimeMessage(
        message({ id: 'view.presenterView', type: 'open-presenter' })
      )
    ).toBe(true);
    expect(
      isOfficeRuntimeMessage(message({ presenting: 'yes', type: 'presenting' }))
    ).toBe(false);
    expect(isOfficeRuntimeMessage(message({ type: 'open-presenter' }))).toBe(
      false
    );
  });

  it('carries a zoom level or fit both ways, for the next frame of an open file', () => {
    const load = {
      bytes: new ArrayBuffer(4),
      canEdit: true,
      fileName: 'deck.pptx',
      format: 'pptx' as const,
      mode: 'view' as const,
      revision: 1,
      type: 'load' as const,
      version: OFFICE_PROTOCOL_VERSION,
    };
    const zoom = (value: unknown) => ({
      revision: 1,
      type: 'zoom',
      version: OFFICE_PROTOCOL_VERSION,
      zoom: value,
    });
    for (const value of [1.5, 0.25, 4, 'fit']) {
      expect(isOfficeHostMessage({ ...load, zoom: value })).toBe(true);
      expect(isOfficeRuntimeMessage(zoom(value))).toBe(true);
    }
    expect(isOfficeHostMessage(load)).toBe(true);
    for (const value of [
      0,
      -1,
      0.2,
      4.5,
      1e9,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '150%',
      undefined,
    ]) {
      expect(isOfficeHostMessage({ ...load, zoom: value ?? null })).toBe(false);
      expect(isOfficeRuntimeMessage(zoom(value))).toBe(false);
    }
  });

  it('accepts rendered pages as PNG bytes with their size', () => {
    const rendered = (pages: unknown[]) => ({
      id: 'r1',
      pages,
      revision: 1,
      truncated: false,
      type: 'rendered',
      version: OFFICE_PROTOCOL_VERSION,
    });
    const page = { bytes: new ArrayBuffer(8), height: 1056, width: 816 };
    expect(isOfficeRuntimeMessage(rendered([page, page]))).toBe(true);
    expect(isOfficeRuntimeMessage(rendered([{ ...page, width: -1 }]))).toBe(
      false
    );
    expect(isOfficeRuntimeMessage(rendered([{ ...page, bytes: 'png' }]))).toBe(
      false
    );
    // A failed render is its own reply, not the runtime's error.
    expect(
      isOfficeRuntimeMessage({
        id: 'r1',
        revision: 1,
        type: 'render-failed',
        version: OFFICE_PROTOCOL_VERSION,
      })
    ).toBe(true);
  });

  it('accepts a DOCX ready with or without valid timings', () => {
    const ready = (timings?: unknown) => ({
      analysis: { format: 'docx', pageCount: 3 },
      revision: 1,
      timings,
      type: 'ready',
      version: OFFICE_PROTOCOL_VERSION,
    });
    expect(isOfficeRuntimeMessage(ready())).toBe(true);
    expect(isOfficeRuntimeMessage(ready({ loadMs: 120, paintMs: 840 }))).toBe(
      true
    );
    expect(isOfficeRuntimeMessage(ready({ loadMs: 120 }))).toBe(false);
    expect(isOfficeRuntimeMessage(ready({ loadMs: -1, paintMs: 840 }))).toBe(
      false
    );
  });

  it('tells a runtime from another protocol version apart from a malformed message', () => {
    expect(isOutdatedOfficeRuntime({ type: 'initialized', version: 5 })).toBe(
      true
    );
    expect(
      isOutdatedOfficeRuntime({
        type: 'initialized',
        version: OFFICE_PROTOCOL_VERSION,
      })
    ).toBe(false);
    expect(isOutdatedOfficeRuntime({ type: 'ready', version: 5 })).toBe(false);
    expect(isOutdatedOfficeRuntime('initialized')).toBe(false);
  });

  it('rejects capability updates without a boolean permission', () => {
    expect(
      isOfficeHostMessage({
        canEdit: 'true',
        type: 'set-capabilities',
        version: OFFICE_PROTOCOL_VERSION,
      })
    ).toBe(false);
  });

  it('requires every runtime event to identify its loaded revision', () => {
    expect(
      isOfficeRuntimeMessage({
        dirty: true,
        revision: 2,
        type: 'dirty',
        version: OFFICE_PROTOCOL_VERSION,
      })
    ).toBe(true);
    expect(
      isOfficeRuntimeMessage({
        dirty: true,
        type: 'dirty',
        version: OFFICE_PROTOCOL_VERSION,
      })
    ).toBe(false);
  });

  it('rejects malformed data from the isolated runtime', () => {
    expect(
      isOfficeRuntimeMessage({
        analysis: { format: 'docx', pageCount: Number.POSITIVE_INFINITY },
        revision: 2,
        type: 'ready',
        version: OFFICE_PROTOCOL_VERSION,
      })
    ).toBe(false);
    expect(
      isOfficeRuntimeMessage({
        bytes: 'not an ArrayBuffer',
        revision: 2,
        type: 'save',
        version: OFFICE_PROTOCOL_VERSION,
      })
    ).toBe(false);
    expect(
      isOfficeRuntimeMessage({
        dirty: false,
        revision: 2,
        type: 'dirty',
        version: OFFICE_PROTOCOL_VERSION,
      })
    ).toBe(true);
  });
});

describe('office save fencing', () => {
  const fileA = { id: 'file-a' };
  const fileB = { id: 'file-b' };

  it('keeps the editor mounted across metadata and link refetches', () => {
    expect(officeRuntimeKey(fileA, 1)).not.toBe(officeRuntimeKey(fileB, 1));
    expect(officeRuntimeKey(fileA, 1)).toBe(officeRuntimeKey(fileA, 2));
    // A refreshed presigned URL must not remount the runtime.
    const relinked = { ...fileA, url: 'https://blob.test/file-a?sig=2' };
    expect(officeRuntimeKey(relinked, 1)).toBe(officeRuntimeKey(fileA, 1));
  });

  it.each(['ready', 'mode', 'dirty', 'error', 'save'])(
    'rejects a late revision-one %s event after revision two loads',
    () => {
      expect(isCurrentOfficeRuntimeMessage(1, 2)).toBe(false);
      expect(isCurrentOfficeRuntimeMessage(2, 2)).toBe(true);
    }
  );
});

describe('source collaboration bridge', () => {
  it('requires epochs and request identities for replica updates and flush receipts', () => {
    const update = {
      bytes: new ArrayBuffer(2),
      epoch: 4,
      type: 'update',
      version: OFFICE_PROTOCOL_VERSION,
    };
    expect(isOfficeHostMessage(update)).toBe(true);
    expect(isOfficeHostMessage({ ...update, epoch: -1 })).toBe(false);
    expect(isOfficeRuntimeMessage({ ...update, revision: 2 })).toBe(true);
    expect(
      isOfficeRuntimeMessage({ ...update, revision: 2, type: 'flushed' })
    ).toBe(false);
    expect(
      isOfficeRuntimeMessage({
        ...update,
        id: 'checkpoint-1',
        revision: 2,
        type: 'flushed',
      })
    ).toBe(true);
    expect(
      isOfficeRuntimeMessage({
        type: 'initialized',
        version: OFFICE_PROTOCOL_VERSION,
      })
    ).toBe(true);
  });
});

it('accepts bounded citation changes without a document reload', () => {
  const message = {
    citation: { page: 2, quote: 'Source passage about wetlands' },
    type: 'set-citation',
    version: OFFICE_PROTOCOL_VERSION,
  };
  expect(isOfficeHostMessage(message)).toBe(true);
  expect(isOfficeHostMessage({ ...message, citation: null })).toBe(true);
  expect(
    isOfficeHostMessage({ ...message, citation: { quote: 'x'.repeat(4001) } })
  ).toBe(false);
  expect(
    isOfficeHostMessage({ ...message, citation: { page: -1, quote: 'text' } })
  ).toBe(false);
});

// After collaboration-ready the host sends only what the replica lacks: a room
// above the engines' 64 MiB per-update cap is never sent back as one update.
it('answers a ready replica with only what it lacks', () => {
  const host = new Y.Doc();
  host.getText('room').insert(0, 'x'.repeat(100_000));
  const replica = new Y.Doc();
  const replicaState = Y.encodeStateAsUpdate(host); // the load's initial update
  Y.applyUpdate(replica, replicaState);
  host.getText('room').insert(0, 'late');
  const catchUp = replicaCatchUp(host, replicaState);
  expect(catchUp.byteLength).toBeLessThan(100);
  Y.applyUpdate(replica, catchUp);
  expect(replica.getText('room').toString()).toBe(
    host.getText('room').toString()
  );
});
