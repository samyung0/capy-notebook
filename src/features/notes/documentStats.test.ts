import { describe, expect, it } from "vitest";
import {
  contentSizeKilobytes,
  formatContentSize,
  shouldShowDocumentStats,
} from "./documentStats";
import { MATERIAL_DOCUMENT_LIMITS } from "@/lib/const";

const belowHalf = {
  maxDepth: MATERIAL_DOCUMENT_LIMITS.maxDepth / 2 - 1,
  nodeCount: MATERIAL_DOCUMENT_LIMITS.maxNodes / 2 - 1,
};

describe("document statistics visibility", () => {
  it("does not show solely because an unsaved size is unavailable", () => {
    expect(shouldShowDocumentStats(belowHalf, null)).toBe(false);
  });
});

describe("contentSizeKilobytes", () => {
  it("rounds saved bytes up to the displayed kilobyte", () => {
    expect(contentSizeKilobytes(0)).toBe(0);
    expect(contentSizeKilobytes(1024)).toBe(1);
    expect(contentSizeKilobytes(1025)).toBe(2);
  });

  it("formats an absent saved size without estimating it locally", () => {
    expect(formatContentSize(null)).toBe("—");
    expect(formatContentSize(1025)).toBe("2 KB");
  });
});
