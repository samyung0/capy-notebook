import {
  type SurfaceBlockModel,
  type SurfaceMiddleware,
  surfaceMiddlewareExtension,
} from '@blocksuite/affine-block-surface';
import {
  type ConnectorElementModel,
  MindmapElementModel,
} from '@blocksuite/affine-model';
import { noteSizeWrites } from '@blocksuite/affine-shared/utils';
import type { XYWH } from '@blocksuite/global/gfx';
import { activeInteractionOf, type GfxModel } from '@blocksuite/std/gfx';
import isEqual from 'lodash-es/isEqual';

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
  /* Capy (vendor/blocksuite/README.md, local change 83): the elements in this
   * tab's gesture (a drag, a resize, a turn) show places BlockSuite stashed
   * until it ends. The label of a connector hanging on one of them moves this
   * tab's alone (`held`), and is written once, inside the change that stores
   * the element's place at the end, so Undo takes them back together; one
   * whose ends were stored unchanged is released after the gesture at its
   * stored place, writing nothing. A mind map's root dragged lays its whole
   * map out at every frame. */
  const held = new Set<ConnectorElementModel>();
  let watching: (() => void) | null = null;
  // The gesture's elements as a set, made once a gesture (its array stays
  // the same until it ends): a frame looks each end up once.
  const sets = new WeakMap<readonly GfxModel[], Set<GfxModel>>();
  const setOf = (elements: readonly GfxModel[]) => {
    let set = sets.get(elements);
    if (!set) sets.set(elements, (set = new Set(elements)));
    return set;
  };
  const inGesture = (moving: Set<GfxModel>, id: string | undefined) => {
    const element = id ? elementGetter(id) : null;
    if (!element) return false;
    const map = element.group;
    return (
      moving.has(element) ||
      (map instanceof MindmapElementModel &&
        !!map.tree &&
        moving.has(map.tree.element))
    );
  };
  const endsMidGesture = (connector: ConnectorElementModel) => {
    const elements = activeInteractionOf(surface.store)?.peek()?.elements;
    if (!elements) return false;
    const moving = setOf(elements);
    return (
      inGesture(moving, connector.source?.id) ||
      inGesture(moving, connector.target?.id)
    );
  };
  const hold = (connector: ConnectorElementModel) => {
    held.add(connector);
    connector.stash('labelXYWH');
    const gesture = activeInteractionOf(surface.store);
    if (watching || !gesture) return;
    watching = gesture.subscribe(active => {
      if (active) return;
      watching?.();
      watching = null;
      // Its stored place stands (a peer's, or one this tab's path would put
      // elsewhere): the stash takes it back, and the pop writes nothing.
      queueMicrotask(() => {
        held.forEach(connector => {
          if (!surface.hasElementById(connector.id)) return;
          const stored = connector.yMap.get('labelXYWH') as XYWH | undefined;
          if (!isEqual(connector.labelXYWH, stored))
            connector.labelXYWH = stored;
          connector.pop('labelXYWH');
        });
        held.clear();
      });
    });
  };
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
      const place = own && !surface.store.readonly;
      // Capy (local change 83): held while an end is in this tab's gesture.
      const holding =
        place && connector.hasLabel() && endsMidGesture(connector);
      if (holding) hold(connector);
      ConnectorPathGenerator.updatePath(connector, null, elementGetter, place);
      if (place && !holding && held.delete(connector))
        connector.pop('labelXYWH');
    }
  };
  const pendingList = new Map<ConnectorElementModel, boolean>();
  let pendingFlag = false;
  const addToUpdateList = (connector: ConnectorElementModel, own: boolean) => {
    // Capy (local change 83): the gesture's end writes a held label at once.
    if (own && held.has(connector) && !endsMidGesture(connector)) {
      updateConnectorPath(connector, own);
      return;
    }
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
    watching?.();
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
