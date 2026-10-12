import PostalMime from 'postal-mime';

// The UAT journey inbox. Email Routing delivers journeys+…@inbox.uat.capynotebook.com
// here; each message is kept in KV for a day and the journeys read it back
// with a bearer token. KV reads elsewhere can trail a write by up to a minute,
// which the journeys' polling absorbs.

const RETENTION_SECONDS = 24 * 60 * 60;

interface InboxStore {
  get(key: string): Promise<string | null>;
  list(options: { prefix: string }): Promise<{ keys: { name: string }[] }>;
  put(
    key: string,
    value: string,
    options: { expirationTtl: number }
  ): Promise<unknown>;
}

interface InboxEnv {
  INBOX: InboxStore;
  READ_TOKEN: string;
  SENDER_DOMAIN: string;
}

interface IncomingEmail {
  from: string;
  raw: ReadableStream<Uint8Array>;
  setReject(reason: string): void;
  to: string;
}

export interface InboxMessage {
  from: string;
  /** Lowercase header names; a repeated header keeps its last value. */
  headers: Record<string, string>;
  html: string;
  receivedAt: string;
  subject: string;
  text: string;
  to: string;
}

async function digest(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  );
}

// Compares digests so the time taken reveals nothing about the token itself.
async function authorized(header: string | null, token: string) {
  if (!(token && header?.startsWith('Bearer '))) return false;
  const [given, expected] = await Promise.all([
    digest(header.slice('Bearer '.length)),
    digest(token),
  ]);
  let difference = 0;
  for (let i = 0; i < expected.length; i++)
    difference |= given[i] ^ expected[i];
  return difference === 0;
}

export default {
  async email(message: IncomingEmail, env: InboxEnv) {
    // The envelope sender is the provider's bounce address under the sending
    // domain (cf-bounce.uat.… or send.uat.…), so a suffix match admits UAT only.
    const domain = message.from.toLowerCase().split('@').pop() ?? '';
    if (
      domain !== env.SENDER_DOMAIN &&
      !domain.endsWith(`.${env.SENDER_DOMAIN}`)
    ) {
      message.setReject('This inbox accepts UAT mail only');
      return;
    }
    const email = await PostalMime.parse(message.raw);
    const receivedAt = new Date().toISOString();
    const to = message.to.toLowerCase();
    const stored: InboxMessage = {
      from: email.from?.address ?? '',
      headers: Object.fromEntries(email.headers.map((h) => [h.key, h.value])),
      html: email.html ?? '',
      receivedAt,
      subject: email.subject ?? '',
      text: email.text ?? '',
      to,
    };
    await env.INBOX.put(
      `${to}/${receivedAt}-${crypto.randomUUID()}`,
      JSON.stringify(stored),
      { expirationTtl: RETENTION_SECONDS }
    );
  },

  async fetch(request: Request, env: InboxEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/messages')
      return new Response('Not found', { status: 404 });
    if (
      !(await authorized(request.headers.get('Authorization'), env.READ_TOKEN))
    )
      return new Response('Unauthorized', { status: 401 });
    const to = url.searchParams.get('to')?.toLowerCase() ?? '';
    if (!to.includes('@'))
      return new Response('to is required', { status: 400 });
    const { keys } = await env.INBOX.list({ prefix: `${to}/` });
    const messages = await Promise.all(
      keys.map(async ({ name }) => {
        const value = await env.INBOX.get(name);
        return value ? (JSON.parse(value) as InboxMessage) : null;
      })
    );
    return Response.json(
      messages.filter((message) => message !== null),
      { headers: { 'Cache-Control': 'no-store' } }
    );
  },
};
