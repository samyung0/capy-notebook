import { describe, expect, it } from 'vitest';
import { youtubeVideoId } from './youtube';

describe('YouTube URLs', () => {
  it('accepts watch, short, and embed URLs', () => {
    expect(youtubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ'
    );
    expect(youtubeVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ'
    );
  });

  it('rejects non-YouTube URLs and malformed IDs', () => {
    expect(
      youtubeVideoId('https://example.com/watch?v=dQw4w9WgXcQ')
    ).toBeNull();
    expect(youtubeVideoId('https://youtu.be/short')).toBeNull();
  });
});
