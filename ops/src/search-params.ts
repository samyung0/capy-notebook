import { z } from 'zod';
import { costGroupSchema } from './api';

const userSearchSchema = z.object({
  q: z.string().catch(''),
});

function defaultDate(daysAgo: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

const costSearchSchema = z.object({
  from: z.iso.date().catch(defaultDate(30)),
  groupBy: costGroupSchema.catch('day'),
  to: z.iso.date().catch(defaultDate(0)),
});

export function parseUserSearch(input: unknown) {
  return userSearchSchema.parse(input);
}

export function parseCostSearch(input: unknown) {
  const parsed = costSearchSchema.parse(input);
  if (parsed.from > parsed.to) {
    return {
      ...parsed,
      from: parsed.to,
      to: parsed.from,
    };
  }
  return parsed;
}
