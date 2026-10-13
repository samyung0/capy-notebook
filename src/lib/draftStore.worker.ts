import { type DraftMessage, handleDraftMessage } from './draftStore';

// A merged update moves to the page instead of being copied.
self.onmessage = (event: MessageEvent<DraftMessage>) =>
  handleDraftMessage(event.data, (answer) =>
    self.postMessage(
      answer,
      'result' in answer && answer.result instanceof Uint8Array
        ? [answer.result.buffer]
        : []
    )
  );
