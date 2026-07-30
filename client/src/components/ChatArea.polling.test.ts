import { describe, expect, it } from "vitest";
import {
  getReportPollDelay,
  KNOWLEDGE_BASE_FOUNDATION_COPY,
} from "./ChatArea";

describe("knowledge-base report polling cadence", () => {
  it("backs off to 30 seconds and remains valid for multi-hour research", () => {
    expect(getReportPollDelay(0)).toBe(3_000);
    expect(getReportPollDelay(5 * 60 * 1000)).toBe(10_000);
    expect(getReportPollDelay(30 * 60 * 1000)).toBe(30_000);
    expect(getReportPollDelay(6 * 60 * 60 * 1000)).toBe(30_000);
  });

  it("explains why the knowledge base must be built before the first task", () => {
    expect(KNOWLEDGE_BASE_FOUNDATION_COPY).toContain("AI 专用友好官网");
    expect(KNOWLEDGE_BASE_FOUNDATION_COPY).toContain("准确回答客户问题");
  });
});
