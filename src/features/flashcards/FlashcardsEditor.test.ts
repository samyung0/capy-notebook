import { expect, it } from 'vitest';
import { cardsForSave } from './FlashcardsEditor';

it('saves written cards in order, keeping ids and images and dropping blanks', () => {
  expect(
    cardsForSave([
      { back: '', front: ' ', id: 'c_blank', key: 'c_blank' },
      {
        back: 'ATP',
        front: 'Mitochondria',
        id: 'c_1',
        image: { assetId: 'asset_1' },
        key: 'c_1',
      },
      { back: 'Turgor', front: 'Vacuole', key: 'card_new' },
    ])
  ).toEqual([
    {
      back: 'ATP',
      front: 'Mitochondria',
      id: 'c_1',
      image: { assetId: 'asset_1' },
    },
    { back: 'Turgor', front: 'Vacuole' },
  ]);
});
