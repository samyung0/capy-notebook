import { effects as dataViewEffects } from '@blocksuite/data-view/effects';
import { DataViewBlockComponent } from './data-view-block';

export function effects() {
  // Capy (local change 26): data-view's elements, no longer defined by foundation.
  dataViewEffects();
  customElements.define('affine-data-view', DataViewBlockComponent);
}
