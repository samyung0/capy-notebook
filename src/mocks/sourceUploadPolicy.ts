import type { FileKind, SourceUploadPolicy } from '@/api/types';

const explicitExtensions: Record<string, string[]> = {
  audio: [
    'mp3',
    'wav',
    'm4a',
    'ogg',
    'flac',
    'aac',
    'webm',
    'mp4',
    'mpeg',
    'mpga',
    'opus',
  ],
  doc: ['docx', 'doc'],
  image: [
    'png',
    'jpg',
    'jpeg',
    'jp2',
    'webp',
    'gif',
    'bmp',
    'svg',
    'avif',
    'tif',
    'tiff',
    'heic',
    'heif',
    'ico',
  ],
  json: ['json', 'map'],
  md: ['md', 'markdown', 'mdx', 'mdc'],
  pdf: ['pdf'],
  sheet: ['xlsx', 'xls', 'csv', 'tsv'],
  slides: ['pptx', 'ppt'],
};

const textExtensions = `
  3dml appcache asm c cc coffee conf cpp css csv curl cxx dcurl def dic dsc etx
  f f77 f90 flx fly for ged gv h hbs hh htm html htc ics ifb in ini jad jade
  java js jsx less list litcoffee log lua man manifest markdown mcurl md mdx me
  mjs mkd mml ms n3 nfo opml org p pas pde roff rtf rtx s sass scss scurl sgm
  sgml shex shtml slim slm spdx spot styl stylus sub t text tr ts tsv tsx ttl
  txt uri uris urls uu vcard vcf vcs vtt wgsl wml wmls xml yaml yml c pl adb ads
  al asc asd ass automount bib c++ cbl cl cls cmake cob cr cs csvs d dart dcl
  device di diff dot dsl dtd dtx e eif el ent erl es ex exs f95 fasl feature fo
  gcode gcrd gedcom go gradle groovy gs gsh gvp gvy gy h++ hp hpp hs hxx ico idl
  ime imy ins iptables jsm ksy kt latex ldif lhs lisp ltx ly lyx m mak mc2 mk ml
  mli mm mo moc mof mount mrl mrml mup not ocl ooc owl patch path perl pl pm po
  pod pot py py3 py3x pyi pyx qml qmlproject qmltypes rdf rdfs reg rej rng ros
  rs rss rst rt sage sc scala scm scope service sfv sh slice slk socket spec sql
  ss ssa sty sv svh swap sylk t2t target tcl tex texi texinfo timer tk twig uil
  uue v vala vapi vbs vct vhd vhdl wsgi xbl xmi xsd xslfo ymp
`
  .trim()
  .split(/\s+/);

const extensionKinds = new Map<string, string>();
for (const [kind, extensions] of Object.entries(explicitExtensions)) {
  for (const extension of extensions) extensionKinds.set(extension, kind);
}
for (const extension of textExtensions) {
  if (!extensionKinds.has(extension)) extensionKinds.set(extension, 'txt');
}

const kindOrder: FileKind[] = [
  'pdf',
  'doc',
  'md',
  'image',
  'txt',
  'sheet',
  'slides',
  'audio',
  'json',
  'unknown',
];

function extensionsFor(kind: FileKind): string[] {
  return [...extensionKinds.entries()]
    .filter(([, mappedKind]) => mappedKind === kind)
    .map(([extension]) => `.${extension}`)
    .sort((a, b) => a.localeCompare(b));
}

/** Mirrors sourceupload.parseExtensions: the document parser's format list. */
const parseExtensions = ['.docx', '.pdf', '.pptx', '.xlsx'];

export const sourceUploadPolicy: SourceUploadPolicy = {
  accept: '',
  allowNoExtension: true,
  audioMaxDurationSeconds: 36_000,
  audioSecondCreditMicros: 250_000,
  digitalParsePageCreditMicros: 31_000_000,
  kinds: kindOrder.map((kind) => ({
    extensions: extensionsFor(kind),
    kind,
    text: kind === 'txt' || kind === 'md' || kind === 'json',
  })),
  maxBytes: 10 * 1024 * 1024,
  ocrParsePageCreditMicros: 52_000_000,
  parseModes: [
    {
      extensions: parseExtensions,
      maxBytes: 10 * 1024 * 1024,
      mode: 'fast',
      supportsFigures: true,
    },
    {
      extensions: [],
      maxBytes: 10 * 1024 * 1024,
      mode: 'none',
      supportsFigures: false,
    },
  ],
};
