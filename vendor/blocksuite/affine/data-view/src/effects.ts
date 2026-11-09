import { coreEffects } from './core/effect.js';
import { propertyPresetsEffects } from './property-presets/effect.js';
import { viewPresetsEffects } from './view-presets/effect.js';
import { widgetPresetsEffects } from './widget-presets/effect.js';

// Capy (local change 26): called by the database and data-view blocks instead of
// foundation, so a board without them loads none of data-view. Either may come first.
let defined = false;

export function effects() {
  if (defined) return;
  defined = true;
  coreEffects();
  propertyPresetsEffects();
  viewPresetsEffects();
  widgetPresetsEffects();
}
