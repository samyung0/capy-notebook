import { readFileSync } from 'node:fs';
import { preloadEditWasm } from '@betteroffice/docx/wasm/edit';
import { preloadOpcWasm } from '@betteroffice/docx/wasm/opc';
import { preloadParseWasm } from '@betteroffice/docx/wasm/parse';
import { initWasm as initPptx } from '@betteroffice/pptx/editor';
import { initWasm as initXlsx } from '@betteroffice/xlsx/editor';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { fakeImage, stubImageCodec } from './imageCodec.testing';
import {
  compressOfficeImages,
  contentTypes,
  removePictures,
  resolveTarget,
  rewriteRelationships,
} from './officeImages';

// The fork's headless engines: a file they seed opens in Capy's editors.
const { seedOffice } = (await import(
  /* @vite-ignore */ new URL(
    '../../vendor/betteroffice/shared/office-checkpoint.mjs',
    import.meta.url
  ).href
)) as {
  seedOffice(format: string, base: Uint8Array): Promise<{ state: Uint8Array }>;
};
const fork = (path: string) =>
  new Uint8Array(
    readFileSync(new URL(`../../vendor/betteroffice/${path}`, import.meta.url))
  );
beforeAll(() =>
  Promise.all([
    initXlsx(fork('packages/xlsx/src/wasm/generated/xlsx_wasm_bg.wasm')),
    preloadEditWasm(fork('shared/office-runtime/docx.wasm')),
    preloadParseWasm(fork('shared/office-runtime/parse.wasm')),
    preloadOpcWasm(fork('shared/office-runtime/opc.wasm')),
    initPptx(fork('shared/office-runtime/pptx.wasm')),
  ])
);

const MB = 1024 * 1024;
const EMBED = /r:embed="\w+"/;
const BLIP = /<a:blip r:embed="\w+"/;
const REMOVED_MARKUP = /svgBlip|imgLayer|extLst|rIdBroken|rIdPict/;
const fixture = (name: string) =>
  unzipSync(
    new Uint8Array(
      readFileSync(
        new URL(
          `../../e2e/fixtures/files/rich-content/${name}`,
          import.meta.url
        )
      )
    )
  );
/** A minimal EMF: the record type 1 header with " EMF" at byte 40. */
const EMF = (() => {
  const bytes = new Uint8Array(108);
  bytes.set([1, 0, 0, 0]);
  bytes.set([0x20, 0x45, 0x4d, 0x46], 40);
  return bytes;
})();
/** A placeable WMF header. */
const WMF = new Uint8Array([0xd7, 0xcd, 0xc6, 0x9a, ...new Array(40).fill(0)]);
const photoPng = () => fakeImage('image/png', 3000, 2000, 'photo', 3 * MB);
const photoJpeg = () => fakeImage('image/jpeg', 4000, 3000, 'photo', MB);
const alphaPng = () => fakeImage('image/png', 3000, 3000, 'alpha', 2 * MB);
const smallPng = () => fakeImage('image/png', 300, 200, 'flat', 2000);

const addRels = (xml: string, rels: string) =>
  xml.replace('</Relationships>', `${rels}</Relationships>`);
