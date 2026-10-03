import type { OfficeRenderedPage } from './officeProtocol';

/**
 * Prints page images from the Office runtime, which is sandboxed without
 * modals or popups: a hidden frame on the app's own document holds one image
 * per sheet, sized to the page, and prints once the images decode.
 */
export async function printPages(pages: OfficeRenderedPage[]): Promise<void> {
  if (!pages.length) return;
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  Object.assign(frame.style, {
    border: '0',
    bottom: '0',
    height: '0',
    position: 'fixed',
    right: '0',
    width: '0',
  });
  document.body.append(frame);
  const urls = pages.map((page) =>
    URL.createObjectURL(new Blob([page.bytes], { type: 'image/png' }))
  );
  const cleanup = () => {
    for (const url of urls) URL.revokeObjectURL(url);
    frame.remove();
  };
  try {
    const view = frame.contentWindow;
    const doc = frame.contentDocument;
    if (!(view && doc)) throw new Error('No print frame');
    const first = pages[0];
    const style = doc.createElement('style');
    // One image per sheet at the page's own size; no browser margins.
    style.textContent = [
      `@page { margin: 0; size: ${first.width}px ${first.height}px; }`,
      '* { margin: 0; padding: 0; }',
      'img { display: block; width: 100%; break-after: page; }',
      'img:last-child { break-after: auto; }',
    ].join('\n');
    doc.head.append(style);
    const images = urls.map((url) => {
      const image = doc.createElement('img');
      image.alt = '';
      image.src = url;
      doc.body.append(image);
      return image;
    });
    await Promise.all(images.map((image) => image.decode().catch(() => {})));
    view.addEventListener('afterprint', cleanup, { once: true });
    view.focus();
    view.print();
    // Browsers that print without firing afterprint still drop the frame.
    setTimeout(cleanup, 60_000);
  } catch (error) {
    cleanup();
    throw error;
  }
}
