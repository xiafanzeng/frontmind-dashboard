import { describe, expect, it } from "vitest";
import type { OutputMessage } from "@/lib/frontmind-api";
import {
  outputForKnowledgePresentation,
  projectTaskOutputMessages,
} from "./task-output-projection";

function assistantOutput(id: string, text: string): OutputMessage {
  return {
    id,
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
}

describe("task output projection", () => {
  it("uses the latest same-ID replacement when the output length is unchanged", () => {
    const latest = assistantOutput(
      "reused-output",
      [
        "Manus 正在采集更新后的资料。",
        "![外部图片](https://cdn.example.com/image.png)",
        "## References",
        "- https://example.com/source",
      ].join("\n\n"),
    );

    const messages = projectTaskOutputMessages({
      output: [latest],
      baselineOutputLength: 1,
      historicalOutputIds: ["reused-output"],
      responseStartedAt: 1,
      modelName: "frontmind-pro",
      knowledgeBase: true,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("FrontMind 正在采集更新后的资料");
    expect(messages[0]?.content).not.toContain("Manus");
    expect(messages[0]?.content).not.toContain("References");
    expect(messages[0]?.content).not.toContain("cdn.example.com");
  });

  it("selects the latest assistant item and its following resources", () => {
    const old = assistantOutput("reused-output", "旧回复");
    const current = assistantOutput("reused-output", "新回复");
    const image: OutputMessage = {
      id: "leaf-image",
      type: "output_image",
      image_url: "/api/knowledge-base/assets/leaf-image",
    };

    expect(
      outputForKnowledgePresentation([old, current, image], []),
    ).toEqual([current, image]);
  });

  it("keeps the newest content when a cumulative response repeats an ID", () => {
    const old = assistantOutput("reused-output", "旧回复");
    const current = assistantOutput("reused-output", "新回复");

    const messages = projectTaskOutputMessages({
      output: [old, current],
      baselineOutputLength: 0,
      responseStartedAt: 1,
      knowledgeBase: true,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("新回复");
  });

  it("removes tools and incomplete machine envelopes from running knowledge output", () => {
    const output: OutputMessage[] = [
      {
        id: "search-call",
        type: "web_search_call",
        status: "completed",
      },
      assistantOutput(
        "running-copy",
        [
          "已完成第一轮资料采集。",
          "<!-- FRONTMIND_KB_PROGRESS {\"revision\":1",
        ].join("\n"),
      ),
    ];

    const messages = projectTaskOutputMessages({
      output,
      baselineOutputLength: 0,
      responseStartedAt: 1,
      knowledgeBase: true,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("已完成第一轮资料采集。");
    expect(messages[0]?.intermediateSteps).toBeUndefined();
    expect(messages[0]?.content).not.toContain("FRONTMIND_KB_PROGRESS");
  });
});
