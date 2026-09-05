import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type * as Y from 'yjs';
import {
  type CollaborationAccess,
  type CollaborationContext,
  MATERIAL_ROOM_PATTERN,
} from './auth.js';
import {
  applyCollaborationCommand,
  type CollaborationCommand,
  isCollaborationCommand,
} from './commands.js';
import { readInternalCommandJson } from './internalCommandRequest.js';

interface DirectConnection {
  disconnect(options?: { unloadImmediately?: boolean }): Promise<void>;
  transact(transaction: (document: Y.Doc) => void): Promise<void>;
}

interface DirectConnectionHost {
  openDirectConnection(
    room: string,
    context: CollaborationContext
  ): Promise<DirectConnection>;
}

type Completion =
  | { state: 'pending' }
  | { error: unknown; state: 'failed' }
  | { state: 'succeeded' };

/**
 * Hocuspocus logs and swallows store-hook errors. Keep the result outside that
 * promise so an internal command can still report whether its projection ran.
 */
export class ServiceCommandCompletions {
  private readonly commands = new Map<string, Completion>();

  register(id: string) {
    if (this.commands.has(id))
      throw new Error('service command already exists');
    this.commands.set(id, { state: 'pending' });
  }

  succeed(id: string) {
    if (this.commands.has(id)) this.commands.set(id, { state: 'succeeded' });
  }

  fail(id: string, error: unknown) {
    if (this.commands.has(id)) {
      this.commands.set(id, { error, state: 'failed' });
    }
  }

  assertSucceeded(id: string) {
    const completion = this.commands.get(id);
    this.commands.delete(id);
    if (!completion || completion.state === 'pending') {
      throw new Error('service command persistence did not complete');
    }
    if (completion.state === 'failed') throw completion.error;
  }

  discard(id: string) {
    this.commands.delete(id);
  }
}

export async function observeServiceCommandStore<T>(
  completions: ServiceCommandCompletions,
  commandId: string | undefined,
  store: () => Promise<T>
): Promise<T> {
  try {
    const result = await store();
    if (commandId) completions.succeed(commandId);
    return result;
  } catch (error) {
    if (commandId) completions.fail(commandId, error);
    throw error;
  }
}

export interface ExecuteServiceCommandDependencies {
  assertRoomAvailable: (room: string) => void;
  commandConnectionAccess: (
    room: string,
    actorUserId: string
  ) => Promise<CollaborationAccess>;
  completions: ServiceCommandCompletions;
  hocuspocus: DirectConnectionHost;
  isRoomEvicting: (room: string) => Promise<boolean>;
}

export async function executeServiceCommand(
  command: CollaborationCommand,
  dependencies: ExecuteServiceCommandDependencies
) {
  const roomMaterialId = MATERIAL_ROOM_PATTERN.exec(command.room)?.[1];
  if (roomMaterialId !== command.materialId) {
    throw new Error('collaboration command room does not match material');
  }
  dependencies.assertRoomAvailable(command.room);
  if (await dependencies.isRoomEvicting(command.room)) {
    throw new Error('collaboration room is being compacted');
  }

  const commandId = randomUUID();
  dependencies.completions.register(commandId);
  let connection: DirectConnection | undefined;
  try {
    const access = await dependencies.commandConnectionAccess(
      command.room,
      command.actorUserId
    );
    connection = await dependencies.hocuspocus.openDirectConnection(
      command.room,
      {
        access,
        expiresAt: Number.MAX_SAFE_INTEGER,
        serviceCommandId: commandId,
        tokenId: 'service-command',
        userId: command.actorUserId,
      }
    );
    await connection.transact((document) =>
      applyCollaborationCommand(document, command)
    );
    await connection.disconnect({ unloadImmediately: true });
    connection = undefined;
    dependencies.completions.assertSucceeded(commandId);
  } catch (error) {
    if (connection) await connection.disconnect().catch(() => undefined);
    dependencies.completions.discard(commandId);
    throw error;
  }
}

function secretMatches(actualValue: string | undefined, expectedValue: string) {
  if (!actualValue) return false;
  const actual = Buffer.from(actualValue);
  const expected = Buffer.from(expectedValue);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function jsonResponse(
  response: ServerResponse,
  status: number,
  value: unknown
) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

export async function handleServiceCommandRequest(
  request: IncomingMessage,
  response: ServerResponse,
  secret: string,
  execute: (command: CollaborationCommand) => Promise<void>
) {
  const header = request.headers['x-collaboration-secret'];
  if (!secretMatches(Array.isArray(header) ? header[0] : header, secret)) {
    jsonResponse(response, 401, { message: 'invalid service secret' });
    return;
  }
  try {
    const command = await readInternalCommandJson(request);
    if (!isCollaborationCommand(command)) {
      jsonResponse(response, 400, {
        message: 'invalid collaboration command',
      });
      return;
    }
    await execute(command);
    jsonResponse(response, 200, { status: 'applied' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const conflict =
      message.includes('concurrently') || message.includes('no longer exists');
    jsonResponse(response, conflict ? 409 : 503, { message });
  }
}
