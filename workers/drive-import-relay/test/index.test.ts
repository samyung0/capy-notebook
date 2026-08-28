import { describe, expect, it } from 'vitest';
import { internals } from '../src/index';

interface FetchCall {
  authorization: string | null;
  redirect: RequestInit['redirect'];
  url: string;
}

function sequenceFetch(
  responses: Response[],
  calls: FetchCall[]
): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      authorization: headers.get('Authorization'),
      redirect: init?.redirect,
      url:
        input instanceof URL
          ? input.href
          : input instanceof Request
            ? input.url
            : input.toString(),
    });
    const response = responses.shift();
    if (!response) throw new Error('unexpected fetch');
    return response;
  };
}

describe('drive import relay', () => {
  it('signs and verifies the shared canonical request', async () => {
    const body = new TextEncoder().encode('{"jobId":"imp_1"}');
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signed = await internals.signature(
      'test-secret',
      timestamp,
      'POST',
      '/enqueue?source=go',
      body
    );
    const request = new Request('https://relay.example/enqueue?source=go', {
      body,
      headers: {
        'X-Import-Relay-Signature': signed,
        'X-Import-Relay-Timestamp': timestamp,
      },
      method: 'POST',
    });

    expect(await internals.validSignature(request, body, 'test-secret')).toBe(
      true
    );
    expect(
      await internals.validSignature(
        request,
        new TextEncoder().encode('{"jobId":"imp_2"}'),
        'test-secret'
      )
    ).toBe(false);
  });

  it('rejects signatures outside the replay window', async () => {
    const body = new Uint8Array();
    const timestamp = Math.floor(Date.now() / 1000 - 301).toString();
    const signed = await internals.signature(
      'test-secret',
      timestamp,
      'POST',
      '/enqueue',
      body
    );
    const request = new Request('https://relay.example/enqueue', {
      body,
      headers: {
        'X-Import-Relay-Signature': signed,
        'X-Import-Relay-Timestamp': timestamp,
      },
      method: 'POST',
    });

    expect(await internals.validSignature(request, body, 'test-secret')).toBe(
      false
    );
  });

  it('fills one bounded allocation across stream chunks', async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3, 4]));
          controller.close();
        },
      })
    );

    await expect(internals.readBounded(response, 4)).resolves.toEqual(
      new Uint8Array([1, 2, 3, 4])
    );
  });

  it('rejects one byte over the cap without concatenating chunks', async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4]));
          controller.close();
        },
      })
    );

    await expect(internals.readBounded(response, 3)).rejects.toMatchObject({
      code: 'file_too_large',
      retryable: false,
    });
  });

  it('rejects oversized or non-Google bearer grants', () => {
    expect(() =>
      internals.parseAcquireResponse({
        attemptToken: 'attempt',
        download: {
          kind: 'bearer',
          token: 'secret',
          url: 'https://attacker.example/file',
        },
        jobId: 'imp_1',
        maxBytes: 1024,
        resumeComplete: false,
        status: 'acquired',
      })
    ).toThrow('download grant invalid');
    expect(() =>
      internals.parseAcquireResponse({
        attemptToken: 'attempt',
        jobId: 'imp_1',
        maxBytes: 30 * 1024 * 1024 + 1,
        resumeComplete: true,
        status: 'acquired',
      })
    ).toThrow('acquire response invalid');
  });

  it('validates upload URLs and every signed header value', () => {
    expect(() =>
      internals.parseUploadGrant({
        expiresAt: new Date().toISOString(),
        headers: { 'Content-Type': 42 },
        url: 'https://storage.example/file',
      })
    ).toThrow('upload headers invalid');
    expect(() =>
      internals.parseUploadGrant({
        expiresAt: new Date().toISOString(),
        headers: {},
        url: 'http://storage.example/file',
      })
    ).toThrow('relay URL must use HTTPS');
    expect(() =>
      internals.parseUploadGrant({
        expiresAt: new Date().toISOString(),
        headers: {},
        url: 'https://user:password@storage.example/file',
      })
    ).toThrow('relay URL must use HTTPS');
  });

  it('requires an HTTPS API origin before relaying OAuth grants', () => {
    expect(
      internals.relayAPIURL('https://api.example.com/root', '/acquire').href
    ).toBe('https://api.example.com/acquire');
    expect(() =>
      internals.relayAPIURL('http://api.example.com', '/acquire')
    ).toThrow('API origin must use HTTPS');
  });

  it('rejects mismatched acquire job ids', () => {
    expect(() =>
      internals.parseAcquireResponseForJob(
        { jobId: 'imp_other', status: 'succeeded' },
        'imp_expected'
      )
    ).toThrow('acquire response job id mismatch');
  });

  it('bounds relay control response bodies before JSON parsing', async () => {
    const fetcher: typeof fetch = async () =>
      new Response(new Uint8Array(64 * 1024 + 1));

    await expect(
      internals.relayPost(
        {
          API_BASE_URL: 'https://api.example.com',
          IMPORT_RELAY_SECRET: 'test-secret',
        },
        '/api/internal/import-relay/acquire',
        { jobId: 'imp_1' },
        undefined,
        fetcher
      )
    ).rejects.toMatchObject({
      code: 'invalid_relay_response',
      retryable: true,
    });
  });

  it('does not follow redirects from the signed relay API', async () => {
    const calls: FetchCall[] = [];
    const fetcher = sequenceFetch(
      [Response.redirect('https://attacker.example/steal', 307)],
      calls
    );

    await expect(
      internals.relayPost(
        {
          API_BASE_URL: 'https://api.example.com',
          IMPORT_RELAY_SECRET: 'test-secret',
        },
        '/api/internal/import-relay/acquire',
        { jobId: 'imp_1' },
        undefined,
        fetcher
      )
    ).rejects.toMatchObject({
      code: 'relay_redirect_refused',
      retryable: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      redirect: 'manual',
      url: 'https://api.example.com/api/internal/import-relay/acquire',
    });
  });

  it('keeps bearer auth only while provider redirects stay same-origin', async () => {
    const calls: FetchCall[] = [];
    const fetcher = sequenceFetch(
      [
        Response.redirect('https://www.googleapis.com/same-origin', 302),
        Response.redirect('https://storage.example/download', 302),
        Response.redirect('https://www.googleapis.com/back', 302),
        new Response(new Uint8Array([1, 2, 3])),
      ],
      calls
    );

    await expect(
      internals.downloadFile(
        {
          kind: 'bearer',
          token: 'google-secret',
          url: 'https://www.googleapis.com/download',
        },
        3,
        new AbortController().signal,
        fetcher
      )
    ).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(calls).toEqual([
      {
        authorization: 'Bearer google-secret',
        redirect: 'manual',
        url: 'https://www.googleapis.com/download',
      },
      {
        authorization: 'Bearer google-secret',
        redirect: 'manual',
        url: 'https://www.googleapis.com/same-origin',
      },
      {
        authorization: null,
        redirect: 'manual',
        url: 'https://storage.example/download',
      },
      {
        authorization: null,
        redirect: 'manual',
        url: 'https://www.googleapis.com/back',
      },
    ]);
  });

  it.each([
    'http://storage.example/download',
    'https://user:password@storage.example/download',
  ])('rejects unsafe provider redirect %s', async (location) => {
    const calls: FetchCall[] = [];
    const fetcher = sequenceFetch([Response.redirect(location, 302)], calls);

    await expect(
      internals.downloadFile(
        {
          kind: 'bearer',
          token: 'google-secret',
          url: 'https://www.googleapis.com/download',
        },
        10,
        new AbortController().signal,
        fetcher
      )
    ).rejects.toMatchObject({
      code: 'provider_download_refused',
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it('stops after five provider redirect hops', async () => {
    const calls: FetchCall[] = [];
    const responses = Array.from({ length: 6 }, (_, index) =>
      Response.redirect(`https://storage.example/redirect-${index + 1}`, 302)
    );

    await expect(
      internals.downloadFile(
        {
          kind: 'url',
          url: 'https://storage.example/download',
        },
        10,
        new AbortController().signal,
        sequenceFetch(responses, calls)
      )
    ).rejects.toThrow('provider redirect limit exceeded');
    expect(calls).toHaveLength(6);
    expect(calls.every((call) => call.redirect === 'manual')).toBe(true);
  });
});
