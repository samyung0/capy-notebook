/** Thrown with localized copy as its message, which errorCopy shows. Kept
 * apart from errors.ts, which reaches the browser API client, so code the
 * site worker renders (question validation) can throw it. */
export class CopyError extends Error {}
