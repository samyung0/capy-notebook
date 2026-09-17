// Largest remainders keep the displayed disjoint shares at exactly 100%.
export function sourcePercentages(counts: readonly number[]): number[] {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (!total) return counts.map(() => 0);
  const exact = counts.map((count) => (count * 100) / total);
  const result = exact.map(Math.floor);
  const order = exact
    .map((value, index) => ({ fraction: value - result[index], index }))
    .sort((a, b) => b.fraction - a.fraction);
  const remainder = 100 - result.reduce((sum, value) => sum + value, 0);
  for (let i = 0; i < remainder; i++) result[order[i].index]++;
  return result;
}
