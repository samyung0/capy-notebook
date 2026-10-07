// The converter's question validators import the app's messages, which are
// generated and never shown here; each message returns its own key.
export const m = new Proxy({}, { get: (_, key) => () => String(key) });
