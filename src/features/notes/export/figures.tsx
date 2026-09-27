import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CategoryChart,
  type ChartFrameProps,
} from '@/components/charts/CategoryChart';
import type { ExportImage, Figure } from './render';

const chartColors = [
  '#4a3aa7',
  '#eb6834',
  '#1baf7a',
  '#2a78d6',
  '#eda100',
  '#e87ba4',
];
function ChartFrame({ children, legend }: ChartFrameProps) {
  return (
    <div>
      {children}
      <div style={{ display: 'flex', flexWrap: 'wrap', fontSize: 12, gap: 12 }}>
        {legend.map((name, index) => (
          <span key={index}>
            <span
              style={{
                background: chartColors[index % chartColors.length],
                display: 'inline-block',
                height: 9,
                marginRight: 4,
                width: 9,
              }}
            />
            {name}
          </span>
        ))}
      </div>
    </div>
  );
}

// html2canvas clones its owner document. Isolate each figure so exporting a
// large mounted note never clones the editor for every formula or diagram.
async function rasterMarkup(
  markup: string,
  css = '',
  inline = false
): Promise<ExportImage> {
  const { default: html2canvas } = await import('html2canvas-pro');
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  Object.assign(frame.style, {
    border: '0',
    height: '1000px',
    left: '-10000px',
    pointerEvents: 'none',
    position: 'fixed',
    width: '1600px',
  });
  document.body.append(frame);
  try {
    const doc = frame.contentDocument!;
    const style = doc.createElement('style');
    style.textContent = `body{margin:0;background:white;color:#111;font:14px Arial} .export-figure{padding:2px;width:${inline ? 'max-content' : '560px'};max-width:1500px} ${css}`;
    doc.head.append(style);
    const host = doc.createElement('div');
    host.className = 'export-figure';
    host.innerHTML = markup;
    doc.body.append(host);
    await doc.fonts.ready;
    const canvas = await html2canvas(host, {
      backgroundColor: '#ffffff',
      logging: false,
      scale: 2,
    });
    return {
      data: canvas.toDataURL('image/png'),
      height: canvas.height / 2,
      width: canvas.width / 2,
    };
  } finally {
    frame.remove();
  }
}

async function svgImage(source: string): Promise<ExportImage> {
  const image = new Image();
  image.src = source;
  await image.decode();
  const scale = Math.min(
    2,
    1600 / Math.max(image.naturalWidth, image.naturalHeight)
  );
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Image conversion is unavailable.');
  context.fillStyle = 'white';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return {
    data: canvas.toDataURL('image/png'),
    height: canvas.height / scale,
    width: canvas.width / scale,
  };
}

/** Only DOM-dependent rendering runs here. Each unique figure yields before
 * work; fetching raster images, downsampling and DOCX compression use the worker. */
export async function renderExportFigure(figure: Figure): Promise<ExportImage> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (figure.type === 'image') return svgImage(figure.source);
  if (figure.type === 'math') {
    if (!figure.html) throw new Error('The formula was not rendered.');
    const { default: css } = await import('katex/dist/katex.min.css?inline');
    return rasterMarkup(figure.html, css, true);
  }
  if (figure.type === 'chart') {
    const css = `:root{${chartColors.map((color, i) => `--chart-${i + 1}:${color}`).join(';')}} svg{width:100%;height:auto;min-width:0!important} svg text{font-family:Arial;font-size:10px;fill:#555} .stroke-line{stroke:#aaa}.stroke-divider{stroke:#ddd}.stroke-surface{stroke:white}`;
    return rasterMarkup(
      renderToStaticMarkup(
        createElement(CategoryChart, { data: figure.block, frame: ChartFrame })
      ),
      css
    );
  }
  const host = document.createElement('div');
  Object.assign(host.style, {
    background: '#fff',
    color: '#111',
    fontFamily: 'Arial',
    fontSize: '16px',
    left: '-10000px',
    padding: '8px',
    pointerEvents: 'none',
    position: 'fixed',
    top: '0',
    width: '560px',
  });
  host.setAttribute('aria-hidden', 'true');
  document.body.append(host);
  try {
    if (figure.type === 'mermaid') {
      const { getMermaid } = await import('@/features/materials/Mermaid');
      const mermaid = await getMermaid();
      const { svg } = await mermaid.render(
        `export-${crypto.randomUUID()}`,
        figure.source,
        host
      );
      host.innerHTML = svg;
    } else throw new Error('Unexpected DOM figure.');
    const svg = host.querySelector('svg');
    if (!svg) throw new Error('The figure did not produce an image.');
    const bounds = svg.viewBox.baseVal;
    svg.setAttribute('width', String(bounds.width || 560));
    svg.setAttribute('height', String(bounds.height || 320));
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    for (const node of [svg, ...svg.querySelectorAll<SVGElement>('*')]) {
      const style = getComputedStyle(node);
      for (const key of [
        'fill',
        'stroke',
        'stroke-width',
        'font-family',
        'font-size',
        'font-weight',
        'color',
      ])
        node.style.setProperty(key, style.getPropertyValue(key));
    }
    // Mermaid's HTML labels need the browser's DOM rasterizer.
    if (svg.querySelector('foreignObject')) {
      return rasterMarkup(host.innerHTML);
    }
    return svgImage(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`
    );
  } finally {
    host.remove();
  }
}
