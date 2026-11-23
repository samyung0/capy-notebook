import {
  type SurfaceBlockModel,
  type SurfaceMiddleware,
  surfaceMiddlewareExtension,
} from '@blocksuite/affine-block-surface';
import type { ConnectorElementModel } from '@blocksuite/affine-model';
import { noteSizeWrites } from '@blocksuite/affine-shared/utils';
import type { GfxModel } from '@blocksuite/std/gfx';

import { ConnectorPathGenerator } from './connector-manager';

export const connectorWatcher: SurfaceMiddleware = (
  surface: SurfaceBlockModel
) => {
  const hasElementById = (id: string) =>
    surface.hasElementById(id) || surface.store.hasBlock(id);
  const elementGetter = (id: string) =>
    surface.getElementById(id) ?? (surface.store.getModelById(id) as GfxModel);
  /* Capy (vendor/blocksuite/README.md, local change 63): a label's place is a
   * stored field. `own` says this tab's own change moved the connector, and
   * only then is the place written: on load, on a peer's change and in a
   * read-only store the path is drawn again and the label's place stays as
   * the document has it (the tab that made the change writes it; local change
   * 75 shows the label on the path drawn). */
  const updateConnectorPath = (
    connector: ConnectorElementModel,
    own: boolean
  ) => {
    if (
      ((connector.source?.id && hasElementById(connector.source.id)) ||
        (!connector.source?.id && connector.source?.position)) &&
      ((connector.target?.id && hasElementById(connector.target.id)) ||
        (!connector.target?.id && connector.target?.position))
    ) {
      ConnectorPathGenerator.updatePath(
        connector,
        null,
        elementGetter,
        own && !surface.store.readonly
      );
    }
  };
  const pendingList = new Map<ConnectorElementModel, boolean>();
  let pendingFlag = false;
  const addToUpdateList = (connector: ConnectorElementModel, own: boolean) => {
    pendingList.set(connector, own || pendingList.get(connector) === true);

    if (!pendingFlag) {
      pendingFlag = true;
      queueMicrotask(() => {
        pendingList.forEach((own, connector) =>
          updateConnectorPath(connector, own)
        );
        pendingList.clear();
        pendingFlag = false;
      });
    }
  };

  const disposables = [
    surface.elementAdded.subscribe(({ id, local }) => {
      const element = elementGetter(id);

      if (!element) return;

      if ('type' in element && element.type === 'connector') {
        addToUpdateList(element as ConnectorElementModel, local);
      } else {
        surface
          .getConnectors(id)
          .forEach(connector => addToUpdateList(connector, local));
      }
    }),
    surface.elementUpdated.subscribe(({ id, props, local }) => {
      const element = elementGetter(id);

      if (props['xywh'] || props['rotate']) {
        surface
          .getConnectors(id)
          .forEach(connector => addToUpdateList(connector, local));
      }

      if (
        'type' in element &&
        element.type === 'connector' &&
        (props['mode'] !== undefined || props['target'] || props['source'])
      ) {
        addToUpdateList(element as ConnectorElementModel, local);
      }
    }),
    surface.store.slots.blockUpdated.subscribe(payload => {
      if (
        payload.type === 'add' ||
        (payload.type === 'update' && payload.props.key === 'xywh')
      ) {
        // Capy (local change 75): a note's size only its typist's tab shows
        // moves no stored label.
        const own =
          payload.isLocal &&
          !noteSizeWrites.isLocal(surface.store, payload.id);
        surface
          .getConnectors(payload.id)
          .forEach(connector => addToUpdateList(connector, own));
      }
    }),
  ];
  // Capy (local change 75): a note's saved size places its labels now, inside
  // the save's transaction.
  const stopSaves = noteSizeWrites.onSaved((store, id) => {
    if (store !== surface.store) return;
    surface
      .getConnectors(id)
      .forEach(connector => updateConnectorPath(connector, true));
  });

  surface
    .getElementsByType('connector')
    .forEach(connector =>
      updateConnectorPath(connector as ConnectorElementModel, false)
    );

  return () => {
    pendingFlag = false;
    pendingList.clear();
    disposables.forEach(d => d.unsubscribe());
    stopSaves();
  };
};

export const connectorWatcherExtension = surfaceMiddlewareExtension(
  'connector-watcher',
  connectorWatcher
);