const rel = (id: string, type: string, target: string) =>
  `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;

/** exchange-plan.docx with its pictures swapped for a large PNG photo, a
 * large transparent PNG and a small flat PNG, a large JPEG added, and a WMF
 * equation preview with its OLE object. */
function docx() {
  const parts = fixture('exchange-plan.docx');
  parts['word/media/image1.png'] = photoPng();
  parts['word/media/image2.png'] = alphaPng();
  parts['word/media/image3.png'] = smallPng();
  parts['word/media/photo.jpg'] = photoJpeg();
  parts['word/media/image9.wmf'] = WMF;
  parts['word/embeddings/oleObject1.bin'] = new Uint8Array([1, 2, 3]);
  const document = strFromU8(parts['word/document.xml']);
  const drawing = document.slice(
    document.indexOf('<w:drawing>'),
    document.indexOf('</w:drawing>') + '</w:drawing>'.length
  );
  const added =
    `<w:p><w:r>${drawing.replace(EMBED, 'r:embed="rId100"')}</w:r></w:p>` +
    '<w:p><w:r><w:object><v:shape id="_x0000_i1025" style="width:50pt;height:20pt"><v:imagedata r:id="rId101" o:title=""/></v:shape>' +
    '<o:OLEObject Type="Embed" ProgID="Equation.3" ShapeID="_x0000_i1025" DrawAspect="Content" ObjectID="_1" r:id="rId102"/></w:object></w:r></w:p>';
  parts['word/document.xml'] = strToU8(
    document.replace('<w:sectPr', `${added}<w:sectPr`)
  );
  parts['word/_rels/document.xml.rels'] = strToU8(
    addRels(
      strFromU8(parts['word/_rels/document.xml.rels']),
      rel('rId100', 'image', 'media/photo.jpg') +
        rel('rId101', 'image', 'media/image9.wmf') +
        rel('rId102', 'oleObject', 'embeddings/oleObject1.bin')
    )
  );
  parts['[Content_Types].xml'] = strToU8(
    strFromU8(parts['[Content_Types].xml']).replace(
      '</Types>',
      '<Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="wmf" ContentType="image/x-wmf"/><Override PartName="/word/embeddings/oleObject1.bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/></Types>'
    )
  );
  return parts;
}

/** lecture.pptx with image1.png (slides 2 and 4) a large PNG photo,
 * image4.jpg a large JPEG, image2.png transparent, every other picture small
 * (the stub decoder reads only fakes), and an EMF picture added to slide 1. */
function pptx() {
  const parts = fixture('lecture.pptx');
  for (const path of Object.keys(parts))
    if (path.startsWith('ppt/media/')) parts[path] = smallPng();
  parts['ppt/media/image1.png'] = photoPng();
  parts['ppt/media/image4.jpg'] = photoJpeg();
  parts['ppt/media/image2.png'] = alphaPng();
  parts['ppt/media/image3.png'] = smallPng();
  parts['ppt/media/image99.emf'] = EMF;
  const pic =
    '<p:pic><p:nvPicPr><p:cNvPr id="900" name="Visio drawing"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="rId100"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
    '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
  parts['ppt/slides/slide1.xml'] = strToU8(
    strFromU8(parts['ppt/slides/slide1.xml']).replace(
      '</p:spTree>',
      `${pic}</p:spTree>`
    )
  );
  parts['ppt/slides/_rels/slide1.xml.rels'] = strToU8(
    addRels(
      strFromU8(parts['ppt/slides/_rels/slide1.xml.rels']),
      rel('rId100', 'image', '../media/image99.emf')
    )
  );
  parts['[Content_Types].xml'] = strToU8(
    strFromU8(parts['[Content_Types].xml']).replace(
      '</Types>',
      '<Default Extension="emf" ContentType="image/x-emf"/></Types>'
    )
  );
  return parts;
}

/** course-guide.xlsx with a large PNG photo and an EMF placed on sheet 1. */
function xlsx() {
  const parts = fixture('course-guide.xlsx');
  parts['xl/media/image1.png'] = photoPng();
  parts['xl/media/image2.emf'] = EMF;
  const anchor = (id: string, row: number) =>
    `<xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="914400" cy="914400"/>` +
    `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${row + 2}" name="Picture ${row}"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
    '<xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>';
  parts['xl/drawings/drawing1.xml'] = strToU8(
    strFromU8(parts['xl/drawings/drawing1.xml']).replace(
      '/>',
      `>${anchor('rId1', 0)}${anchor('rId2', 10)}</xdr:wsDr>`
    )
  );
  parts['xl/drawings/_rels/drawing1.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rId1', 'image', '../media/image1.png')}${rel('rId2', 'image', '../media/image2.emf')}</Relationships>`
  );
  parts['[Content_Types].xml'] = strToU8(
    strFromU8(parts['[Content_Types].xml']).replace(
      '</Types>',
      '<Default Extension="png" ContentType="image/png"/><Default Extension="emf" ContentType="image/x-emf"/></Types>'
    )
  );
  return parts;
}

/** exchange-plan.docx with its pictures small, so nothing compresses. */
function smallDocx() {
  const parts = fixture('exchange-plan.docx');
  for (const name of ['image1', 'image2', 'image3'])
    parts[`word/media/${name}.png`] = smallPng();
  return parts;
}
const add = (
  parts: Record<string, Uint8Array>,
  path: string,
  before: string,
  text: string
) => {
  parts[path] = strToU8(
    strFromU8(parts[path]).replace(before, `${text}${before}`)
  );
};

const pack = (parts: Record<string, Uint8Array>, name: string) =>
  new File([zipSync(parts)], name);
/** The parts a seed of the file references by name. */
async function seeded(format: string, bytes: Uint8Array) {
  const state = (await seedOffice(format, bytes)).state;
  return new TextDecoder().decode(state);
}

let codec: ReturnType<typeof stubImageCodec>;
beforeEach(() => {
  codec = stubImageCodec();
  // Each re-encode of a large image lands well under the cap; a small one
  // grows.
  codec.encoded = (_type, width) => (width > 300 ? 400_000 : 5000);
});
afterEach(() => vi.unstubAllGlobals());

describe('compressOfficeImages', () => {
  it('compresses a DOCX, renames a photo saved as PNG, and removes a WMF equation preview with its OLE object', async () => {
    const source = docx();
    const progress: number[] = [];
    const { file, removed } = await compressOfficeImages(
      pack(source, 'plan.docx'),
      2 * MB,
      (done) => progress.push(done)
    );
    expect(removed).toBe(1);
    expect(progress).toEqual([1, 2, 3, 4]);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const out = unzipSync(bytes);
    // The photo saved as PNG is now JPEG under a .jpeg name, and every
    // reference follows it.
    expect('word/media/image1.png' in out).toBe(false);
    expect(out['word/media/image1.jpeg'].subarray(0, 3)).toEqual(
      new Uint8Array([0xff, 0xd8, 0xff])
    );
    const rels = strFromU8(out['word/_rels/document.xml.rels']);
    expect(rels).toContain('Target="media/image1.jpeg"');
    expect(rels).not.toContain('image9.wmf');
    expect(rels).not.toContain('oleObject1.bin');
    const types = strFromU8(out['[Content_Types].xml']);
    expect(types).toContain(
      '<Default Extension="jpeg" ContentType="image/jpeg"/>'
    );
    expect(types).not.toContain('oleObject1.bin');
    // The large JPEG and the transparent PNG keep their names, smaller; the
    // small PNG, whose re-encode is larger, is byte-identical.
    expect(out['word/media/photo.jpg'].length).toBe(400_000);
    expect(out['word/media/image2.png'].length).toBe(400_000);
    expect(out['word/media/image3.png']).toEqual(
      source['word/media/image3.png']
    );
    expect('word/media/image9.wmf' in out).toBe(false);
    expect('word/embeddings/oleObject1.bin' in out).toBe(false);
    expect(strFromU8(out['word/document.xml'])).not.toContain('w:object');
    expect(codec.encodes).toContain('image/jpeg 2400x1600 0.85');
    expect(codec.encodes).toContain('image/png 2400x2400 0.85');
    // It still opens, with every picture.
    const seed = await seeded('docx', bytes);
    for (const part of ['image1.jpeg', 'image2.png', 'image3.png', 'photo.jpg'])
      expect(seed).toContain(`word/media/${part}`);
  }, 60_000);

  it('compresses a PPTX and removes an EMF picture', async () => {
    const { file, removed } = await compressOfficeImages(
      pack(pptx(), 'deck.pptx'),
      2 * MB
    );
    expect(removed).toBe(1);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const out = unzipSync(bytes);
    expect('ppt/media/image99.emf' in out).toBe(false);
    expect(strFromU8(out['ppt/slides/slide1.xml'])).not.toContain(
      'Visio drawing'
    );
    expect(strFromU8(out['ppt/slides/_rels/slide1.xml.rels'])).not.toContain(
      'emf'
    );
    // Both slides showing the photo point at its new name.
    for (const slide of ['slide2', 'slide4'])
      expect(strFromU8(out[`ppt/slides/_rels/${slide}.xml.rels`])).toContain(
        '../media/image1.jpeg'
      );
    expect(out['ppt/media/image4.jpg'].length).toBe(400_000);
    const seed = await seeded('pptx', bytes);
    for (const part of [
      'image1.jpeg',
      'image2.png',
      'image3.png',
      'image4.jpg',
    ])
      expect(seed).toContain(`ppt/media/${part}`);
  }, 60_000);

  it('compresses an XLSX and removes an EMF drawing anchor', async () => {
    const { file, removed } = await compressOfficeImages(
      pack(xlsx(), 'grades.xlsx'),
      2 * MB
    );
    expect(removed).toBe(1);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const out = unzipSync(bytes);
    const drawing = strFromU8(out['xl/drawings/drawing1.xml']);
    expect(drawing.match(/<xdr:oneCellAnchor>/g)).toHaveLength(1);
    expect(drawing).toContain('r:embed="rId1"');
    expect(strFromU8(out['xl/drawings/_rels/drawing1.xml.rels'])).toBe(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rId1', 'image', '../media/image1.jpeg')}</Relationships>`
    );
    expect('xl/media/image2.emf' in out).toBe(false);
    await expect(seedOffice('xlsx', bytes)).resolves.toBeTruthy();
  }, 60_000);

  it('returns the picked file itself when nothing changes', async () => {
    const picked = pack(smallDocx(), 'plan.docx');
    expect(await compressOfficeImages(picked, 2 * MB)).toEqual({
      file: picked,
      removed: 0,
    });
  });

  it('removes an EMF thumbnail, an EMF nothing refers to and an EMF chart fill, counting only the fill', async () => {
    // Security regression (Q348, review B2, S7): the checks refuse these.
    const parts = smallDocx();
    parts['docProps/thumbnail.emf'] = EMF;
    parts['word/media/stray.emf'] = EMF;
    parts['word/media/fill.emf'] = EMF;
    add(
      parts,
      '_rels/.rels',
      '</Relationships>',
      '<Relationship Id="rIdThumb" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.emf"/>'
    );
    add(
      parts,
      '[Content_Types].xml',
      '</Types>',
      '<Override PartName="/docProps/thumbnail.emf" ContentType="image/x-emf"/>'
    );
    add(
      parts,
      'word/charts/chart1.xml',
      '</c:chartSpace>',
      '<c:spPr><a:blipFill><a:blip r:embed="rIdFill"/></a:blipFill></c:spPr>'
    );
    add(
      parts,
      'word/charts/_rels/chart1.xml.rels',
      '</Relationships>',
      rel('rIdFill', 'image', '../media/fill.emf')
    );
    const { file, removed } = await compressOfficeImages(
      pack(parts, 'plan.docx'),
      2 * MB
    );
    expect(removed).toBe(1);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const out = unzipSync(bytes);
    for (const gone of [
      'docProps/thumbnail.emf',
      'word/media/stray.emf',
      'word/media/fill.emf',
    ])
      expect(gone in out).toBe(false);
    expect(strFromU8(out['_rels/.rels'])).not.toContain('thumbnail');
    expect(strFromU8(out['[Content_Types].xml'])).not.toContain(
      'thumbnail.emf'
    );
    const chart = strFromU8(out['word/charts/chart1.xml']);
    expect(chart).not.toContain('blipFill');
    expect(chart).toContain('<c:spPr></c:spPr>');
    await expect(seedOffice('docx', bytes)).resolves.toBeTruthy();
  }, 60_000);

  it('removes an SVG or HD Photo beside a picture uncounted, keeping the picture, and an undecodable or unknown picture counted', async () => {
    // Security regression (Q337, Q344): servers keep only PNG, JPEG and GIF.
    const parts = smallDocx();
    parts['word/media/logo.svg'] = strToU8(
      '<svg xmlns="http://www.w3.org/2000/svg"/>'
    );
    parts['word/media/hdphoto1.wdp'] = new Uint8Array([
      0x49,
      0x49,
      0xbc,
      0x01,
      ...new Array(40).fill(0),
    ]);
    // A PNG signature the decoder cannot read.
    parts['word/media/broken.png'] = smallPng().subarray(0, 12);
    const pict = new Uint8Array(514);
    pict.set([0x11, 0x01], 512);
    parts['word/media/scan.pct'] = pict;
    parts['word/media/clip.mp4'] = new Uint8Array([
      0,
      0,
      0,
      0x18,
      ...strToU8('ftypmp42'),
    ]);
    const document = strFromU8(parts['word/document.xml']);
    const drawing = document.slice(
      document.indexOf('<w:drawing>'),
      document.indexOf('</w:drawing>') + '</w:drawing>'.length
    );
    const blip = BLIP.exec(drawing)![0];
    const shown = document.split(blip).length;
    const withExtensions = drawing
      .replace(
        blip,
        `${blip}><a:extLst><a:ext uri="{BEBA8EAE-BF5A-486C-A8C5-ECC9F3942E4B}"><a14:imgProps><a14:imgLayer r:embed="rIdHd"/></a14:imgProps></a:ext>` +
          '<a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip r:embed="rIdSvg"/></a:ext></a:extLst></a:blip'
      )
      .replace('</a:blip/>', '</a:blip>');
    const showing = (id: string) =>
      `<w:p><w:r>${drawing.replace(EMBED, `r:embed="${id}"`)}</w:r></w:p>`;
    add(
      parts,
      'word/document.xml',
      '<w:sectPr',
      `<w:p><w:r>${withExtensions}</w:r></w:p>${showing('rIdBroken')}${showing('rIdPict')}`
    );
    add(
      parts,
      'word/_rels/document.xml.rels',
      '</Relationships>',
      rel('rIdSvg', 'image', 'media/logo.svg') +
        '<Relationship Id="rIdHd" Type="http://schemas.microsoft.com/office/2007/relationships/hdphoto" Target="media/hdphoto1.wdp"/>' +
        rel('rIdBroken', 'image', 'media/broken.png') +
        rel('rIdPict', 'image', 'media/scan.pct') +
        rel('rIdClip', 'video', 'media/clip.mp4')
    );
    const { file, removed } = await compressOfficeImages(
      pack(parts, 'plan.docx'),
      2 * MB
    );
    expect(removed).toBe(2);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const out = unzipSync(bytes);
    for (const gone of ['logo.svg', 'hdphoto1.wdp', 'broken.png', 'scan.pct'])
      expect(`word/media/${gone}` in out).toBe(false);
    expect('word/media/clip.mp4' in out).toBe(true);
    const result = strFromU8(out['word/document.xml']);
    expect(result).not.toMatch(REMOVED_MARKUP);
    // The picture's own blip stays in each drawing that showed it.
    expect(result.split(blip).length).toBe(shown + 1);
    await expect(seedOffice('docx', bytes)).resolves.toBeTruthy();
  }, 60_000);
});

