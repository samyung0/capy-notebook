// Neither package ships types; these cover the calls coverArt.ts makes.
declare module 'geopattern' {
  type Pattern = { toDataUrl(): string };
  const geopattern: {
    generate(
      seed: string,
      options: { color: string; generator: string }
    ): Pattern;
  };
  export default geopattern;
}

declare module 'hero-patterns' {
  /** Returns a CSS `url("data:…")` value. */
  type HeroPattern = (color: string, opacity: number) => string;
  export const bankNote: HeroPattern;
  export const bubbles: HeroPattern;
  export const current: HeroPattern;
  export const diagonalLines: HeroPattern;
  export const endlessClouds: HeroPattern;
  export const formalInvitation: HeroPattern;
  export const fourPointStars: HeroPattern;
  export const graphPaper: HeroPattern;
  export const hexagons: HeroPattern;
  export const jigsaw: HeroPattern;
  export const overlappingCircles: HeroPattern;
  export const plus: HeroPattern;
  export const polkaDots: HeroPattern;
  export const signal: HeroPattern;
  export const texture: HeroPattern;
  export const wiggle: HeroPattern;
  export const xEquals: HeroPattern;
  export const zigZag: HeroPattern;
}
