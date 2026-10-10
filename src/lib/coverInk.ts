import type { CoverConfig } from '@/api/types';

/** A paper cover's print colour, and the line of its genkō (squared) paper. */
export const PAPER_INK = '#2f4f86';
export const GENKO_LINE = '#b98a6a';

/**
 * The colour a workspace's cover lends to its progress trail: the cover's
 * colour, or for a paper cover (light paper) its ink. None without a cover.
 */
export const coverInk = (cover?: CoverConfig) =>
  cover
    ? cover.style === 'paper'
      ? cover.kind === 'kana'
        ? GENKO_LINE
        : PAPER_INK
      : cover.color
    : undefined;
