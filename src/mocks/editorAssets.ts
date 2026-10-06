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

// Uploads keep their bytes as an object URL so resolve serves them back.
const uploads = new Map<string, { contentType: string; name: string }>();

export const editorAssetHandlers = [
  // Signed-out share pages load images through the site Worker's route.
  http.get('/p/:kind/:token/assets/:assetId', async ({ params }) => {
    const asset = assets[String(params.assetId)];
    if (!asset) return new HttpResponse(null, { status: 404 });
    return new HttpResponse(await (await fetch(asset.url)).blob());
  }),
  http.post('/api/materials/:id/editor-assets/uploads', async ({ request }) => {
    const body = (await request.json()) as {
      contentType: string;
      name: string;
    };
    const id = `asset_mock_${crypto.randomUUID()}`;
    uploads.set(id, body);
    return HttpResponse.json({
      assetId: id,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      headers: { 'Content-Type': body.contentType },
      method: 'PUT',
      uploadId: id,
      url: `/mock-editor-uploads/${id}`,
    });
  }),
  http.put('/mock-editor-uploads/:id', async ({ params, request }) => {
    const id = String(params.id);
    const upload = uploads.get(id);
    if (!upload) return new HttpResponse(null, { status: 404 });
    assets[id] = {
      name: upload.name,
      url: URL.createObjectURL(await request.blob()),
    };
    return new HttpResponse(null, { status: 200 });
  }),
  http.post(
    '/api/materials/:id/editor-assets/uploads/:uploadId/complete',
    ({ params }) => {
      const id = String(params.uploadId);
      const upload = uploads.get(id);
      if (!upload || !assets[id])
        return new HttpResponse(null, { status: 409 });
      return HttpResponse.json({
        assetId: id,
        completedAt: new Date().toISOString(),
        contentType: upload.contentType,
        createdAt: new Date().toISOString(),
        name: upload.name,
        purpose: 'image',
        sizeBytes: 0,
        status: 'ready',
        workspaceId: '',
      });
    }
  ),
  // Every known asset already belongs to the note; unknown ones are gone.
  http.post('/api/materials/:id/editor-assets/adopt', async ({ request }) => {
    const { assetIds } = (await request.json()) as { assetIds: string[] };
    return HttpResponse.json({
      assets: assetIds.map((id) =>
        assets[id] ? { assetId: id, sourceId: id } : { sourceId: id }
      ),
    });
  }),
  http.get('/api/editor-assets/:id/resolve', ({ params }) => {
    const id = String(params.id);
    const asset = assets[id];
    if (!asset) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json({
      assetId: id,
      contentType: uploads.get(id)?.contentType ?? 'image/svg+xml',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      name: asset.name,
      purpose: 'image',
      sizeBytes: asset.url.length,
      url: asset.url,
    });
  }),
];
