import { describe, expect, it } from "vitest";
import { KNOWLEDGE_BASE_FOUNDATION_COPY } from "./ChatArea";

describe("knowledge-base starter", () => {
  it("explains why the knowledge base must be built before the first task", () => {
    expect(KNOWLEDGE_BASE_FOUNDATION_COPY).toContain("AI 专用友好官网");
    expect(KNOWLEDGE_BASE_FOUNDATION_COPY).toContain("准确回答客户问题");
  });
});
