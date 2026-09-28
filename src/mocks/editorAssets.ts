import { HttpResponse, http } from 'msw';

// Inline SVG so the seed needs no binary fixture or network.
const cellDiagram = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540">
<rect width="960" height="540" fill="#e9f3ee"/>
<ellipse cx="480" cy="270" rx="360" ry="210" fill="#cfe8dc" stroke="#2f7d56" stroke-width="10"/>
<circle cx="440" cy="250" r="86" fill="#b9a8ec" stroke="#5b4aa8" stroke-width="8"/>
<circle cx="420" cy="235" r="26" fill="#5b4aa8"/>
<ellipse cx="660" cy="200" rx="70" ry="34" fill="#ffcc61" stroke="#a9772a" stroke-width="6"/>
<ellipse cx="640" cy="350" rx="62" ry="30" fill="#ffcc61" stroke="#a9772a" stroke-width="6"/>
<ellipse cx="270" cy="360" rx="58" ry="28" fill="#ffcc61" stroke="#a9772a" stroke-width="6"/>
<circle cx="300" cy="190" r="14" fill="#f35a71"/><circle cx="560" cy="420" r="12" fill="#f35a71"/>
<circle cx="760" cy="280" r="12" fill="#f35a71"/>
</svg>`;

const assets: Record<string, { name: string; url: string }> = {
  asset_mock_cell_diagram: {
    name: 'animal-cell.svg',
    url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cellDiagram)}`,
  },
};

export const editorAssetHandlers = [
  http.get('/api/editor-assets/:id/resolve', ({ params }) => {
    const id = String(params.id);
    const asset = assets[id];
    if (!asset) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json({
      assetId: id,
      contentType: 'image/svg+xml',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      name: asset.name,
      purpose: 'image',
      sizeBytes: asset.url.length,
      url: asset.url,
    });
  }),
];
