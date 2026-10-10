import { describe, expect, it } from 'vitest';
import { pageClasses, usedCss } from './usedCss';

const cut = (css: string, html: string) => usedCss(css)(pageClasses(html));

describe('usedCss', () => {
  it('keeps the rules whose classes the page uses, in order', () => {
    expect(
      cut(
        '.a{color:red}.b{color:blue}p{margin:0}.a .c{top:0}.a>.b{left:0}',
        '<p class="a">x</p><span class="c"></span>'
      )
    ).toBe('.a{color:red}p{margin:0}.a .c{top:0}');
  });

  it('keeps a selector list when any selector can match', () => {
    expect(cut('.x,.a{color:red}', '<i class="a"></i>')).toBe(
      '.x,.a{color:red}'
    );
  });

  it('reads escaped Tailwind classes and entity-encoded attributes', () => {
    const css =
      '.md\\:px-6{padding:0}.\\[\\&_img\\]\\:w-full img{width:100%}.\\32 xl\\:flex{display:flex}.gone\\:x{top:0}';
    expect(
      cut(css, '<div class="md:px-6 [&amp;_img]:w-full 2xl:flex"></div>')
    ).toBe(
      '.md\\:px-6{padding:0}.\\[\\&_img\\]\\:w-full img{width:100%}.\\32 xl\\:flex{display:flex}'
    );
  });

  it('requires no class inside :not, :has or a multi-argument :is', () => {
    const css =
      '.a:not(.b){top:0}.a:has(.z){left:0}:is(.dark *,.y) .a{right:0}';
    expect(cut(css, '<i class="a"></i>')).toBe(css);
  });

  it('requires the classes of a single-argument :is or :where', () => {
    expect(
      cut(
        ':where(.space-y-2>:not(:last-child)){margin:0}:is(.gone *)[x]{top:0}',
        '<i class="space-y-2"></i>'
      )
    ).toBe(':where(.space-y-2>:not(:last-child)){margin:0}');
  });

  it('keeps dark variants, which the theme script may turn on before paint', () => {
    expect(cut('.dark .a{color:white}', '<i class="a"></i>')).toBe(
      '.dark .a{color:white}'
    );
  });

  it('filters inside grouping rules and keeps nested rules with their parent', () => {
    expect(
      cut(
        '@layer theme,utilities;@layer utilities{.a{&:hover{@media (hover:hover){color:red}}}.b{color:blue}}@media (width>=40rem){.b{top:0}}@supports (x:y){.a{top:1px}}',
        '<i class="a"></i>'
      )
    ).toBe(
      '@layer theme,utilities;@layer utilities{.a{&:hover{@media (hover:hover){color:red}}}}@supports (x:y){.a{top:1px}}'
    );
  });

  it('keeps an emptied layer for the layer order, and every non-style rule', () => {
    const css =
      '@layer base{.b{top:0}}@property --x{syntax:"*";inherits:false}@font-face{font-family:F;src:url("a}b.woff2")}@keyframes k{to{opacity:0}}';
    expect(cut(css, '')).toBe(
      '@layer base{}@property --x{syntax:"*";inherits:false}@font-face{font-family:F;src:url("a}b.woff2")}@keyframes k{to{opacity:0}}'
    );
  });
});