describe('compressOfficeImages after a removal', () => {
  /** Swaps a package's added EMF for a PNG that does not decode. */
  function broken(parts: Record<string, Uint8Array>, emf: string) {
    delete parts[emf];
    const name = emf.slice(emf.lastIndexOf('/') + 1);
    parts[emf.replace(name, 'broken.png')] = smallPng().subarray(0, 12);
    for (const path of Object.keys(parts))
      if (path.endsWith('.rels'))
        parts[path] = strToU8(
          strFromU8(parts[path]).replace(name, 'broken.png')
        );
    return parts;
  }

  it('opens a PPTX whose undecodable picture and stray SVG went, and an XLSX whose undecodable picture went', async () => {
    // Review r2 N9, N12; the unreferenced SVG goes uncounted (review r3 N3).
    const deck = broken(pptx(), 'ppt/media/image99.emf');
    deck['ppt/embeddings/icon.svg'] = strToU8(
      '<svg xmlns="http://www.w3.org/2000/svg"/>'
    );
    const slides = await compressOfficeImages(pack(deck, 'deck.pptx'), 2 * MB);
    expect(slides.removed).toBe(1);
    const slidesBytes = new Uint8Array(await slides.file.arrayBuffer());
    const slidesOut = unzipSync(slidesBytes);
    expect('ppt/media/broken.png' in slidesOut).toBe(false);
    expect('ppt/embeddings/icon.svg' in slidesOut).toBe(false);
    expect(strFromU8(slidesOut['ppt/slides/slide1.xml'])).not.toContain(
      'Visio drawing'
    );
    await expect(seedOffice('pptx', slidesBytes)).resolves.toBeTruthy();

    const book = broken(xlsx(), 'xl/media/image2.emf');
    const sheets = await compressOfficeImages(
      pack(book, 'grades.xlsx'),
      2 * MB
    );
    expect(sheets.removed).toBe(1);
    const sheetsBytes = new Uint8Array(await sheets.file.arrayBuffer());
    const sheetsOut = unzipSync(sheetsBytes);
    expect('xl/media/broken.png' in sheetsOut).toBe(false);
    expect(
      strFromU8(sheetsOut['xl/drawings/drawing1.xml']).match(
        /<xdr:oneCellAnchor>/g
      )
    ).toHaveLength(1);
    await expect(seedOffice('xlsx', sheetsBytes)).resolves.toBeTruthy();
  }, 60_000);
});

