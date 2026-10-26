import type { BrowserContext, Page, WebSocketRoute } from '@playwright/test';

/**
 * The context's collaboration sockets pass through the test, so going offline
 * closes them for certain and keeps new ones closed until back online. Set it
 * up before the page opens its socket.
 */
export async function collaborationLink(context: BrowserContext) {
  const port = process.env.E2E_COLLABORATION_PORT;
  let up = true;
  const open: WebSocketRoute[] = [];
  await context.routeWebSocket(
    (url) => url.port === port,
    (socket) => {
      if (!up) {
        void socket.close();
        return;
      }
      open.push(socket, socket.connectToServer());
    }
  );
  return {
    async down(page: Page) {
      up = false;
      await context.setOffline(true);
      for (const socket of open.splice(0)) await socket.close();
      // Chromium's offline emulation does not reliably fire the event.
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    },
    async up(page: Page) {
      up = true;
      await context.setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
    },
  };
}
