import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

import {
  KnowledgeBaseEnterpriseIdentityError,
  KNOWLEDGE_BASE_AGENT_PROFILE,
  KNOWLEDGE_BASE_PREFILL_ATTACHMENT_FILENAME,
  KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME,
  buildKnowledgeBasePrompt,
  buildKnowledgeBasePrefillEvidenceArchive,
  buildKnowledgePrefillExcerpt,
  deriveKnowledgeBaseInteraction,
  getKnowledgeBaseSkillDescriptor,
  readKnowledgeBaseSkillArchiveAttachment,
  resolveKnowledgeBaseEnterpriseIdentity,
  selectUnreconciledKnowledgeOutput,
  shouldReconcileKnowledgeOutput,
  uploadKnowledgeBaseSkillArchive,
} from "./knowledge-base-api";

function expectEnterpriseIdentityError(
  action: () => unknown,
  code: KnowledgeBaseEnterpriseIdentityError["code"],
) {
  try {
    action();
    throw new Error("Expected KnowledgeBaseEnterpriseIdentityError");
  } catch (error) {
    expect(error).toBeInstanceOf(KnowledgeBaseEnterpriseIdentityError);
    expect((error as KnowledgeBaseEnterpriseIdentityError).code).toBe(code);
  }
}

describe("knowledge base execution contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps dashboard knowledge-base builds on the Pro model", () => {
    expect(KNOWLEDGE_BASE_AGENT_PROFILE).toBe("frontmind-pro");
  });

  it("keeps the Pro prompt compact while preserving depth and one-by-one traversal", async () => {
    const prompt = await buildKnowledgeBasePrompt({
      companyName: "验收企业",
      companyWebsite:
        "https://company.example.invalid/\nhttps://evidence.example.invalid/",
      operatorNotes: "覆盖全部产品线",
      attachments: [{ file_id: "file-1", filename: "catalog.pdf" }],
    });

    expect(prompt).toContain(
      "不得开启、调用、切换或推荐 Wide Research / Deep Research",
    );
    expect(prompt).toContain(KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME);
    expect(prompt).toContain("先解压 ZIP 并完整读取根目录 SKILL.md");
    expect(prompt).toContain("8-115");
    expect(prompt).toContain("不得为数量、字数或图片数填充内容");
    expect(prompt).toContain("一级分支数量不设固定值");
    expect(prompt).not.toContain("恰好 7 个一级分支");
    expect(prompt).not.toContain("7 universal top-level branches");
    expect(prompt).toContain("处理最后节点且本轮状态提交后将达到 100%");
    expect(prompt).toContain("每次被接受后加 1");
    expect(prompt).toContain("https://company.example.invalid/");
    expect(prompt).toContain("https://evidence.example.invalid/");
    expect(prompt).toContain("catalog.pdf");
    expect(prompt).toContain("FRONTMIND_KB_MANIFEST");
    expect(prompt).toContain("FRONTMIND_KB_PROGRESS");
    expect(prompt).toContain("FRONTMIND_KB_PRESENTATION");
    expect(prompt).toContain("FRONTMIND_KB_REOPEN");
    expect(prompt).toContain("补充、修订、问题或上传资料");
    expect(prompt).toContain("to 必须为 needs_verification");
    expect(prompt).toContain("(confirmed + direct_prefilled) / total");
    expect(prompt).toContain("不得输出参考资料、参考来源");
    expect(prompt).toContain("可见正文结束后直接附机器信封");
    expect(prompt).toContain("以 output_image 或 image MIME 的 output_file");
    expect(prompt).toContain("不得只写包内相对路径");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(10_000);
    expect(prompt).not.toContain("# Skill");
    expect(prompt).not.toContain("current Pro Agent");
    expect(prompt).not.toContain("# FILE: references/");
    expect(prompt).not.toContain("# FILE: scripts/validate_archive.py");
    expect(prompt).not.toContain("def validate_archive");
    expect(prompt).not.toContain("360–480");
    expect(prompt).not.toContain("300,000");

    const archive = await readKnowledgeBaseSkillArchiveAttachment();
    expect(archive.filename).toBe("socratic-kb-builder.skill.zip");
    expect(archive.bytes.subarray(0, 4).toString("hex")).toBe("504b0304");
    const zip = await JSZip.loadAsync(archive.bytes);
    const skill = await zip.file("SKILL.md")?.async("string");
    for (const invariant of [
      "current Pro Agent",
      "1,200 official HTML attempts",
      "1,800 visited links",
      "3,000,000",
      "limited_evidence",
      "evidenceDocumentIds",
      "schemaVersion: 3",
      "1,500 ZIP files",
      "160 MiB",
      "00_package_manifest.json",
      "dashboard-enterprise-v1",
      "FRONTMIND_FORMAL_CONTENT_START",
      "assetType",
      "displayRole",
      "scannedSourcePages",
      "1200×600",
      "800×450",
      "256×256",
      "Customer writing boundary",
      "Never create an interactive",
      "verification_gaps",
      "00_web_intelligence_report.md",
      "Per-node image delivery",
      "real response image/file",
    ]) {
      expect(skill).toContain(invariant);
    }
  });

  it("balances historical prefill across branches and caps it at 80,000 characters", () => {
    const documents = [
      {
        path: "01_identity/overview.md",
        title: "企业概览",
        content: "甲".repeat(30_000),
      },
      {
        path: "01_identity/history.md",
        title: "发展历程",
        content: "乙".repeat(30_000),
      },
      {
        path: "02_team/overview.md",
        title: "团队概览",
        content: "丙".repeat(30_000),
      },
      {
        path: "03_products/product-a.md",
        title: "产品 A",
        content: "丁".repeat(30_000),
      },
      {
        path: "04_capabilities/overview.md",
        title: "能力概览",
        content: "戊".repeat(30_000),
      },
      {
        path: "04_capabilities/lab.md",
        title: "实验室",
        content: "己".repeat(30_000),
      },
    ];

    const excerpt = buildKnowledgePrefillExcerpt(documents);
    expect(excerpt.length).toBeLessThanOrEqual(80_000);
    expect(excerpt).toContain("documentPath: 01_identity/overview.md");
    expect(excerpt).toContain("documentPath: 02_team/overview.md");
    expect(excerpt).toContain("documentPath: 03_products/product-a.md");
    expect(excerpt).toContain("documentPath: 04_capabilities/overview.md");
    expect(excerpt.indexOf("02_team/overview.md")).toBeLessThan(
      excerpt.indexOf("01_identity/history.md"),
    );
    expect(excerpt.indexOf("03_products/product-a.md")).toBeLessThan(
      excerpt.indexOf("04_capabilities/lab.md"),
    );
  });

  it("moves migrated knowledge prefill into a separate evidence ZIP", async () => {
    const snapshot = {
      version: 4,
      sourceFileName: "website-kb-v4.zip",
      archiveHash: "a".repeat(64),
      documentCount: 1,
      imageCount: 0,
      characterCount: 12,
      documents: [
        {
          path: "01_identity/profile.md",
          title: "企业简介",
          content: "只应存在于证据包内的企业事实。",
        },
      ],
    };
    const prompt = await buildKnowledgeBasePrompt({
      companyName: "验收企业",
      companyWebsite: "",
      operatorNotes: "",
      attachments: [],
      prefillKnowledgeSnapshot: snapshot,
    });
    expect(prompt).toContain(KNOWLEDGE_BASE_PREFILL_ATTACHMENT_FILENAME);
    expect(prompt).not.toContain("只应存在于证据包内的企业事实");

    const archive = await buildKnowledgeBasePrefillEvidenceArchive(snapshot);
    const zip = await JSZip.loadAsync(archive.bytes);
    expect(Object.keys(zip.files).sort()).toEqual([
      "MANIFEST.json",
      "context.json",
      "knowledge.md",
    ]);
    expect(await zip.file("knowledge.md")!.async("string")).toContain(
      "只应存在于证据包内的企业事实",
    );
  });

  it("pins new builds to v3 while preserving immutable prior archives", async () => {
    const active = await getKnowledgeBaseSkillDescriptor();
    const legacy = await getKnowledgeBaseSkillDescriptor({ version: "1" });
    const previous = await getKnowledgeBaseSkillDescriptor({ version: "2" });
    const priorV3Hash =
      "ee62269164a46a54b33dbf71ff492b1d08b3974ab314d11aaa97e885dff96f27";
    const priorV3 = await getKnowledgeBaseSkillDescriptor({
      version: "3",
      contentHash: priorV3Hash,
    });

    expect(active).toMatchObject({
      name: "socratic-kb-builder",
      version: "3",
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(legacy).toMatchObject({
      name: "socratic-kb-builder",
      version: "1",
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(previous).toMatchObject({
      name: "socratic-kb-builder",
      version: "2",
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(active.contentHash).not.toBe(legacy.contentHash);
    expect(active.contentHash).not.toBe(previous.contentHash);
    expect(active.contentHash).not.toBe(priorV3Hash);
    expect(priorV3.contentHash).toBe(priorV3Hash);

    await expect(
      getKnowledgeBaseSkillDescriptor({
        version: "1",
        contentHash: "0".repeat(64),
      }),
    ).rejects.toThrow("content hash does not match");
  });

  it("uploads the Skill ZIP through the exact signed URL without auth headers", async () => {
    const uploadUrl =
      "https://uploads.example.test/socratic.skill.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc";
    vi.spyOn(axios, "post").mockResolvedValue({
      status: 201,
      data: {
        id: "skill-file-1",
        filename: "socratic-kb-builder.skill.zip",
        upload_url: uploadUrl,
      },
    });
    const put = vi.spyOn(axios, "put").mockResolvedValue({
      status: 200,
      data: "",
    });

    const uploaded = await uploadKnowledgeBaseSkillArchive({
      baseUrl: "https://api.example.test",
      apiKey: "secret-test-key",
    });

    expect(uploaded.attachment).toEqual({
      file_id: "skill-file-1",
      filename: "socratic-kb-builder.skill.zip",
    });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[0]).toBe(uploadUrl);
    expect(put.mock.calls[0]?.[2]).toMatchObject({
      maxRedirects: 0,
      headers: {
        "Content-Type": "application/zip",
      },
    });
    expect(put.mock.calls[0]?.[2]?.headers).not.toHaveProperty("Authorization");
    expect(put.mock.calls[0]?.[2]?.headers).not.toHaveProperty("API_KEY");
  });

  it("uses the configured workspace enterprise and rejects client identity changes", () => {
    expect(
      resolveKnowledgeBaseEnterpriseIdentity({
        sourceName: "管理员结构化编辑",
        brandName: " 验收企业 ",
        requestedCompanyName: "验收企业",
      }),
    ).toBe("验收企业");

    expect(
      resolveKnowledgeBaseEnterpriseIdentity({
        sourceName: null,
        brandName: "验收企业",
        requestedCompanyName: "验收企业",
      }),
    ).toBe("验收企业");

    expectEnterpriseIdentityError(
      () =>
        resolveKnowledgeBaseEnterpriseIdentity({
          sourceName: "dashboard.json",
          brandName: "验收企业",
          requestedCompanyName: "另一家企业",
        }),
      "ENTERPRISE_IDENTITY_MISMATCH",
    );
  });

  it("allows a compatible client to omit the repeated company name", () => {
    expect(
      resolveKnowledgeBaseEnterpriseIdentity({
        sourceName: "dashboard.csv",
        brandName: "验收企业",
      }),
    ).toBe("验收企业");
  });

  it("selects unseen output, preserves non-cumulative turns, and replays terminal stable IDs", () => {
    const cumulative = [
      { id: "out-1", role: "assistant", content: "first" },
      { id: "out-2", role: "assistant", content: "second" },
    ];
    expect(
      selectUnreconciledKnowledgeOutput(cumulative, {
        lastOutputLength: 1,
        lastOutputItemIds: ["out-1"],
      }),
    ).toEqual([cumulative[1]]);

    const currentTurn = [
      { id: "out-9", role: "assistant", content: "current only" },
    ];
    expect(
      selectUnreconciledKnowledgeOutput(currentTurn, {
        lastOutputLength: 8,
        lastOutputItemIds: ["out-1", "out-8"],
      }),
    ).toEqual(currentTurn);

    expect(
      selectUnreconciledKnowledgeOutput(cumulative, {
        lastOutputLength: cumulative.length,
        lastOutputItemIds: ["out-1", "out-2"],
      }),
    ).toEqual([]);

    const replacedTerminalTurn = [
      {
        id: "out-2",
        role: "assistant",
        content: "same provider ID, replaced terminal content",
      },
    ];
    expect(
      selectUnreconciledKnowledgeOutput(
        replacedTerminalTurn,
        {
          lastOutputLength: 1,
          lastOutputItemIds: ["out-2"],
        },
        { replayStableOutput: true },
      ),
    ).toEqual(replacedTerminalTurn);
  });

  it("reconciles closed envelopes while ignoring partial waiting output", () => {
    const partial = [
      {
        id: "partial",
        role: "assistant",
        content: '<!-- FRONTMIND_KB_MANIFEST\n{"kind":',
      },
    ];
    const closedInvalid = [
      {
        id: "closed",
        role: "assistant",
        content: "<!-- FRONTMIND_KB_UNKNOWN\n{} \n-->",
      },
    ];

    expect(shouldReconcileKnowledgeOutput(partial, "awaiting_user")).toBe(
      false,
    );
    expect(shouldReconcileKnowledgeOutput(closedInvalid, "running")).toBe(true);
    expect(shouldReconcileKnowledgeOutput(partial, "completed")).toBe(true);
  });

  it("waits for both v3 transition and presentation envelopes", () => {
    const transitionOnly = [
      {
        id: "transition",
        role: "assistant",
        content:
          '<!-- FRONTMIND_KB_PROGRESS\n{"kind":"frontmind.knowledge-base.progress"}\n-->',
      },
    ];
    const complete = [
      {
        id: "complete",
        role: "assistant",
        content:
          transitionOnly[0].content +
          '\n<!-- FRONTMIND_KB_PRESENTATION\n{"kind":"frontmind.knowledge-base.presentation"}\n-->',
      },
    ];

    expect(
      shouldReconcileKnowledgeOutput(transitionOnly, "running", {
        requirePresentation: true,
      }),
    ).toBe(false);
    expect(
      shouldReconcileKnowledgeOutput(complete, "running", {
        requirePresentation: true,
      }),
    ).toBe(true);
    expect(
      shouldReconcileKnowledgeOutput(transitionOnly, "completed", {
        requirePresentation: true,
      }),
    ).toBe(true);
  });

  it("lets an authoritative confirming build override a still-running upstream task", () => {
    const progress = {
      build: {
        id: "build-1",
        conversationId: "conversation-1",
        companyName: "验收企业",
        status: "confirming",
        revision: 0,
        currentLeafId: "identity.name",
        protocolError: null,
        awaitingResponseSince: null,
        updatedAt: Date.now(),
      },
      summary: {
        total: 8,
        handled: 0,
        confirmed: 0,
        directPrefilled: 0,
        pending: 7,
        current: 1,
        needsVerification: 0,
        overallPercent: 0,
      },
      branches: [],
      packageAllowed: false,
    } as const;

    expect(deriveKnowledgeBaseInteraction(progress, "running")).toMatchObject({
      interactionState: "awaiting_input",
      canReply: true,
      canPublish: false,
    });
  });
});
