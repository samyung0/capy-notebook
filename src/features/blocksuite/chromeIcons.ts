import { unsafeSVG } from 'lit/directives/unsafe-svg.js';

/** A Hugeicons icon's shapes as SVG markup, in the app's 1.8 stroke. */
export function iconBody(icon: unknown) {
  const data = icon as readonly (readonly [string, Record<string, string>])[];
  return data
    .map(
      ([tag, attributes]) =>
        `<${tag} ${Object.entries(attributes)
          .filter(([name]) => name !== 'key')
          .map(
            ([name, value]) =>
              `${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${
                name === 'strokeWidth' ? '1.8' : value
              }"`
          )
          .join(' ')}/>`
    )
    .join('');
}

/** A Hugeicons icon as an SVG, for BlockSuite's Lit templates: 1em square, so the
 * bar's or menu's icon size applies. */
export function hugeIcon(icon: unknown) {
  return unsafeSVG(
    `<svg fill="none" height="1em" viewBox="0 0 24 24" width="1em">${iconBody(icon)}</svg>`
  );
}
