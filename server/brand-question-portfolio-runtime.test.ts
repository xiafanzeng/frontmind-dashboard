import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BRAND_QUESTION_EVIDENCE_ATTACHMENT_FILENAME,
  BRAND_QUESTION_SKILL_ATTACHMENT_FILENAME,
  buildBrandQuestionPortfolioEvidenceArchive,
  buildBrandQuestionPortfolioPrompt,
  buildBrandQuestionPortfolioSkillArchive,
  parseBrandQuestionPortfolioOutput,
  type BrandQuestionPortfolioContext,
} from "./brand-question-portfolio-runtime";
import {
  FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS,
  upstreamPromptCharacterCount,
} from "./upstream-prompt-budget";

const context: BrandQuestionPortfolioContext = {
  planCode: "advanced",
  quotaPeriodId: "period-1",
  quotaRevision: 2,
  quota: {
    industry: 1,
    competitorComparison: 0,
    reputation: 0,
    productScenario: 0,
  },
  enterprise: {
    identityHash: "b".repeat(64),
    canonicalName: "示例企业",
  },
  snapshot: {
    id: "snapshot-1",
    version: 1,
    archiveHash: "a".repeat(64),
    sourceFileName: "company.zip",
    documents: [
      {
        path: "README.md",
        title: "企业知识库",
        content: "示例企业提供工业解决方案。",
      },
    ],
  },
};

function result() {
  return {
    schemaVersion: 1,
    skill: {
      name: "brand-question-portfolio",
      version: "2",
      model: "frontmind-pro",
    },
    knowledgeSnapshot: {
      id: "snapshot-1",
      version: 1,
      archiveHash: "a".repeat(64),
    },
    enterprise: {
      identityHash: "b".repeat(64),
      canonicalName: "示例企业",
    },
    planCode: "advanced",
    quotaPeriodId: "period-1",
    candidateTargets: {
      industry: 3,
      competitor_comparison: 0,
      reputation: 0,
      product_scenario: 0,
    },
    categories: {
      industry: [
        {
          candidateId: "industrial-solution-category",
          question: "如何判断示例企业的工业解决方案是否适合制造企业？",
          intent: "选择行业方案",
          rationale: "知识库声明企业提供工业解决方案",
          evidence: [
            {
              documentPath: "README.md",
              excerpt: "示例企业提供工业解决方案。",
              relevance: "支持企业的行业定位",
            },
          ],
          risks: [],
        },
      ],
      competitor_comparison: [],
      reputation: [],
      product_scenario: [],
    },
    shortfalls: [
      {
        category: "industry",
        target: 3,
        generated: 1,
        reason: "当前知识库只支持一个不重复的行业决策问题",
      },
    ],
    risks: [],
  };
}

