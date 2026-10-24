import { HttpResponse, http } from 'msw';
import type { EditorAssetItem } from '@/api/types';

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

/** The viewer's images and audio (M16): one in a set it can open, one in a
 * note it can no longer open. */
const embeds: EditorAssetItem[] = [
  {
    assetId: 'asset_mock_cell_diagram',
    createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    lostAccess: false,
    materialId: 'dk_1',
    materialTitle: 'Cell organelles',
    name: 'animal-cell.svg',
    purpose: 'image',
    sizeBytes: 1240,
    workspaceName: 'Biology 101',
  },
  {
    assetId: 'asset_mock_lost_figure',
    createdAt: new Date(Date.now() - 12 * 86_400_000).toISOString(),
    lostAccess: true,
    materialTitle: 'Cell division recap',
    name: 'mitosis-stages.png',
    purpose: 'image',
    sizeBytes: 482_000,
    workspaceName: 'Study group',
  },
];

export const editorAssetHandlers = [
  // Signed-out share pages load images through the site Worker's route.
  http.get('/p/:kind/:token/assets/:assetId', async ({ params }) => {
    const asset = assets[String(params.assetId)];
    if (!asset) return new HttpResponse(null, { status: 404 });
    return new HttpResponse(await (await fetch(asset.url)).blob());
  }),
  // The mock gateway always has a free slot: every ticket's turn is now.
  http.post('/api/materials/:id/editor-assets/uploads/tickets', () =>
    HttpResponse.json({ position: 0, ticketId: 'utk_mock' }, { status: 201 })
  ),
  // Mirrors the streamed upload: one multipart request, metadata then file.
  http.post('/api/materials/:id/editor-assets/uploads', async ({ request }) => {
    const form = await request.formData();
    const body = JSON.parse(String(form.get('metadata'))) as {
      contentType: string;
      name: string;
      purpose: 'image' | 'audio';
    };
    const bytes = form.get('file');
    if (!(bytes instanceof Blob))
      return new HttpResponse(null, { status: 400 });
    const id = `asset_mock_${crypto.randomUUID()}`;
    uploads.set(id, body);
    assets[id] = { name: body.name, url: URL.createObjectURL(bytes) };
    return HttpResponse.json(
      {
        assetId: id,
        completedAt: new Date().toISOString(),
        contentType: body.contentType,
        createdAt: new Date().toISOString(),
        name: body.name,
        purpose: body.purpose,
        sizeBytes: bytes.size,
        status: 'ready',
        workspaceId: '',
      },
      { status: 201 }
    );
  }),
  http.get('/api/editor-assets', ({ request }) => {
    const access = new URL(request.url).searchParams.get('access');
    return HttpResponse.json({
      items: embeds.filter(
        (item) => !access || item.lostAccess === (access === 'lost')
      ),
    });
  }),
  // Only media in a note the viewer can no longer open are deleted here.
  http.delete('/api/editor-assets/:id', ({ params }) => {
    const i = embeds.findIndex(
      (item) => item.assetId === params.id && item.lostAccess
    );
    if (i < 0) return new HttpResponse(null, { status: 404 });
    embeds.splice(i, 1);
    return new HttpResponse(null, { status: 204 });
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
