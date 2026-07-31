import { describe, expect, it } from "vitest";

import {
  analyzeKnowledgeBaseLiveTask,
  buildKnowledgeBaseProtocolProbePrompt,
  KNOWLEDGE_BASE_PROTOCOL_PROBE_LEAVES,
} from "./knowledge-base-live-preview-api";

function taskWithText(text: string, status = "completed") {
  return {
    id: "task-live-preview",
    status,
    output: [
      {
        id: "message-1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
  };
}

function manifest() {
  return {
    kind: "frontmind.knowledge-base.manifest",
    schemaVersion: 1,
    leaves: Array.from({ length: 8 }, (_, index) => ({
      id: `${index + 1}.1`,
      title: `节点 ${index + 1}`,
      branchId: `branch-${index + 1}`,
      branchTitle: `分支 ${index + 1}`,
    })),
  };
}

describe("analyzeKnowledgeBaseLiveTask", () => {
  it("renders bare protocol output without leaking machine JSON", () => {
    const analysis = analyzeKnowledgeBaseLiveTask(
      taskWithText(
        [
          "## 企业定位",
          "",
          "FrontMind 超前智能提供 AI 原生品牌增长服务。",
          "",
          JSON.stringify(manifest()),
          JSON.stringify({
            kind: "frontmind.workflow-state",
            currentLeafId: "1.1",
          }),
          JSON.stringify({
            kind: "frontmind.knowledge-base.presentation",
            schemaVersion: 1,
            leafId: "1.1",
            message: "请确认节点 1.1",
            assetIds: ["asset-1"],
          }),
          JSON.stringify({
            kind: "frontmind.knowledge-base.message",
            text: "internal",
          }),
        ].join("\n"),
      ),
    );

    expect(analysis.manifest).toMatchObject({
      leafCount: 8,
      branchCount: 8,
      firstLeaf: { id: "1.1", title: "节点 1" },
      lastLeaf: { id: "8.1", title: "节点 8" },
    });
    expect(analysis.visibleMarkdown).toBe(
      "## 企业定位\n\nFrontMind 超前智能提供 AI 原生品牌增长服务。",
    );
    expect(analysis.visibleMarkdown).not.toContain("frontmind.");
    expect(analysis.issues).toEqual([]);
    expect(
      analysis.diagnostics.find(
        (item) => item.kind === "frontmind.knowledge-base.presentation",
      ),
    ).toMatchObject({
      valid: false,
      authoritative: false,
    });
  });

  it("accepts the documented comment envelope", () => {
    const analysis = analyzeKnowledgeBaseLiveTask(
      taskWithText(
        [
          "节点正文",
          "<!-- FRONTMIND_KB_MANIFEST",
          JSON.stringify(manifest()),
          "-->",
        ].join("\n"),
      ),
    );

    expect(analysis.manifest?.leafCount).toBe(8);
    expect(analysis.visibleMarkdown).toBe("节点正文");
    expect(analysis.issues).toEqual([]);
  });

  it("does not report an incomplete manifest while a task is still running", () => {
    const analysis = analyzeKnowledgeBaseLiveTask(
      taskWithText("正在研究企业公开资料…", "running"),
    );

    expect(analysis.terminal).toBe(false);
    expect(analysis.manifest).toBeNull();
    expect(analysis.issues).toEqual([]);
  });

  it("reports duplicate canonical manifests after terminal completion", () => {
    const rawManifest = JSON.stringify(manifest());
    const analysis = analyzeKnowledgeBaseLiveTask(
      taskWithText(`节点正文\n${rawManifest}\n${rawManifest}`),
    );

    expect(analysis.manifest).toBeNull();
    expect(analysis.issues.join("\n")).toContain(
      "Model output must contain exactly one FRONTMIND_KB_MANIFEST envelope",
    );
  });

  it("reports a malformed documented manifest instead of treating it as absent", () => {
    const analysis = analyzeKnowledgeBaseLiveTask(
      taskWithText(
        '节点正文\n<!-- FRONTMIND_KB_MANIFEST\n{"kind":"frontmind.knowledge-base.manifest"\n-->',
      ),
    );

    expect(analysis.issues.join("\n")).toContain(
      "Manifest envelope contains invalid JSON",
    );
  });

  it("hides legacy Socratic state but rejects it as a manifest substitute", () => {
    const analysis = analyzeKnowledgeBaseLiveTask(
      taskWithText(
        [
          "## 知识树统计",
          "",
          "9 个分支，52 个叶子。",
          "",
          "<!--SOCRATIC_KB_STATE",
          '{"revision":0,"knowledgeTree":{"branches":9,"leaves":52}}',
          "SOCRATIC_KB_STATE-->",
        ].join("\n"),
      ),
    );

    expect(analysis.legacySocraticStateCount).toBe(1);
    expect(analysis.visibleMarkdown).toBe(
      "## 知识树统计\n\n9 个分支，52 个叶子。",
    );
    expect(analysis.issues).toContain("任务已结束，但没有找到知识树 manifest");
    expect(analysis.issues).toContain(
      "返回了已禁用的旧 SOCRATIC_KB_STATE 状态对象",
    );
  });

  it("builds a no-research prompt and accepts the exact protocol probe manifest", () => {
    const prompt = buildKnowledgeBaseProtocolProbePrompt();
    const probeManifest = {
      kind: "frontmind.knowledge-base.manifest",
      schemaVersion: 1,
      leaves: KNOWLEDGE_BASE_PROTOCOL_PROBE_LEAVES,
    };
    const analysis = analyzeKnowledgeBaseLiveTask(
      taskWithText(
        [
          "协议探针响应",
          "<!-- FRONTMIND_KB_MANIFEST",
          JSON.stringify(probeManifest),
          "-->",
        ].join("\n"),
      ),
      { mode: "protocol_probe" },
    );

    expect(prompt).toContain("FRONTMIND_KB_PROTOCOL_PROBE_V1");
    expect(prompt).toContain("禁止联网、搜索、浏览、调用工具");
    expect(prompt).toContain("8.1|合作与支持|cooperation|合作与支持");
    expect(analysis.runMode).toBe("protocol_probe");
    expect(analysis.manifest?.leaves).toEqual(
      KNOWLEDGE_BASE_PROTOCOL_PROBE_LEAVES,
    );
    expect(analysis.visibleMarkdown).toBe("协议探针响应");
    expect(analysis.issues).toEqual([]);
  });

  it("rejects a structurally valid probe manifest when its leaves differ", () => {
    const wrongManifest = manifest();
    wrongManifest.leaves[0]!.title = "错误标题";
    const analysis = analyzeKnowledgeBaseLiveTask(
      taskWithText(
        [
          "协议探针响应",
          "<!-- FRONTMIND_KB_MANIFEST",
          JSON.stringify(wrongManifest),
          "-->",
        ].join("\n"),
      ),
      { mode: "protocol_probe" },
    );

    expect(analysis.issues).toContain(
      "协议探针 manifest 与预期的 8 个叶子不完全一致",
    );
  });
});
