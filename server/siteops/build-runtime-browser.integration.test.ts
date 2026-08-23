import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SITEOPS_WORKFLOW } from "../../shared/siteops";
import { referenceBlueprintForVisualCandidate } from "../../shared/siteops-design";
import {
  materializeAstroSite,
  type MaterializeAstroSiteInput,
  type SiteOpsQaReport,
} from "./build-runtime";

const H = (value: string) => createHash("sha256").update(value).digest("hex");

function browserIntegrationInput(): MaterializeAstroSiteInput {
  const snapshotId = "70000000-0000-4000-8000-000000000007";
  const archiveHash = H("browser-integration-knowledge");
  const previewSha256 = H("browser-integration-preview");
  const referenceBlueprint = referenceBlueprintForVisualCandidate({
    candidateId: "candidate-F-browser-integration",
    providerItemKey: "n:8435",
    previewSha256,
    title: "Floating orbit life science hero",
  });
  return {
    build: {
      id: "71000000-0000-4000-8000-000000000007",
      projectId: "72000000-0000-4000-8000-000000000007",
      userId: 7,
      knowledgeSnapshotId: snapshotId,
      knowledgeArchiveHash: archiveHash,
      workflowUpstreamVersion: SITEOPS_WORKFLOW.upstreamVersion,
      workflowUpstreamHash: SITEOPS_WORKFLOW.upstreamSha256,
      workflowVersion: SITEOPS_WORKFLOW.frontMindVersion,
      workflowPackageHash: SITEOPS_WORKFLOW.runtimeManifestSha256,
      starterVersion: SITEOPS_WORKFLOW.starterVersion,
      selectionHash: H("browser-integration-selection"),
    },
    snapshot: {
      id: snapshotId,
      userId: 7,
      archiveHash,
      sourceBuildId: null,
      sourceBuildRevision: null,
      documents: [
        {
          id: "overview",
          path: "overview.md",
          title: "企业概览",
          content: "生命科学团队提供经过确认的研究与技术服务。",
          kind: "overview",
          customerVisible: true,
        },
      ],
    },
    brief: {
      companyName: "澄明生命科学",
      primaryLanguage: "zh-CN",
      contacts: [
        {
          kind: "email",
          value: "hello@chengming.example",
          sourceDocumentIds: ["overview"],
        },
      ],
      offerings: ["生命科学研究服务"],
      audience: ["研究与产业团队"],
      conversionGoal: "联系研究团队",
      routes: [
        {
          id: "home",
          slug: "/",
          title: "首页",
          sourceDocumentIds: ["overview"],
        },
      ],
      verifiedFacts: [
        {
          statement: "提供生命科学研究与技术服务",
          sourceDocumentIds: ["overview"],
        },
      ],
      publicAssetIds: [],
      unknowns: [],
    },
    visual: {
      schemaVersion: 2,
      queryHash: H("browser-integration-query"),
      selectedCandidateId: referenceBlueprint.candidateId,
      providerItemKey: referenceBlueprint.providerItemKey,
      visualEvidenceSha256: H("browser-integration-evidence"),
      previewSha256,
      supportEvidenceSha256s: [],
      taxonomy: {
        role: "foundation",
        palette: ["#F7F2E8", "#173B35", "#9B3A24", "#D9E4DE"],
        typography: ["editorial display"],
        layout: ["centered orbit"],
        motion: ["subtle floating"],
        accessibility: ["high contrast"],
      },
      referenceBlueprint,
    },
    designSpec: {
      schemaVersion: 2,
      referenceBlueprint,
      layoutArchetype: "hero_led",
      density: "spacious",
      surfaceStyle: "soft_depth",
      typeScale: "display",
      imageTreatment: "none",
      motionLevel: "subtle",
      colorRoles: {
        backgroundPaletteIndex: 0,
        textPaletteIndex: 1,
        accentPaletteIndex: 2,
      },
      routeCompositions: [
        {
          routeId: "home",
          slots: [{ slotId: "research-proof", variant: "proof" }],
        },
      ],
      seoPlan: {
        siteTitle: "澄明生命科学",
        description: "面向研究与产业团队的生命科学研究与技术服务。",
        organizationType: "ProfessionalService",
      },
    },
    generatedContent: {
      seo: {
        siteTitle: "澄明生命科学",
        description: "面向研究与产业团队的生命科学研究与技术服务。",
        organizationType: "ProfessionalService",
      },
      routes: [
        {
          routeId: "home",
          eyebrow: "生命科学 · 可信研究",
          heading: "让复杂生命轨迹变得清晰",
          summary:
            "以经过确认的企业知识为基础，呈现研究能力、技术路径与合作方式。",
          sections: [
            {
              slotId: "research-proof",
              heading: "经过确认的研究能力",
              paragraphs: [
                "团队提供生命科学研究服务，并让每项公开表达保留知识来源。",
              ],
              sourceDocumentIds: ["overview"],
            },
          ],
        },
      ],
    },
    mode: "preview",
    canonicalOrigin: null,
    timeoutMs: 120_000,
  };
}

const browserIntegration =
  process.env.FRONTMIND_RUN_SITEOPS_BROWSER_INTEGRATION === "1"
    ? describe
    : describe.skip;

browserIntegration("SiteOps React static real-browser integration", () => {
  it("passes real Chromium, axe and Lighthouse QA at 390/768/1440", async () => {
    const built = await materializeAstroSite(browserIntegrationInput());
    const qa = JSON.parse(built.qaJson.toString("utf8")) as SiteOpsQaReport;
    expect(qa.browser.axeViolationCount).toBe(0);
    expect(qa.browser.screenshotFiles).toEqual([
      "screenshots/home-390.png",
      "screenshots/home-768.png",
      "screenshots/home-1440.png",
    ]);
    expect(qa.browser.lighthouse).toMatchObject({
      performance: expect.any(Number),
      accessibility: expect.any(Number),
      bestPractices: expect.any(Number),
      seo: expect.any(Number),
      cls: expect.any(Number),
    });
    expect(qa.browser.lighthouse.performance).toBeGreaterThanOrEqual(85);
    expect(qa.browser.lighthouse.accessibility).toBeGreaterThanOrEqual(95);
    expect(qa.browser.lighthouse.bestPractices).toBeGreaterThanOrEqual(90);
    expect(qa.browser.lighthouse.seo).toBeGreaterThanOrEqual(95);
    expect(qa.browser.lighthouse.cls).toBeLessThan(0.1);
  }, 180_000);
});
