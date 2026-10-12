/* The note text font, a per-browser pick in Plate settings: Fustat with roomy
   block gaps or the system font with the Plate playground's compact ones.
   Without a pick the style decides (classroom → Fustat, notion → system).
   The pick lives in its own localStorage key so the head scripts in
   index.html and share.html can put it on <html data-note-font> before first
   paint; tailwind.css reads that attribute. */

export type NoteFont = 'fustat' | 'system';

const NOTE_FONT_KEY = 'capy.noteFont';

/** What notes show now: the stored pick, else the style's own font. */
export function currentNoteFont(style: string | undefined): NoteFont {
  const picked = document.documentElement.dataset.noteFont;
  if (picked === 'fustat' || picked === 'system') return picked;
  return style === 'notion' ? 'system' : 'fustat';
}

export function setNoteFont(font: NoteFont) {
  document.documentElement.dataset.noteFont = font;
  try {
    localStorage.setItem(NOTE_FONT_KEY, font);
  } catch {
    // Private windows may refuse storage; the pick still holds for the page.
  }
}
