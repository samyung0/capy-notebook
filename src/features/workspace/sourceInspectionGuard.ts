export interface SourceInspectionGuard {
  begin: () => () => boolean;
  invalidate: () => void;
}

export function createSourceInspectionGuard(): SourceInspectionGuard {
  let generation = 0;
  return {
    begin: () => {
      generation += 1;
      const startedAt = generation;
      return () => generation === startedAt;
    },
    invalidate: () => {
      generation += 1;
    },
  };
}
