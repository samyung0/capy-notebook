import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { readCards, seedCards } from '@/features/flashcards/liveSet';
import type { Question } from '@/features/questions/types';
import { readQuestions, writeQuestion } from './liveQuiz';

/* The browser and server parity corpus (live-items REVIEW1 S5): what the
 * server seeds (collaboration-rs/crates/items/tests/parity/rust.json), the
 * browser reads as the same questions and cards; what the browser writes
 * (ts.json, written here with PARITY_WRITE=1), the server reads back
 * (items/tests/parity.rs). Ids and clients are fixed so the file is stable. */

let next = 0;
vi.mock('@/lib/id', () => ({ uid: (prefix = 'id') => `${prefix}_${next++}` }));

const dir = resolve(
  import.meta.dirname,
  '../../../collaboration-rs/crates/items/tests/parity'
);
const read = (name: string) =>
  readFileSync(resolve(dir, name), 'utf8').replaceAll('\r\n', '\n');

interface Corpus {
  cards: {
    back: string;
    front: string;
    id: string;
    image?: { assetId: string };
  }[];
  questions: { content: string; keys: string; question: Question }[];
  set: string;
}
const server = JSON.parse(read('rust.json')) as Corpus;

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const unhex = (text: string) =>
  Uint8Array.from(text.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
const load = (state: string) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, unhex(state));
  return doc;
};
const doc = (client: number) => {
  const created = new Y.Doc();
  created.clientID = client;
  return created;
};

it('reads what the server seeds as the same questions and cards', () => {
  for (const entry of server.questions)
    expect(readQuestions(load(entry.content), load(entry.keys))).toEqual([
      entry.question,
    ]);
  expect(readCards(load(server.set))).toEqual(server.cards);
});

it('keeps the browser corpus the server reads current', () => {
  next = 0;
  const questions = server.questions.map(({ question }) => {
    const content = doc(1);
    const keys = doc(2);
    writeQuestion(content, keys, question, 'parity');
    return {
      content: hex(Y.encodeStateAsUpdate(content)),
      keys: hex(Y.encodeStateAsUpdate(keys)),
      question,
    };
  });
  const set = doc(3);
  seedCards(set, server.cards);
  const written = `${JSON.stringify(
    { cards: server.cards, questions, set: hex(Y.encodeStateAsUpdate(set)) },
    null,
    2
  )}\n`;
  if (process.env.PARITY_WRITE) writeFileSync(resolve(dir, 'ts.json'), written);
  expect(
    read('ts.json') === written,
    'ts.json is stale: rerun with PARITY_WRITE=1'
  ).toBe(true);
});
