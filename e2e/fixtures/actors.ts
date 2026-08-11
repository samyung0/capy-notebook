import {
  type APIRequestContext,
  type Browser,
  test as base,
  type Page,
} from '@playwright/test';
import type { Material } from '../../src/api/gen/model/material';
import type { Workspace } from '../../src/api/gen/model/workspace';
import { e2eHeaders, seed, users } from './seed';

type MaterialFactory = {
  createNote: (input: {
    blockId: string;
    body: string;
    title: string;
    workspaceId: string;
  }) => Promise<Material>;
};

type WorkspaceFactory = {
  create: (input: { name: string }) => Promise<Workspace>;
};

type ActorFixtures = {
  ownerPage: Page;
  editorPage: Page;
  commenterPage: Page;
  viewerPage: Page;
  otherPage: Page;
  anonymousPage: Page;
  ownerApi: APIRequestContext;
  editorApi: APIRequestContext;
  commenterApi: APIRequestContext;
  viewerApi: APIRequestContext;
  otherApi: APIRequestContext;
  anonymousApi: APIRequestContext;
  materialFactory: MaterialFactory;
  seed: typeof seed;
  workspaceFactory: WorkspaceFactory;
};

/**
 * Identity comes from headers the Vite proxy forwards to the Go gateway, and
 * `EventSource` cannot set headers of its own, so the streaming endpoints need
 * an interceptor rather than a fetch-level default.
 *
 * The pattern has to stay this narrow. Every intercepted request is a round
 * trip through the test process, and the dev server serves ~500 modules per
 * page: matching `**\/*` put a thousand of those round trips in front of the
 * editor's lazy chunk and pushed page load past the assertion budget whenever
 * several workers loaded the editor at once.
 */
async function pageAs(browser: Browser, userId: string) {
  const context = await browser.newContext();
  const appOrigin = new URL(process.env.E2E_BASE_URL!).origin;
  const headers = e2eHeaders(userId);
  await context.route(`${appOrigin}/api/**`, async (route) => {
    const request = route.request();
    await route.continue({ headers: { ...request.headers(), ...headers } });
  });
  return { context, page: await context.newPage() };
}

export const test = base.extend<ActorFixtures>({
  anonymousApi: async ({ playwright }, use) => {
    const api = await playwright.request.newContext({
      baseURL: process.env.E2E_API_URL!,
    });
    await use(api);
    await api.dispose();
  },

  anonymousPage: async ({ browser }, use) => {
    const context = await browser.newContext();
    await use(await context.newPage());
    await context.close();
  },

  commenterApi: async ({ playwright }, use) => {
    const api = await playwright.request.newContext({
      baseURL: process.env.E2E_API_URL!,
      extraHTTPHeaders: e2eHeaders(users.commenter),
    });
    await use(api);
    await api.dispose();
  },

  commenterPage: async ({ browser }, use) => {
    const { context, page } = await pageAs(browser, users.commenter);
    await use(page);
    await context.close();
  },

  editorApi: async ({ playwright }, use) => {
    const api = await playwright.request.newContext({
      baseURL: process.env.E2E_API_URL!,
      extraHTTPHeaders: e2eHeaders(users.editor),
    });
    await use(api);
    await api.dispose();
  },

  editorPage: async ({ browser }, use) => {
    const { context, page } = await pageAs(browser, users.editor);
    await use(page);
    await context.close();
  },

  materialFactory: async ({ ownerApi }, use) => {
    const materialIds: string[] = [];
    await use({
      createNote: async ({ blockId, body, title, workspaceId }) => {
        const response = await ownerApi.post(
          `/api/workspaces/${workspaceId}/materials`,
          {
            data: {
              content: {
                schemaVersion: 1,
                value: [
                  {
                    children: [{ text: body }],
                    id: blockId,
                    type: 'p',
                  },
                ],
              },
              kind: 'note',
              title,
            },
          }
        );
        if (response.status() !== 201) {
          throw new Error(
            `Failed to create E2E material (${response.status()}): ${await response.text()}`
          );
        }
        const material = (await response.json()) as Material;
        materialIds.push(material.id);
        return material;
      },
    });
    for (const materialId of materialIds.reverse()) {
      const response = await ownerApi.delete(`/api/materials/${materialId}`);
      if (response.status() !== 204) {
        throw new Error(
          `Failed to clean up E2E material ${materialId}: ${response.status()}`
        );
      }
    }
  },

  otherApi: async ({ playwright }, use) => {
    const api = await playwright.request.newContext({
      baseURL: process.env.E2E_API_URL!,
      extraHTTPHeaders: e2eHeaders(users.other),
    });
    await use(api);
    await api.dispose();
  },

  otherPage: async ({ browser }, use) => {
    const { context, page } = await pageAs(browser, users.other);
    await use(page);
    await context.close();
  },

  ownerApi: async ({ playwright }, use) => {
    const api = await playwright.request.newContext({
      baseURL: process.env.E2E_API_URL!,
      extraHTTPHeaders: e2eHeaders(users.owner),
    });
    await use(api);
    await api.dispose();
  },

  ownerPage: async ({ browser }, use) => {
    const { context, page } = await pageAs(browser, users.owner);
    await use(page);
    await context.close();
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires object destructuring for fixture dependencies.
  seed: async ({}, use) => {
    await use(seed);
  },

  viewerApi: async ({ playwright }, use) => {
    const api = await playwright.request.newContext({
      baseURL: process.env.E2E_API_URL!,
      extraHTTPHeaders: e2eHeaders(users.viewer),
    });
    await use(api);
    await api.dispose();
  },

  viewerPage: async ({ browser }, use) => {
    const { context, page } = await pageAs(browser, users.viewer);
    await use(page);
    await context.close();
  },

  workspaceFactory: async ({ ownerApi }, use) => {
    const workspaceIds: string[] = [];
    await use({
      create: async ({ name }) => {
        const response = await ownerApi.post('/api/workspaces', {
          data: { color: 'graphite', name },
        });
        if (response.status() !== 201) {
          throw new Error(
            `Failed to create E2E workspace (${response.status()}): ${await response.text()}`
          );
        }
        const workspace = (await response.json()) as Workspace;
        workspaceIds.push(workspace.id);
        return workspace;
      },
    });
    for (const workspaceId of workspaceIds.reverse()) {
      const response = await ownerApi.delete(`/api/workspaces/${workspaceId}`);
      if (response.status() !== 204) {
        throw new Error(
          `Failed to clean up E2E workspace ${workspaceId}: ${response.status()}`
        );
      }
    }
  },
});

export { expect } from '@playwright/test';
