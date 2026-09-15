import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';
import { test as base } from '@playwright/test';
import {
  closeActorContext,
  createPrimaryActor,
  createSecondaryActor,
} from './accounts';
import { loadEnvironment, type UatEnvironment } from './environment';
import {
  poll,
  readManifest,
  sanitize,
  verify,
  writeEvidence,
  writeManifest,
} from './evidence';

export { expect } from '@playwright/test';
export type { UatEnvironment } from './environment';

export type Actor = {
  id: string;
  email: string;
  page: Page;
  context: BrowserContext;
  request(
    path: string,
    method?: string,
    body?: unknown
  ): Promise<{ status: number; body: unknown }>;
};

export class UatRun {
  readonly env: UatEnvironment;
  readonly id: string;
  owner!: Actor;
  private readonly actors: Actor[] = [];
  private readonly browser: Browser;
  private readonly info: TestInfo;

  constructor(browser: Browser, info: TestInfo) {
    this.browser = browser;
    this.info = info;
    this.env = loadEnvironment();
    this.id = process.env.UAT_RUN_ID ?? '';
    readManifest(this.id);
  }

  async initialize() {
    this.owner = await createPrimaryActor(this, this.browser);
    this.actors.push(this.owner);
  }

  async createActor(label: string, password?: string) {
    const actor = await createSecondaryActor(
      this,
      this.browser,
      label,
      password
    );
    this.actors.push(actor);
    return actor;
  }

  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> {
    return verify<T[]>({ operation: 'query', params, sql });
  }

  blob(key: string) {
    return verify<{
      sha256: string;
      size: number;
      contentType: string;
      bodyBase64: string;
    }>({ key, operation: 'blob' });
  }

  poll = poll;

  async record(
    kind: string,
    id: string,
    details: Record<string, unknown> = {}
  ) {
    if (!kind || !id)
      throw new Error('Run resources require a kind and exact ID');
    const manifest = readManifest(this.id);
    const existing = manifest.resources.find(
      (resource) => resource.kind === kind && resource.id === id
    );
    const safe = sanitize(details) as Record<string, unknown>;
    if (existing) Object.assign(existing.details, safe);
    else
      manifest.resources.push({
        createdAt: new Date().toISOString(),
        details: safe,
        id,
        kind,
      });
    writeManifest(manifest);
  }

  async attach(name: string, data: unknown) {
    await this.info.attach(name, {
      contentType: 'application/json',
      path: writeEvidence(this.id, name, data),
    });
  }

  async close() {
    await Promise.all(
      this.actors.map((actor) => closeActorContext(actor.context))
    );
  }
}

export const test = base.extend<{ run: UatRun }>({
  run: async ({ browser }, use, info) => {
    const run = new UatRun(browser, info);
    try {
      await run.initialize();
      await use(run);
    } finally {
      // Provider cleanup is independent of browser sessions and runs globally,
      // including after a revoked session or a failed signup.
      await run.close();
    }
  },
});
