const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
    status,
  });

function hostAllowed(host, rules) {
  return rules.some((rule) =>
    rule.startsWith('.') ? host.endsWith(rule) : host === rule
  );
}

async function sameSecret(actual, expected) {
  const bytes = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', bytes.encode(actual)),
    crypto.subtle.digest('SHA-256', bytes.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let different = left.length ^ right.length;
  for (let i = 0; i < left.length; i += 1) different |= left[i] ^ right[i];
  return different === 0;
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST')
      return json({ message: 'method not allowed' }, 405);
    if (!env.RELAY_TOKEN || !env.B2_HOST || !env.MINERU_UPLOAD_HOSTS) {
      return json({ message: 'relay is not configured' }, 503);
    }
    const auth = request.headers.get('authorization') || '';
    if (!(await sameSecret(auth, `Bearer ${env.RELAY_TOKEN}`))) {
      return json({ message: 'unauthorized' }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ message: 'invalid JSON' }, 400);
    }
    let source;
    let destination;
    try {
      source = new URL(body.sourceUrl);
      destination = new URL(body.destinationUrl);
    } catch {
      return json({ message: 'invalid relay URL' }, 400);
    }
    const mineruHosts = env.MINERU_UPLOAD_HOSTS.split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (
      source.protocol !== 'https:' ||
      !hostAllowed(source.hostname.toLowerCase(), [
        env.B2_HOST.toLowerCase(),
        `.${env.B2_HOST.toLowerCase()}`,
      ]) ||
      destination.protocol !== 'https:' ||
      !hostAllowed(destination.hostname.toLowerCase(), mineruHosts)
    ) {
      return json({ message: 'relay host is not allowed' }, 403);
    }

    const configuredMax = Number(env.MAX_BYTES || 10 * 1024 * 1024);
    const requestedMax = Number(body.maxBytes || configuredMax);
    const maxBytes = Math.min(configuredMax, requestedMax);
    const timeoutMs = Number(env.RELAY_TIMEOUT_MS || 120_000);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort('relay timeout'),
      timeoutMs
    );
    try {
      const sourceResponse = await fetch(source, {
        redirect: 'error',
        signal: controller.signal,
      });
      if (!sourceResponse.ok || !sourceResponse.body) {
        return json(
          { message: `source fetch failed (${sourceResponse.status})` },
          502
        );
      }
      const size = Number(sourceResponse.headers.get('content-length'));
      if (!Number.isFinite(size) || size < 0 || size > maxBytes) {
        await sourceResponse.body.cancel();
        return json(
          { message: 'source size is missing or exceeds the relay limit' },
          413
        );
      }
      const uploaded = await fetch(destination, {
        body: sourceResponse.body,
        method: 'PUT',
        redirect: 'manual',
        signal: controller.signal,
      });
      await uploaded.body?.cancel();
      if (!uploaded.ok) {
        return json(
          { message: `destination upload failed (${uploaded.status})` },
          502
        );
      }
      return json({ bytes: size, ok: true });
    } catch {
      const timedOut = controller.signal.aborted;
      return json(
        { message: timedOut ? 'relay timed out' : 'relay transfer failed' },
        502
      );
    } finally {
      clearTimeout(timer);
    }
  },
};