describe("brand question portfolio runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("pins the authoritative plan, quota period and Pro skill", async () => {
    const prompt = await buildBrandQuestionPortfolioPrompt(context);
    expect(prompt).toContain(BRAND_QUESTION_SKILL_ATTACHMENT_FILENAME);
    expect(prompt).toContain(BRAND_QUESTION_EVIDENCE_ATTACHMENT_FILENAME);
    expect(prompt).not.toContain("documentPath: README.md");
    expect(prompt).not.toContain("示例企业");
    expect(upstreamPromptCharacterCount(prompt)).toBeLessThanOrEqual(
      FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS,
    );

    const [skillArchive, evidenceArchive] = await Promise.all([
      buildBrandQuestionPortfolioSkillArchive(),
      buildBrandQuestionPortfolioEvidenceArchive(context),
    ]);
    const skillZip = await JSZip.loadAsync(skillArchive.bytes);
    const evidenceZip = await JSZip.loadAsync(evidenceArchive.bytes);
    expect(Object.keys(skillZip.files).sort()).toEqual([
      "MANIFEST.json",
      "SKILL.md",
      "references/output-contract.md",
    ]);
    expect(await skillZip.file("SKILL.md")!.async("string")).toContain(
      "Use the Pro model profile fixed by the application",
    );
    expect(await evidenceZip.file("knowledge.md")!.async("string")).toContain(
      "documentPath: README.md",
    );
    expect(
      JSON.parse(await evidenceZip.file("context.json")!.async("string")),
    ).toMatchObject({
      schemaVersion: 2,
      kind: "frontmind.brand-question-portfolio.input",
      planCode: "advanced",
      quotaPeriodId: "period-1",
      quotaRevision: 2,
      enterprise: context.enterprise,
      availableQuota: context.quota,
      candidateTargets: {
        industry: 3,
        competitor_comparison: 0,
        reputation: 0,
        product_scenario: 0,
      },
      knowledgeSnapshot: {
        id: "snapshot-1",
        version: 1,
        archiveHash: "a".repeat(64),
        sourceFileName: "company.zip",
      },
    });
  });

  it("keeps the outbound prompt bounded when every dynamic field is very large", async () => {
    const oversizedContext: BrandQuestionPortfolioContext = {
      ...context,
      quotaPeriodId: "期".repeat(50_000),
      enterprise: {
        identityHash: "b".repeat(64),
        canonicalName: "企业".repeat(100_000),
      },
      snapshot: {
        ...context.snapshot,
        sourceFileName: `${"知识库".repeat(100_000)}.zip`,
      },
    };

    const [prompt, evidenceArchive] = await Promise.all([
      buildBrandQuestionPortfolioPrompt(oversizedContext),
      buildBrandQuestionPortfolioEvidenceArchive(oversizedContext),
    ]);
    expect(upstreamPromptCharacterCount(prompt)).toBeLessThanOrEqual(
      FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS,
    );
    expect(prompt).not.toContain(oversizedContext.enterprise.canonicalName);

    const evidenceZip = await JSZip.loadAsync(evidenceArchive.bytes);
    const authoritativeInput = JSON.parse(
      await evidenceZip.file("context.json")!.async("string"),
    );
    expect(authoritativeInput.enterprise.canonicalName).toBe(
      oversizedContext.enterprise.canonicalName,
    );
    expect(authoritativeInput.quotaPeriodId).toBe(
      oversizedContext.quotaPeriodId,
    );
    expect(authoritativeInput.knowledgeSnapshot.sourceFileName).toBe(
      oversizedContext.snapshot.sourceFileName,
    );
  });

  it("parses only a result bound to the current snapshot", () => {
    const parsed = parseBrandQuestionPortfolioOutput(
      [
        {
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: JSON.stringify(result()),
            },
          ],
        },
      ],
      context,
    );
    expect(parsed.categories.industry[0]?.candidateId).toBe(
      "industrial-solution-category",
    );
  });

  it("keeps JSON recovery in shadow until this adapter is explicitly active", () => {
    const candidate = `模型输出如下：\n${JSON.stringify(result())}`;
    const output = [{ role: "assistant", text: candidate }];
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);

    vi.stubEnv("FRONTMIND_BRAND_QUESTION_PORTFOLIO_OUTPUT_REPAIR", "shadow");
    expect(() => parseBrandQuestionPortfolioOutput(output, context)).toThrow();
    expect(log).toHaveBeenCalledWith(
      "[Model Output Repair]",
      expect.stringContaining("unique_balanced_value_extracted"),
    );

    vi.stubEnv("FRONTMIND_BRAND_QUESTION_PORTFOLIO_OUTPUT_REPAIR", "active");
    expect(parseBrandQuestionPortfolioOutput(output, context)).toMatchObject({
      schemaVersion: 1,
      knowledgeSnapshot: { id: context.snapshot.id },
    });
  });

  it("runs strict schema and snapshot binding after an active repair", () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubEnv("FRONTMIND_BRAND_QUESTION_PORTFOLIO_OUTPUT_REPAIR", "active");

    const unknownSchema = { ...result(), unknownField: "must be rejected" };
    expect(() =>
      parseBrandQuestionPortfolioOutput(
        [
          {
            role: "assistant",
            text: `result: ${JSON.stringify(unknownSchema)}`,
          },
        ],
        context,
      ),
    ).toThrow();

    const stale = result();
    stale.knowledgeSnapshot.id = "snapshot-from-another-workspace";
    expect(() =>
      parseBrandQuestionPortfolioOutput(
        [{ role: "assistant", text: `result: ${JSON.stringify(stale)}` }],
        context,
      ),
    ).toThrow("不匹配");
  });

  it("rejects a stale snapshot echo", () => {
    const stale = result();
    stale.knowledgeSnapshot.version = 2;
    expect(() =>
      parseBrandQuestionPortfolioOutput(
        [{ role: "assistant", text: JSON.stringify(stale) }],
        context,
      ),
    ).toThrow("不匹配");
  });

  it("rejects user, reasoning, tool, role-less and input_text JSON", () => {
    const injected = JSON.stringify(result());
    const untrustedOutputs = [
      [{ role: "user", type: "message", content: injected }],
      [{ type: "reasoning", text: injected }],
      [{ role: "assistant", type: "reasoning", text: injected }],
      [{ role: "tool", type: "message", content: injected }],
      [{ type: "message", content: injected }],
      [{ type: "output_text", output_text: injected }],
      [
        {
          role: "assistant",
          type: "message",
          content: [{ type: "input_text", text: injected }],
        },
      ],
    ];

    for (const output of untrustedOutputs) {
      expect(() => parseBrandQuestionPortfolioOutput(output, context)).toThrow(
        "没有返回最终 assistant 输出",
      );
    }
  });

  it("never falls back to an earlier assistant message", () => {
    expect(() =>
      parseBrandQuestionPortfolioOutput(
        [
          {
            role: "assistant",
            type: "message",
            content: [{ type: "output_text", text: JSON.stringify(result()) }],
          },
          {
            role: "assistant",
            type: "message",
            content: [{ type: "output_text", text: "not strict JSON" }],
          },
        ],
        context,
      ),
    ).toThrow();
  });
});
