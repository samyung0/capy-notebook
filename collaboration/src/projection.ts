import {
  captureError,
  ERROR_EVENT_HEADER,
  RETRY_EVENT_HEADER,
  withEventId,
} from './observability.js';
import type { YjsDocumentStore } from './persistence.js';

export class ProjectionService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly failures = new Map<string, string | undefined>();
  private readonly latestResults = new Map<
    string,
    { version: number; succeeded: boolean }
  >();
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
    content: { schemaVersion: 1; value: unknown[] }
  ) {
    const eventId = this.failures.get(materialId);
    const response = await fetch(
      `${this.apiUrl}/internal/collaboration/materials/${encodeURIComponent(materialId)}/projection`,
      {
        body: JSON.stringify({
          content,
          yjsVersion: version,
        }),
        headers: {
          'content-type': 'application/json',
          'x-collaboration-secret': this.secret,
          ...(eventId ? { [RETRY_EVENT_HEADER]: eventId } : {}),
        },
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!response.ok) {
      const body = await response.text();
      throw withEventId(
        new Error(
          `projection failed (${response.status}): ${body.slice(0, 500)}`
        ),
        response.headers.get(ERROR_EVENT_HEADER)
      );
    }
  }

  /**
   * Project one committed Yjs version and persist the failure for the periodic
   * lag retry. The original error still reaches synchronous callers, while
   * failure recording is contained so a database outage cannot create a
   * second detached rejection.
   */
  async projectAndRecord(
    materialId: string,
    version: number,
    content: { schemaVersion: 1; value: unknown[] },
    stage = 'projection'
  ) {
    try {
      await this.project(materialId, version, content);
      if (version >= (this.latestResults.get(materialId)?.version ?? 0)) {
        this.latestResults.set(materialId, { succeeded: true, version });
        this.failures.delete(materialId);
        this.failures.delete(`${materialId}:record`);
      }
    } catch (error) {
      await this.recordFailure(materialId, version, error, stage);
      throw error;
    }
  }

  private async recordFailure(
    materialId: string,
    version: number,
    error: unknown,
    stage: string
  ) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await this.store.recordProjectionError(materialId, version, message);
      this.failures.delete(`${materialId}:record`);
    } catch (recordError) {
      const tags = { materialId, stage: `${stage}_record_error` };
      if (this.recoveredPast(materialId, version))
        captureError(recordError, tags);
      else this.captureFailure(`${materialId}:record`, recordError, tags);
    }
    if (this.recoveredPast(materialId, version)) {
      captureError(error, { materialId, stage });
      return;
    }
    const latest = this.latestResults.get(materialId)?.version ?? 0;
    this.latestResults.set(materialId, {
      succeeded: false,
      version: Math.max(version, latest),
    });
    this.captureFailure(materialId, error, { materialId, stage });
  }

  private recoveredPast(materialId: string, version: number): boolean {
    const latest = this.latestResults.get(materialId);
    return !!latest?.succeeded && latest.version >= version;
  }

  private captureFailure(
    key: string,
    error: unknown,
    tags: Record<string, string>
  ) {
    if (!this.failures.has(key))
      this.failures.set(key, captureError(error, tags));
    withEventId(error, this.failures.get(key));
  }

  private runPendingRetry() {
    void this.retryPending().catch((error) => {
      this.captureFailure('pending_retry', error, {
        stage: 'projection_pending_retry',
      });
    });
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.runPendingRetry(), 5000);
    this.timer.unref();
    this.runPendingRetry();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async retryPending() {
    if (this.running) return;
    this.running = true;
    try {
      let pending: Awaited<ReturnType<YjsDocumentStore['pending']>>;
      try {
        pending = await this.store.pending();
        this.failures.delete('pending_query');
      } catch (error) {
        this.captureFailure('pending_query', error, {
          stage: 'projection_pending_query',
        });
        return;
      }
      for (const row of pending) {
        let content: ReturnType<YjsDocumentStore['contentFromState']>;
        try {
          content = this.store.contentFromState(row.state);
        } catch (error) {
          await this.recordFailure(
            row.materialId,
            row.version,
            error,
            'projection_pending_decode'
          );
          continue;
        }
        await this.projectAndRecord(
          row.materialId,
          row.version,
          content,
          'projection_pending_row'
        ).catch(() => {
          // projectAndRecord persisted and reported this row's failure. A
          // later row must still get its own attempt.
        });
      }
      this.failures.delete('pending_retry');
    } finally {
      this.running = false;
    }
  }
}
