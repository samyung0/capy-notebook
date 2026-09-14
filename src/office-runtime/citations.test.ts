import type {
  DisplayList,
  TextRunPrimitive,
} from '@betteroffice/docx/layout/render';
import type { SlideDisplayList } from '@betteroffice/pptx/viewer';
import { describe, expect, it } from 'vitest';
import {
  docxCitation,
  insidePage,
  slideCitationItems,
  uniqueCitation,
} from './citations';

// Match current source text, never an old PDF coordinate or a reused engine ID.
describe('native citation matching', () => {
  it('matches wrapped Unicode text and follows its current location', () => {
    const quote = 'Photosynthesis converts sunlight';
    const moved = {
      location: 9,
      text: 'Photosyn\n thesis converts sun\u00adlight',
    };
    expect(uniqueCitation([moved], quote)).toBe(moved);
    expect(
      uniqueCitation([{ ...moved, text: 'Replaced source text' }], quote)
    ).toBeNull();
  });
  it('abstains for duplicate, repeated and short evidence', () => {
    const item = { text: 'A repeated paragraph about wetlands' };
    expect(uniqueCitation([item, item], item.text)).toBeNull();
    expect(
      uniqueCitation([{ text: `${item.text} ${item.text}` }], item.text)
    ).toBeNull();
    expect(uniqueCitation([{ text: '2026' }], '2026')).toBeNull();
  });
  it('rejects geometry outside the current page', () => {
    expect(insidePage({ h: 24, w: 200, x: 20, y: 30 }, 800, 1000)).toBe(true);
    expect(insidePage({ h: 24, w: 900, x: 20, y: 30 }, 800, 1000)).toBe(false);
    expect(insidePage({ h: 24, w: 200, x: Number.NaN, y: 30 }, 800, 1000)).toBe(
      false
    );
  });
  it('does not highlight visible siblings of hidden, clipped or off-page DOCX evidence', () => {
    const quote = 'The quoted passage has unsafe geometry';
    const run: TextRunPrimitive = {
      baselineY: 80,
      blockKey: 'paragraph-one',
      color: '#000',
      font: '16px Arial',
      kind: 'text',
      text: quote,
      width: 300,
      x: 20,
    };
    const list = (override: Partial<TextRunPrimitive>): DisplayList => ({
      pages: [
        {
          height: 1000,
          pageIndex: 0,
          primitives: [
            { ...run, baselineY: 40, text: 'Unrelated visible introduction. ' },
            { ...run, ...override },
          ],
          width: 800,
        },
      ],
    });
    expect(docxCitation(list({}), { quote })?.rects).toHaveLength(2);
    expect(
      docxCitation(list({ paintClip: { w: 300, x: 20 } }), { quote })?.rects
    ).toHaveLength(2);
    for (const override of [
      { baselineY: 1040 },
      { hidden: true },
      { paintClip: { w: 0, x: 0 } },
      { paintClip: { w: 299, x: 20 } },
      { clipGroup: { clip: { h: 0, w: 0, x: 0, y: 0 } } },
      { clipGroup: { opacity: 0 } },
    ])
      expect(docxCitation(list(override), { quote })).toBeNull();
  });
  it('abstains when part of a matched slide text box is off-slide or overflows', () => {
    const quote = 'The quoted passage has unsafe geometry';
    const line = {
      baseline: 55,
      caretStops: [],
      end: 20,
      height: 20,
      runs: [],
      start: 0,
      width: 200,
      x: 20,
      y: 40,
    };
    const frame: SlideDisplayList = {
      contractVersion: 1,
      height: 600,
      primitives: [
        {
          anchor: 'top',
          h: 550,
          kind: 'textBox',
          lines: [line, { ...line, y: 80 }],
          objectId: 1,
          paragraphs: [
            {
              level: 0,
              runs: [
                {
                  color: '#000',
                  fontFamily: 'Arial',
                  fontSizePt: 12,
                  text: `Unrelated visible introduction. ${quote}`,
                },
              ],
            },
          ],
          w: 300,
          x: 20,
          y: 40,
        },
      ],
      width: 800,
    };
    expect(
      uniqueCitation(slideCitationItems(frame), quote)?.rects
    ).toHaveLength(2);
    const box = frame.primitives[0];
    if (box.kind !== 'textBox') throw new Error('expected text box');
    box.lines[1].y = 610;
    expect(uniqueCitation(slideCitationItems(frame), quote)?.rects).toEqual([]);
    box.lines[1].y = 80;
    box.lines[1].x = 400;
    expect(uniqueCitation(slideCitationItems(frame), quote)?.rects).toEqual([]);
    box.lines[1].x = 20;
    box.overflow = true;
    expect(uniqueCitation(slideCitationItems(frame), quote)?.rects).toEqual([]);
  });
});