describe('removePictures', () => {
  it('removes a PPTX OLE frame whole, with the alternate content around it, and counts it once', () => {
    const xml =
      '<p:spTree><mc:AlternateContent><mc:Choice Requires="v"><p:graphicFrame><a:graphic><a:graphicData><p:oleObj r:id="rId2"><p:embed/></p:oleObj></a:graphicData></a:graphic></p:graphicFrame></mc:Choice>' +
      '<mc:Fallback><p:graphicFrame><a:graphic><a:graphicData><p:oleObj r:id="rId2"><p:embed/><p:pic><p:blipFill><a:blip r:embed="rId3"/></p:blipFill></p:pic></p:oleObj></a:graphicData></a:graphic></p:graphicFrame></mc:Fallback></mc:AlternateContent>' +
      '<p:sp><p:spPr><a:blipFill><a:blip r:embed="rId3"/></a:blipFill></p:spPr><p:txBody>kept</p:txBody></p:sp></p:spTree>';
    const result = removePictures(
      'ppt/slides/slide1.xml',
      xml,
      new Set(['rId3'])
    );
    expect(result.xml).toBe(
      '<p:spTree><p:sp><p:spPr></p:spPr><p:txBody>kept</p:txBody></p:sp></p:spTree>'
    );
    expect(result.count).toBe(2);
    expect(result.refs.sort()).toEqual(['rId2', 'rId2', 'rId3', 'rId3']);
  });

  it('removes a DOCX picture shown in both alternate branches as one, leaving a text box around it', () => {
    const xml =
      '<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><a:blip r:embed="rId5"/></w:drawing></mc:Choice>' +
      '<mc:Fallback><w:pict><v:shape><v:imagedata r:id="rId5"/></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>' +
      '<w:r><w:drawing><wps:txbx><w:txbxContent><w:p><w:r><w:drawing><a:blip r:embed="rId5"/></w:drawing></w:r></w:p></w:txbxContent></wps:txbx></w:drawing></w:r>';
    const result = removePictures('word/document.xml', xml, new Set(['rId5']));
    expect(result.xml).toBe(
      '<w:r><mc:AlternateContent><mc:Choice Requires="wps"></mc:Choice><mc:Fallback></mc:Fallback></mc:AlternateContent></w:r>' +
        '<w:r><w:drawing><wps:txbx><w:txbxContent><w:p><w:r></w:r></w:p></w:txbxContent></wps:txbx></w:drawing></w:r>'
    );
    expect(result.count).toBe(2);
  });
});

