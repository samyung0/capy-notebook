import { convert } from "./export-probe-core";
self.onmessage = async ({ data }) => {
  try {
    self.postMessage({ id: data.id, ...(await convert(data.input)) });
  } catch (error) {
    self.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
