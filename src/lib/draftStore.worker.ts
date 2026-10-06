import { type DraftMessage, handleDraftMessage } from './draftStore';

self.onmessage = (event: MessageEvent<DraftMessage>) =>
  handleDraftMessage(event.data, (answer) => self.postMessage(answer));
