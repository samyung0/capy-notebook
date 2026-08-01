import type { YjsDocumentStore } from './persistence.js';

export class ProjectionService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly store: YjsDocumentStore;
  private readonly apiUrl: string;
  private readonly secret: string;

  constructor(store: YjsDocumentStore, apiUrl: string, secret: string) {
    this.store = store;
    this.apiUrl = apiUrl;
    this.secret = secret;
  }

  async project(
    materialId: string,
    version: number,
    content: { schemaVersion: 1; value: unknown[] },
    checkpointIds: string[] = []
  ) {
    const response = await fetch(
      `${this.apiUrl}/internal/collaboration/materials/${encodeURIComponent(materialId)}/projection`,
      {
        body: JSON.stringify({
          checkpointIds,
          content,
          yjsVersion: version,
        }),
        headers: {
          'content-type': 'application/json',
          'x-collaboration-secret': this.secret,
        },
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `projection failed (${response.status}): ${body.slice(0, 500)}`
      );
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.retryPending(), 5000);
    this.timer.unref();
    void this.retryPending();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async retryPending() {
    if (this.running) return;
    this.running = true;
    try {
      for (const row of await this.store.pending()) {
        try {
          await this.project(
            row.materialId,
            row.version,
            this.store.contentFromState(row.state)
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          await this.store.recordProjectionError(row.materialId, message);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
