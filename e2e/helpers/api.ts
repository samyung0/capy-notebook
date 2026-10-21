import {
  type APIRequestContext,
  type APIResponse,
  expect,
  type Page,
  type Response,
} from '@playwright/test';

export function waitForApi(
  page: Page,
  match: (url: string, method: string) => boolean
): Promise<Response> {
  return page.waitForResponse((res) => {
    const url = res.url();
    return match(url, res.request().method());
  });
}

export function apiEndsWith(suffix: string, method = 'GET') {
  return (url: string, m: string) => {
    if (m !== method) return false;
    try {
      const pathname = new URL(url).pathname;
      return pathname === suffix || pathname.endsWith(suffix);
    } catch {
      return url.includes(suffix);
    }
  };
}

/** Uploads a source through the API as the browser does (Epo 2026-10-22):
 * a ticket for its metadata, whose turn comes at once on the local gateway,
 * then one request streaming the metadata part and the file part. A FormData
 * keeps that order (a sorted object would send the file first). */
export async function uploadSourceFile(
  api: APIRequestContext,
  workspaceId: string,
  metadata: { contentType: string; name: string } & Record<string, unknown>,
  bytes: Buffer
): Promise<APIResponse> {
  const path = `/api/workspaces/${workspaceId}/sources/uploads`;
  const ticket = await api.post(`${path}/tickets`, { data: metadata });
  expect(ticket.status(), await ticket.text()).toBe(201);
  const turn = (await ticket.json()) as { position: number; ticketId: string };
  expect(turn.position).toBe(0);
  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  form.append(
    'file',
    new Blob([new Uint8Array(bytes)], { type: metadata.contentType }),
    metadata.name
  );
  return api.post(`${path}?ticket=${encodeURIComponent(turn.ticketId)}`, {
    multipart: form,
  });
}
