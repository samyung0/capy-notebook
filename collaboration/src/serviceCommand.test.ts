import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from '@hocuspocus/server';
import { slateNodesToInsertDelta, yTextToSlateElement } from '@slate-yjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { CollaborationContext } from './auth.js';
import type { CollaborationCommand } from './commands.js';
import {
  executeServiceCommand,
  handleServiceCommandRequest,
  observeServiceCommandStore,
  ServiceCommandCompletions,
} from './serviceCommand.js';

const hocuspocusServers: Server[] = [];
const httpServers: HttpServer[] = [];

afterEach(async () => {
  await Promise.all(
    httpServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
  await Promise.all(
    hocuspocusServers.splice(0).map((server) => server.destroy())
  );
  vi.restoreAllMocks();
});

function initialState(block: Record<string, unknown>) {
  const document = new Y.Doc();
  document
    .get('content', Y.XmlText)
    .applyDelta(slateNodesToInsertDelta([block] as never));
  const state = Y.encodeStateAsUpdate(document);
  document.destroy();
  return state;
}

async function runCommand(projectionError?: Error) {
  const expectedBlock = {
    children: [{ text: 'Old' }],
    id: 'block-1',
    type: 'p',
  };
  const replacementBlock = {
    ...expectedBlock,
    children: [{ text: 'New' }],
  };
  const command: CollaborationCommand = {
    actorUserId: 'user-1',
    expectedBlock,
    materialId: 'material-1',
    replacementBlock,
    room: 'material:material-1:schema:1',
    type: 'replace-block',
  };
  const completions = new ServiceCommandCompletions();
  let durableState = initialState(expectedBlock);
  const hocuspocus = new Server<CollaborationContext>({
    async onLoadDocument({ document }) {
      Y.applyUpdate(document, durableState);
    },
    async onStoreDocument({ document, lastContext }) {
      await observeServiceCommandStore(
        completions,
        lastContext?.serviceCommandId,
        async () => {
          durableState = Y.encodeStateAsUpdate(document);
          if (projectionError) throw projectionError;
        }
      );
    },
    quiet: true,
  });
  hocuspocusServers.push(hocuspocus);
  const execute = (input: CollaborationCommand) =>
    executeServiceCommand(input, {
      assertRoomAvailable: () => undefined,
      commandConnectionAccess: async () => 'write',
      completions,
      hocuspocus: hocuspocus.hocuspocus,
      isRoomEvicting: async () => false,
    });
  const httpServer = createServer((request, response) => {
    void handleServiceCommandRequest(request, response, 'test-secret', execute);
  });
  httpServers.push(httpServer);
  await new Promise<void>((resolve) =>
    httpServer.listen(0, '127.0.0.1', resolve)
  );
  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('test server has no TCP address');
  }
  const response = await fetch(
    `http://127.0.0.1:${address.port}/internal/commands`,
    {
      body: JSON.stringify(command),
      headers: {
        'content-type': 'application/json',
        'x-collaboration-secret': 'test-secret',
      },
      method: 'POST',
    }
  );
  const durableDocument = new Y.Doc();
  Y.applyUpdate(durableDocument, durableState);
  const content = (
    yTextToSlateElement(durableDocument.get('content', Y.XmlText)) as {
      children: unknown[];
    }
  ).children;
  durableDocument.destroy();
  return { content, response };
}

describe('service command HTTP persistence', () => {
  it('returns 200 after the durable store and projection succeed', async () => {
    const { content, response } = await runCommand();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'applied' });
    expect(content).toEqual([
      {
        children: [{ text: 'New' }],
        id: 'block-1',
        type: 'p',
      },
    ]);
  });

  it('returns 503 when projection fails after the Yjs state is durable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { content, response } = await runCommand(
      new Error('projection failed (503): unavailable')
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      message: 'projection failed (503): unavailable',
    });
    expect(content).toEqual([
      {
        children: [{ text: 'New' }],
        id: 'block-1',
        type: 'p',
      },
    ]);
  });
});
