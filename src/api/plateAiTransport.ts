import { DefaultChatTransport, type UIMessage } from 'ai';

import { authHeaders } from './auth';
import { API_BASE } from './client';

export const plateAiCommandUrl = (workspaceId: string) =>
  `${API_BASE}/workspaces/${encodeURIComponent(workspaceId)}/ai/command`;

export const plateAiCopilotUrl = (workspaceId: string) =>
  `${API_BASE}/workspaces/${encodeURIComponent(workspaceId)}/ai/copilot`;

const SENSITIVE_AI_FIELDS = ['apiKey', 'key', 'model', 'provider'] as const;

function stripSensitiveAiFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSensitiveAiFields);
  if (value == null || typeof value !== 'object') return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if ((SENSITIVE_AI_FIELDS as readonly string[]).includes(key)) continue;
    sanitized[key] = stripSensitiveAiFields(child);
  }
  return sanitized;
}

export function sanitizePlateAiBody(
  body: BodyInit | null | undefined
): BodyInit | null | undefined {
  if (typeof body !== 'string') return body;
  try {
    return JSON.stringify(stripSensitiveAiFields(JSON.parse(body)));
  } catch {
    return body;
  }
}

/**
 * Authenticated fetch for Plate's AI SDK transports. Sensitive provider
 * controls are removed even if a caller accidentally copies the Playground's
 * browser-key/model body options.
 */
export async function plateAiFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const auth = await authHeaders();
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(auth)) headers.set(name, value);

  const body = sanitizePlateAiBody(init?.body);

  return fetch(input, { ...init, body, headers });
}

/** Transport consumed directly by @ai-sdk/react's useChat. */
export function createPlateAiTransport<MESSAGE extends UIMessage = UIMessage>(
  workspaceId: string
) {
  return new DefaultChatTransport<MESSAGE>({
    api: plateAiCommandUrl(workspaceId),
    fetch: plateAiFetch,
  });
}

export interface PlateCopilotBody {
  instructions?: string;
  prompt: string;
  system?: string;
}

export interface PlateCopilotResult {
  finishReason: string;
  text: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

/** One-shot inline completion helper; AbortSignal propagates to the provider. */
export async function completePlateCopilot(
  workspaceId: string,
  body: PlateCopilotBody,
  signal?: AbortSignal
): Promise<PlateCopilotResult> {
  const response = await plateAiFetch(plateAiCopilotUrl(workspaceId), {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
    signal,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(
      payload?.error?.message || `AI copilot failed (${response.status})`
    );
  }
  return (await response.json()) as PlateCopilotResult;
}
