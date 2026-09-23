/**
 * `@openuidev/react-lang` auto-mounts its Inspect widget in development,
 * pulling a bundle from jsDelivr and overlaying a deploy prompt on the page.
 * The bootstrap skips itself when this flag is already set, so this module
 * must be imported before anything that imports the library. Production
 * builds fold the bootstrap out entirely.
 */
(globalThis as Record<symbol, unknown>)[
  Symbol.for('openui.devtools.autoMount')
] = true;
