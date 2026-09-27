const BLIP = /<a:blip\b([^>]*?)(?:\/>|>([\s\S]*?)<\/a:blip>)/;
const VIDEO_DESCRIPTION = /descr="capy-video:([A-Za-z0-9_-]{11})"/;
const RELATIONSHIP = /<Relationship\b[^>]*\/>/g;
const RELATIONSHIP_ID = /\bId="([^"]+)"/;
const DRAWING_PROPERTIES = /<wp:docPr\b([^>]*?)\/>/;
const PICTURE_DESCRIPTION = /<pic:cNvPr\b[^>]*\bdescr="([^"]*)"/;
const PAGE_MARGIN = 1080;
const TOC_MARKER = /w:name="_CapyToc\d+"/;
const KEEP_NEXT_MARKER = /w:name="_CapyKeepNext\d+"/;
const PAGE_WIDTH = /<w:pgSz\b[^>]*w:w="(\d+)"/;

import { Buffer } from 'buffer';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { escapeHtml, type TocEntry } from './render';

function tocXml(entries: TocEntry[]): string {
  const start =
    '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-6" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>';
  const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  if (!entries.length) return `<w:p>${start}${end}</w:p>`;
  // Cache readable entries without inventing pagination. Word calculates the
  // TOC and its nested page-reference fields when it lays out the document.
  return entries
    .map(
      (entry, i) =>
        `<w:p><w:pPr><w:pStyle w:val="TOC${entry.level}"/></w:pPr>${i === 0 ? start : ''}<w:hyperlink w:anchor="${escapeHtml(entry.anchor)}"><w:r><w:t xml:space="preserve">${escapeHtml(entry.text)}</w:t></w:r></w:hyperlink><w:r><w:tab/></w:r><w:fldSimple w:instr="PAGEREF ${escapeHtml(entry.anchor)} \\h" w:dirty="true"><w:r><w:t></w:t></w:r></w:fldSimple>${i === entries.length - 1 ? end : ''}</w:p>`
    )
    .join('');
}

/** The converter and its ZIP dependency use Buffer for images. Scope the
 * browser implementation to the export worker, never the application window. */
export async function makeDocx(
  content: string,
  toc: TocEntry[]
): Promise<Blob> {
  Reflect.set(globalThis, 'Buffer', Buffer);
  const { htmlToDocxBlob } = await import('@platejs/docx-io');
  const blob = await htmlToDocxBlob(`<html><body>${content}</body></html>`, {
    creator: 'Capy Notebook',
    font: 'Calibri',
    fontSize: 22,
    margins: {
      bottom: PAGE_MARGIN,
      left: PAGE_MARGIN,
      right: PAGE_MARGIN,
      top: PAGE_MARGIN,
    },
    table: { row: { cantSplit: true } },
  });
  const zip = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const relationships = strFromU8(zip['word/_rels/document.xml.rels']);
  // Word otherwise opens the converter's file in legacy compatibility mode
  // and treats its online-video extension as an ordinary picture.
  zip['word/settings.xml'] = strToU8(
    strFromU8(zip['word/settings.xml']).replace(
      '</w:settings>',
      '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>'
    )
  );
  let xml = strFromU8(zip['word/document.xml']);
  let hasToc = false;
  xml = xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
    if (TOC_MARKER.test(paragraph)) {
      hasToc = true;
      return tocXml(toc);
    }
    // Answer labels keep with the following paragraph without becoming headings.
    return KEEP_NEXT_MARKER.test(paragraph)
      ? paragraph.replace('<w:pStyle w:val="Heading6"/>', '<w:keepNext/>')
      : paragraph;
  });
  if (hasToc) {
    zip['word/settings.xml'] = strToU8(
      strFromU8(zip['word/settings.xml']).replace(
        '</w:settings>',
        '<w:updateFields w:val="true"/></w:settings>'
      )
    );
    const pageWidth = Number(xml.match(PAGE_WIDTH)?.[1]);
    if (!pageWidth) throw new Error('The document page width is unavailable.');
    const styles = Array.from(
      { length: 6 },
      (_, i) =>
        `<w:style w:type="paragraph" w:styleId="TOC${i + 1}"><w:name w:val="toc ${i + 1}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="${pageWidth - PAGE_MARGIN * 2}"/></w:tabs><w:spacing w:after="80"/><w:ind w:left="${i * 240}"/></w:pPr><w:rPr><w:color w:val="000000"/><w:sz w:val="22"/></w:rPr></w:style>`
    ).join('');
    zip['word/styles.xml'] = strToU8(
      strFromU8(zip['word/styles.xml']).replace(
        '</w:styles>',
        `${styles}</w:styles>`
      )
    );
  }
  xml = xml.replace(/<w:pBdr>[\s\S]*?<\/w:pBdr>/g, (border) =>
    border.replace(/w:color="auto"/g, 'w:color="BBBBBB"')
  );
  // MS-ODRAWXML 2.19.1.1: online-video metadata belongs to a:blip's extension list.
  xml = xml.replace(/<w:drawing>[\s\S]*?<\/w:drawing>/g, (originalDrawing) => {
    let drawing = originalDrawing;
    const id = drawing.match(VIDEO_DESCRIPTION)?.[1];
    const description = drawing.match(PICTURE_DESCRIPTION)?.[1];
    if (description)
      drawing = drawing.replace(
        DRAWING_PROPERTIES,
        `<wp:docPr$1 descr="${id ? 'YouTube video' : description}"/>`
      );
    if (!id) return drawing;
    const iframe = `<iframe width="560" height="315" src="https://www.youtube.com/embed/${id}" frameborder="0" allowfullscreen="true"></iframe>`;
    const extension = `<a:ext uri="{C809E66F-F1BF-436E-b5F7-EEA9579F0CBA}"><wp15:webVideoPr xmlns:wp15="http://schemas.microsoft.com/office/word/2012/wordprocessingDrawing" embeddedHtml="${escapeHtml(iframe)}" w="560" h="315"/></a:ext>`;
    const result = drawing.replace(
      BLIP,
      (_match, attributes: string, children: string | undefined) =>
        `<a:blip${attributes}>${children?.includes('</a:extLst>') ? children.replace('</a:extLst>', `${extension}</a:extLst>`) : `${children || ''}<a:extLst>${extension}</a:extLst>`}</a:blip>`
    );
    if (result === drawing)
      throw new Error('The video preview could not be embedded.');
    const relationship = Array.from(
      relationships.matchAll(RELATIONSHIP),
      (match) => match[0]
    ).find((rel) =>
      rel.includes(`Target="https://www.youtube.com/watch?v=${id}"`)
    );
    const linkId = relationship?.match(RELATIONSHIP_ID)?.[1];
    if (!linkId) throw new Error('The video link could not be embedded.');
    return result
      .replace(
        DRAWING_PROPERTIES,
        `<wp:docPr$1><a:hlinkClick xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:id="${linkId}"/></wp:docPr>`
      )
      .replaceAll(`capy-video:${id}`, 'YouTube video');
  });
  zip['word/document.xml'] = strToU8(xml);
  return new Blob([zipSync(zip, { level: 1 }) as Uint8Array<ArrayBuffer>], {
    type: blob.type,
  });
}
