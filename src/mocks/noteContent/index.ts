import { bioNotes } from './bio';
import { calcNotes } from './calc';
import { chemNotes } from './chem';
import { engNotes } from './eng';
import { histNotes } from './hist';

/** Rich Plate note fixtures for each mock workspace. Imported by `db.ts`. */
export const seedNotes = [
  ...bioNotes,
  ...calcNotes,
  ...histNotes,
  ...chemNotes,
  ...engNotes,
];

export type { SeedNote } from './helpers';
