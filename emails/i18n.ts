/**
 * Email copy comes from the same Paraglide catalog as the app UI. Messages are
 * always called with an explicit locale because there is no request context
 * here — the build script renders every locale, and the preview server picks
 * one per file.
 *
 * Run `pnpm email:compile` if the import below cannot be resolved; the
 * Paraglide output is generated, not committed.
 */
// @ts-expect-error generated at build time by the Paraglide compiler
export { m } from '../src/i18n/paraglide/messages.js';

export type EmailLocale = 'en' | 'zh';