// Security regression (review r5 X1): every unclosed opener is scanned once,
// so a part full of them answers at once; the old tokenizers rescanned to the
// part's end from each (3 to 7 s per shape here, warm).
const seconds = (call: () => unknown) => {
  const started = performance.now();
  call();
  return (performance.now() - started) / 1000;
};

describe('the XML tokenizers', () => {
  it('answer at once on unclosed markup, and the picture still goes', () => {
    const picture =
      '<w:document><w:body><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:body></w:document>';
    for (const [name, tail] of Object.entries({
      'a long name': `<${'a'.repeat(50_000)}<`,
      CDATA: '<![CDATA['.repeat(30_000),
      comments: '<!--'.repeat(50_000),
      declarations: '<?'.repeat(80_000),
      'extension lists': '<a:extLst '.repeat(25_000),
      tags: '<a '.repeat(40_000),
      'unclosed quotes': '<a "'.repeat(30_000),
    })) {
      let result: ReturnType<typeof removePictures> | undefined;
      const took = seconds(() => {
        result = removePictures(
          'word/document.xml',
          picture + tail,
          new Set(['rId1'])
        );
      });
      expect(took, name).toBeLessThan(1);
      expect(result?.count, name).toBe(1);
    }
  });

  it('answer at once on a relationships part ending in unclosed elements', async () => {
    const rels =
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/a.png"/></Relationships>' +
      '<Relationship '.repeat(20_000);
    const file = pack(
      {
        '[Content_Types].xml': strToU8('<Types xmlns="x"/>'),
        'word/_rels/document.xml.rels': strToU8(rels),
        'word/document.xml': strToU8('<w:document/>'),
      },
      'plan.docx'
    );
    const started = performance.now();
    await compressOfficeImages(file, 2 * MB);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('rewrite [Content_Types].xml in one pass', () => {
    // 2,000 removed parts over 20,000 other overrides (about 4 s as a search
    // per part).
    const others = Array.from(
      { length: 20_000 },
      (_, i) => `<Override PartName="/word/p${i}.xml" ContentType="x"/>`
    ).join('');
    const types = `<Types xmlns="x"><Default Extension="xml" ContentType="application/xml"/>${others}<Override PartName="/word/media/image1.emf" ContentType="image/x-emf"/><Override PartName="/WORD/media/image2.png" ContentType="image/png"/></Types>`;
    const deleted = new Set([
      'word/media/image1.emf',
      ...Array.from({ length: 2000 }, (_, i) => `word/media/gone${i}.emf`),
    ]);
    let out = '';
    const took = seconds(() => {
      out = contentTypes(
        types,
        deleted,
        new Map([
          [
            'word/media/image2.png',
            { path: 'word/media/image2.jpeg', type: 'image/jpeg' },
          ],
        ])
      );
    });
    expect(took).toBeLessThan(1);
    expect(out).not.toContain('image1.emf');
    expect(out).toContain(
      '<Override PartName="/word/media/image2.jpeg" ContentType="image/jpeg"/>'
    );
    expect(
      out.split('<Default Extension="jpeg" ContentType="image/jpeg"/>')
    ).toHaveLength(2);
    expect(out.split('<Override')).toHaveLength(20_002);
  });
});

describe('one pass per part', () => {
  const links = (count: number) =>
    Array.from(
      { length: count },
      (_, i) =>
        `<Relationship Id="rIdx${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/${i}" TargetMode="External"/>`
    ).join('');

  it('removePictures keeps the open elements as it reads, so many references deep in a part answer at once', () => {
    // 4,000 references under 50,000 open elements: about 6 s, warm, as a
    // walk down the open elements per reference (review r5 follow-up).
    const drawing = '<w:drawing><a:blip r:embed="rId1"/></w:drawing>';
    const deep = (depth: number, refs: number) =>
      `<w:document>${'<w:p>'.repeat(depth)}${drawing.repeat(refs)}${'</w:p>'.repeat(depth)}`;
    const ids = new Set(['rId1']);
    removePictures('word/document.xml', deep(2000, 200), ids);
    const xml = deep(50_000, 4000);
    let result: ReturnType<typeof removePictures> | undefined;
    const took = seconds(() => {
      result = removePictures('word/document.xml', xml, ids);
    });
    expect(took).toBeLessThan(1);
    expect(result?.count).toBe(4000);
    expect(result?.xml).not.toContain('w:drawing');
  });

  it('rewriteRelationships renames 4,000 and removes 2,000 relationships of a 4 MiB part in one pass', () => {
    // About 6.6 s, warm, as a replace per relationship (review r5 follow-up).
    const renamed = Array.from({ length: 4000 }, (_, i) =>
      rel(`rId${i}`, 'image', `media/image${i}.png`)
    );
    const removed = Array.from({ length: 2000 }, (_, i) =>
      rel(`rIdg${i}`, 'image', `media/gone${i}.emf`)
    );
    const xml = `<Relationships>${links(18_000)}${removed.join('')}${renamed.join('')}</Relationships>`;
    expect(xml.length).toBeLessThan(4 * MB);
    const dead = new Set(Array.from({ length: 2000 }, (_, i) => `rIdg${i}`));
    const changes = new Map(
      renamed.map((element) => [element, element.replace('.png', '.jpeg')])
    );
    rewriteRelationships(xml.slice(0, 10_000), dead, changes);
    let out = '';
    const took = seconds(() => {
      out = rewriteRelationships(xml, dead, changes);
    });
    expect(took).toBeLessThan(1);
    expect(out).not.toContain('gone');
    expect(out).not.toContain('.png');
    expect(out.split('.jpeg')).toHaveLength(4001);
    expect(out.split('<Relationship ')).toHaveLength(22_001);
  });
});

describe('resolveTarget', () => {
  it('resolves relative, parent and absolute targets', () => {
    expect(resolveTarget('word/', 'media/image1.png')).toBe(
      'word/media/image1.png'
    );
    expect(resolveTarget('ppt/slides/', '../media/a%20b.png')).toBe(
      'ppt/media/a b.png'
    );
    expect(resolveTarget('xl/', '/xl/media/x.emf')).toBe('xl/media/x.emf');
  });
});
