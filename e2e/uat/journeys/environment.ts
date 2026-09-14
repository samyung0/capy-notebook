export type UatEnvironment = ReturnType<typeof loadEnvironment>;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for UAT journeys`);
  return value;
}

function configuredURL(name: string) {
  const value = required(name);
  try {
    return new URL(value);
  } catch {
    // biome-ignore lint/style/useErrorCause: URL errors retain credential-bearing input.
    throw new Error(`${name} must be a valid URL`);
  }
}

function exactURL(name: string, expected: string): string {
  const url = configuredURL(name);
  if (
    url.origin !== expected ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must select ${expected}`);
  }
  return expected;
}

export function loadEnvironment() {
  if (required('UAT_TARGET_AUTHORIZED') !== 'true') {
    throw new Error('UAT_TARGET_AUTHORIZED must be exactly true');
  }
  if (required('UAT_CLERK_TEST_MODE') !== 'true') {
    throw new Error(
      'Enable Clerk test emails on the isolated UAT instance and set UAT_CLERK_TEST_MODE=true'
    );
  }
  const expectedRevision = required('EXPECTED_REVISION');
  if (!/^[a-f0-9]{40}$/.test(expectedRevision)) {
    throw new Error('EXPECTED_REVISION must be a full lowercase Git SHA');
  }
  const actorEmailDomain = required('UAT_ACTOR_EMAIL_DOMAIN');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(actorEmailDomain)) {
    throw new Error(
      'UAT_ACTOR_EMAIL_DOMAIN must be a domain, without a mailbox'
    );
  }
  const databaseURL = configuredURL('UAT_DATABASE_URL');
  if (!['postgres:', 'postgresql:'].includes(databaseURL.protocol)) {
    throw new Error('UAT_DATABASE_URL must be a PostgreSQL URL');
  }
  if (decodeURIComponent(databaseURL.username) !== 'capy_uat_verifier') {
    throw new Error(
      'UAT_DATABASE_URL must use the read-only capy_uat_verifier role'
    );
  }
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(databaseURL.hostname) &&
    databaseURL.searchParams.get('sslmode') !== 'verify-full'
  ) {
    throw new Error(
      'UAT_DATABASE_URL requires a local SSH tunnel or sslmode=verify-full'
    );
  }
  const b2Bucket = required('B2_BUCKET');
  if (!/(^|[-_])uat($|[-_])/.test(b2Bucket)) {
    throw new Error('B2_BUCKET must identify a dedicated UAT bucket');
  }
  const b2Endpoint = configuredURL('B2_ENDPOINT');
  if (
    b2Endpoint.protocol !== 'https:' ||
    !b2Endpoint.hostname.endsWith('.backblazeb2.com') ||
    b2Endpoint.username ||
    b2Endpoint.password
  ) {
    throw new Error('B2_ENDPOINT must be an HTTPS Backblaze endpoint');
  }
  const sentryBaseUrl = configuredURL('UAT_SENTRY_URL');
  if (
    sentryBaseUrl.protocol !== 'https:' ||
    !['sentry.io', 'us.sentry.io', 'de.sentry.io'].includes(
      sentryBaseUrl.hostname
    ) ||
    sentryBaseUrl.username ||
    sentryBaseUrl.password
  ) {
    throw new Error('UAT_SENTRY_URL must be an HTTPS Sentry URL');
  }
  const stripeSecretKey = required('STRIPE_SECRET_KEY');
  if (!stripeSecretKey.startsWith('sk_test_')) {
    throw new Error('STRIPE_SECRET_KEY must be a sandbox test key');
  }
  const sentryProjectSlugs = required('UAT_SENTRY_PROJECTS')
    .split(',')
    .map((value) => value.trim());
  if (sentryProjectSlugs.some((value) => !/^[a-z0-9_-]+$/.test(value))) {
    throw new Error('UAT_SENTRY_PROJECTS must contain project slugs');
  }
  for (const name of ['B2_KEY_ID', 'B2_APP_KEY', 'B2_REGION']) required(name);
  return {
    actorEmailDomain,
    apiUrl: exactURL('UAT_API_URL', 'https://uat-api.capynotebook.com'),
    appUrl: exactURL('UAT_APP_URL', 'https://uat.capynotebook.com'),
    b2Bucket,
    clerkPublishableKey: required('CLERK_PUBLISHABLE_KEY'),
    clerkSecretKey: required('CLERK_SECRET_KEY'),
    collabUrl: exactURL('UAT_COLLAB_URL', 'wss://uat-collab.capynotebook.com'),
    databaseName: required('UAT_DATABASE_NAME'),
    expectedRevision,
    resendFrom: required('UAT_RESEND_FROM'),
    resendReadKey: required('UAT_RESEND_READ_KEY'),
    sentryBaseUrl: sentryBaseUrl.origin,
    sentryOrganization: required('UAT_SENTRY_ORG'),
    sentryProjectSlugs,
    sentryToken: required('UAT_SENTRY_TOKEN'),
    signupVerificationMode: 'clerk-test' as const,
    stripeAccountId: required('UAT_STRIPE_ACCOUNT_ID'),
    stripePriceId: required('STRIPE_PRICE_PRO'),
    stripeSecretKey,
  };
}
