// Writes the server seed of every fixture into recordings/_seeds (once).
//   tsx seeds.ts
import { FIXTURES, seedOf } from './session';

for (const fixture of Object.values(FIXTURES)) {
  const started = Date.now();
  const seed = seedOf(fixture);
  console.log(`${fixture.key} ${seed.seed.length} B seed ${seed.seedSha.slice(0, 16)} (${Date.now() - started} ms)`);
}
